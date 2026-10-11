import * as time from "./clock.js";
import type {
  ProjectQueueAction,
  ProjectQueueBinding,
  ProjectQueueIntent,
  ProjectQueueSnapshot,
  ProjectQueueWriteReceipt,
  ProjectQueueWriteRequest,
} from "./contracts.js";
import { GitHubProjectQueueGraphqlError } from "./github-client.js";
import type { ProjectGraphQL } from "./github-project.js";

import {
  ADD,
  UPDATE,
  BINDING,
  ITEMS,
  FIELDS,
  ISSUE,
} from "./github-project-queue-wire.js";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Project queue observation is unavailable");
  return value as ObjectValue;
};
const only = (value: ObjectValue, keys: string[]): void => {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error("Unsupported Project queue receipt field");
};
const nodeId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value);
const timestamp = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const positiveInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;
const orderValue = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const same = (left: unknown, right: unknown): boolean => {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, stable(child)]),
      );
    return value;
  };
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
};

export function assertProjectQueueBinding(
  value: unknown,
  repository?: string,
): asserts value is ProjectQueueBinding {
  const binding = object(value);
  only(binding, [
    "repository",
    "projectId",
    "metadataFieldId",
    "orderFieldId",
    "controlItemId",
    "factoryManagedFields",
  ]);
  if (
    typeof binding.repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(binding.repository) ||
    (repository !== undefined && binding.repository !== repository) ||
    binding.factoryManagedFields !== true ||
    !nodeId(binding.projectId) ||
    !nodeId(binding.metadataFieldId) ||
    !nodeId(binding.orderFieldId) ||
    !nodeId(binding.controlItemId) ||
    binding.metadataFieldId === binding.orderFieldId
  )
    throw new Error(
      "Project queue requires an exact target and dedicated field consent",
    );
}

type IntentBase = ProjectQueueAction &
  Omit<ProjectQueueIntent, "action" | "request">;

function mutationRequest(intent: IntentBase) {
  const input =
    intent.action === "ensure-card"
      ? {
          clientMutationId: intent.requestId,
          projectId: intent.binding.projectId,
          contentId: intent.issueNodeId,
        }
      : {
          clientMutationId: intent.requestId,
          projectId: intent.binding.projectId,
          itemId: intent.itemId,
          fieldId: intent.fieldId,
          value:
            intent.action === "set-order"
              ? { number: intent.order }
              : { text: intent.metadata },
        };
  return {
    query: intent.action === "ensure-card" ? ADD : UPDATE,
    variables: { input },
  };
}

/** Same decoder used at transport return and when authenticating archived originals. */
export function assertProjectQueueIntent(
  value: unknown,
  binding?: ProjectQueueBinding,
): asserts value is ProjectQueueIntent {
  const intent = object(value);
  const action = intent.action;
  only(intent, [
    "binding",
    "requestId",
    "actorId",
    "observedAt",
    "action",
    "fieldId",
    "request",
    ...(action === "ensure-card"
      ? ["issueNodeId"]
      : action === "set-order"
        ? ["itemId", "order"]
        : action === "set-metadata"
          ? ["itemId", "metadata"]
          : []),
  ]);
  assertProjectQueueBinding(intent.binding);
  if (
    (binding && !same(intent.binding, binding)) ||
    typeof intent.requestId !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      intent.requestId,
    ) ||
    !positiveInteger(intent.actorId) ||
    !timestamp(intent.observedAt)
  )
    throw new Error("Invalid Project queue intent identity");
  if (action === "ensure-card") {
    if (!nodeId(intent.issueNodeId) || intent.fieldId !== undefined)
      throw new Error("Invalid Project queue Issue admission target");
  } else if (action === "set-order") {
    if (
      !nodeId(intent.itemId) ||
      intent.itemId === intent.binding.controlItemId ||
      !positiveInteger(intent.order) ||
      intent.fieldId !== intent.binding.orderFieldId
    )
      throw new Error("Invalid Project queue order target");
  } else if (action === "set-metadata") {
    if (
      !nodeId(intent.itemId) ||
      typeof intent.metadata !== "string" ||
      intent.fieldId !== intent.binding.metadataFieldId
    )
      throw new Error("Invalid Project queue metadata target");
  } else throw new Error("Unsupported Project queue action");
  const typed = value as ProjectQueueIntent;
  if (!same(typed.request, mutationRequest(typed)))
    throw new Error(
      "Project queue intent does not retain its exact fixed request",
    );
}

function cardIdentity(
  value: unknown,
  binding: ProjectQueueBinding,
): ObjectValue {
  const card = object(value);
  if (
    !nodeId(card.id) ||
    typeof card.isArchived !== "boolean" ||
    object(card.project).id !== binding.projectId
  )
    throw new Error("Project queue card identity is unavailable");
  const content = object(card.content);
  if (
    !["Issue", "DraftIssue", "PullRequest"].includes(
      String(content.__typename),
    ) ||
    !nodeId(content.id)
  )
    throw new Error("Project queue card content is unavailable or redacted");
  if (
    content.__typename !== "DraftIssue" &&
    typeof object(content.repository).nameWithOwner !== "string"
  )
    throw new Error("Project queue card repository is unavailable");
  if (content.__typename === "Issue" && !positiveInteger(content.number))
    throw new Error("Project queue Issue identity is unavailable");
  return card;
}

function targetCard(value: unknown, intent: ProjectQueueIntent): ObjectValue {
  const card = cardIdentity(value, intent.binding);
  const content = object(card.content);
  if (
    card.isArchived ||
    (intent.action === "ensure-card"
      ? card.id === intent.binding.controlItemId ||
        content.__typename !== "Issue" ||
        content.id !== intent.issueNodeId ||
        object(content.repository).nameWithOwner !== intent.binding.repository
      : card.id !== intent.itemId ||
        (card.id === intent.binding.controlItemId
          ? !["Issue", "DraftIssue"].includes(String(content.__typename))
          : content.__typename !== "Issue" ||
            object(content.repository).nameWithOwner !==
              intent.binding.repository))
  )
    throw new Error("Project queue response changed its admitted target");
  return card;
}

function connection(value: unknown) {
  const page = object(value);
  const info = object(page.pageInfo);
  if (
    !Array.isArray(page.nodes) ||
    typeof info.hasNextPage !== "boolean" ||
    !(info.endCursor === null || typeof info.endCursor === "string") ||
    (info.hasNextPage && (!info.endCursor || page.nodes.length === 0))
  )
    throw new Error("Project queue pagination is unavailable or truncated");
  return {
    nodes: page.nodes,
    hasNextPage: info.hasNextPage,
    endCursor: info.endCursor as string | null,
  };
}

function fieldValues(values: unknown[], binding: ProjectQueueBinding) {
  let metadata: string | null = null;
  let order: number | null = null;
  const seen = new Set<string>();
  for (const raw of values) {
    const value = object(raw);
    if (typeof value.__typename !== "string")
      throw new Error("Project queue field value is unavailable");
    // Issue-derived fields do not implement FieldValueCommon; they carry no queue authority.
    if (value.field === undefined) {
      if (
        ![
          "ProjectV2ItemFieldUserValue",
          "ProjectV2ItemFieldLabelValue",
          "ProjectV2ItemFieldMilestoneValue",
          "ProjectV2ItemFieldPullRequestValue",
          "ProjectV2ItemFieldRepositoryValue",
          "ProjectV2ItemFieldReviewerValue",
        ].includes(value.__typename)
      )
        throw new Error("Project queue field identity is unavailable");
      continue;
    }
    const id = object(value.field).id;
    if (!nodeId(id) || seen.has(id))
      throw new Error(
        "Project queue has unavailable or duplicate field values",
      );
    seen.add(id);
    if (id === binding.metadataFieldId) {
      if (
        value.__typename !== "ProjectV2ItemFieldTextValue" ||
        typeof value.text !== "string"
      )
        throw new Error(
          "Project queue metadata is unavailable or has the wrong type",
        );
      metadata = value.text;
    } else if (id === binding.orderFieldId) {
      if (
        value.__typename !== "ProjectV2ItemFieldNumberValue" ||
        !orderValue(value.number)
      )
        throw new Error(
          "Project queue order is unavailable or has the wrong type",
        );
      order = value.number;
    }
  }
  return { metadata, order };
}

export function assertProjectQueueWriteReceipt(
  value: unknown,
): asserts value is ProjectQueueWriteReceipt {
  const receipt = object(value);
  only(receipt, ["intent", "itemId", "observedAt", "kind", "original"]);
  assertProjectQueueIntent(receipt.intent);
  if (!nodeId(receipt.itemId) || !timestamp(receipt.observedAt))
    throw new Error("Invalid Project queue response identity");
  const intent = receipt.intent;
  if (receipt.kind === "existing-read") {
    if (
      intent.action !== "ensure-card" ||
      targetCard(receipt.original, intent).id !== receipt.itemId
    )
      throw new Error("Invalid existing Project queue card read");
    return;
  }
  if (receipt.kind !== "response")
    throw new Error("Project queue mutation lacks an original response");
  const original = object(receipt.original);
  const key =
    intent.action === "ensure-card"
      ? "addProjectV2ItemById"
      : "updateProjectV2ItemFieldValue";
  only(original, [key]);
  const response = object(original[key]);
  if (response.clientMutationId !== intent.requestId)
    throw new Error(
      "Project queue mutation response has another request identity",
    );
  const card = targetCard(
    response[intent.action === "ensure-card" ? "item" : "projectV2Item"],
    intent,
  );
  if (card.id !== receipt.itemId)
    throw new Error("Project queue response has another card identity");
  if (intent.action !== "ensure-card") {
    const page = connection(card.fieldValues);
    if (page.hasNextPage)
      throw new Error("Project queue mutation response is truncated");
    const fields = fieldValues(page.nodes, intent.binding);
    if (
      intent.action === "set-order"
        ? fields.order !== intent.order
        : fields.metadata !== intent.metadata
    )
      throw new Error(
        "Project queue original response does not contain the requested value",
      );
  }
}

/** Keeps an unreadable original response private for the owner's exact receipt journal. */
export class ProjectQueueResponseError extends Error {
  constructor(
    readonly intent: ProjectQueueIntent,
    readonly original: unknown,
    cause: unknown,
  ) {
    super("Project queue mutation returned an unverified original response", {
      cause,
    });
    this.name = "ProjectQueueResponseError";
  }
}

async function readBinding(
  repository: string,
  binding: ProjectQueueBinding,
  graphql: ProjectGraphQL,
) {
  assertProjectQueueBinding(binding, repository);
  const data = object(
    await graphql(
      BINDING,
      {
        project: binding.projectId,
        metadata: binding.metadataFieldId,
        order: binding.orderFieldId,
      },
      true,
    ),
  );
  const project = object(data.project);
  const owner = object(project.owner);
  const actorId = object(data.viewer).databaseId;
  if (
    project.__typename !== "ProjectV2" ||
    project.id !== binding.projectId ||
    project.closed !== false ||
    project.viewerCanUpdate !== true ||
    !["Organization", "User"].includes(String(owner.__typename)) ||
    typeof owner.login !== "string" ||
    owner.login.toLowerCase() !== repository.split("/")[0]?.toLowerCase() ||
    !positiveInteger(actorId)
  )
    throw new Error("Project queue owner, open state or access is unavailable");
  for (const [key, id, type] of [
    ["metadata", binding.metadataFieldId, "TEXT"],
    ["order", binding.orderFieldId, "NUMBER"],
  ] as const) {
    const field = object(data[key]);
    if (
      field.__typename !== "ProjectV2Field" ||
      field.id !== id ||
      field.dataType !== type ||
      object(field.project).id !== binding.projectId
    )
      throw new Error(
        "Project queue requires its exact dedicated TEXT and NUMBER fields",
      );
  }
  return { actorId, owner: owner.login };
}

async function readIssue(
  issueNodeId: string,
  binding: ProjectQueueBinding,
  graphql: ProjectGraphQL,
) {
  const data = object(await graphql(ISSUE, { issue: issueNodeId }, true));
  const issue = object(data.node);
  if (
    issue.__typename !== "Issue" ||
    issue.id !== issueNodeId ||
    !positiveInteger(issue.number) ||
    object(issue.repository).nameWithOwner !== binding.repository ||
    typeof issue.title !== "string" ||
    typeof issue.body !== "string" ||
    !["OPEN", "CLOSED"].includes(String(issue.state))
  )
    throw new Error(
      "Project queue Objective definition is unavailable or changed identity",
    );
  return issue;
}

async function readQueue(
  repository: string,
  binding: ProjectQueueBinding,
  graphql: ProjectGraphQL,
) {
  const access = await readBinding(repository, binding, graphql);
  const cards: ProjectQueueSnapshot["cards"] = [];
  const ignoredCards: ProjectQueueSnapshot["ignoredCards"] = [];
  const originals = new Map<string, ObjectValue>();
  const issues = new Set<string>();
  let control: ProjectQueueSnapshot["control"] | undefined;
  let after: string | null = null;
  const cursors = new Set<string>();
  for (let index = 0; ; index++) {
    if (index >= 1000)
      throw new Error("Project queue exceeds its complete observation bound");
    const data = object(
      await graphql(
        ITEMS,
        {
          project: binding.projectId,
          after,
        },
        true,
      ),
    );
    const project = object(data.node);
    if (project.__typename !== "ProjectV2" || project.id !== binding.projectId)
      throw new Error("Project queue pagination changed Project identity");
    const page = connection(project.items);
    for (const raw of page.nodes) {
      const card = cardIdentity(raw, binding);
      const itemId = card.id as string;
      if (originals.has(itemId))
        throw new Error("Project queue has duplicate card identities");
      originals.set(itemId, card);
      const firstFields = connection(card.fieldValues);
      const allFields = [...firstFields.nodes];
      let fieldAfter = firstFields.endCursor;
      let next = firstFields.hasNextPage;
      const fieldCursors = new Set<string>();
      for (let fieldPage = 0; next; fieldPage++) {
        if (fieldPage >= 100 || !fieldAfter || fieldCursors.has(fieldAfter))
          throw new Error(
            "Project queue field pagination is incomplete or repeated",
          );
        fieldCursors.add(fieldAfter);
        const result = object(
          await graphql(
            FIELDS,
            {
              item: itemId,
              after: fieldAfter,
            },
            true,
          ),
        );
        const node = object(result.node);
        if (
          node.__typename !== "ProjectV2Item" ||
          node.id !== itemId ||
          object(node.project).id !== binding.projectId
        )
          throw new Error(
            "Project queue field pagination changed card identity",
          );
        const fieldsPage = connection(node.fieldValues);
        allFields.push(...fieldsPage.nodes);
        fieldAfter = fieldsPage.endCursor;
        next = fieldsPage.hasNextPage;
      }
      const fields = fieldValues(allFields, binding);
      const content = object(card.content);
      if (itemId === binding.controlItemId) {
        if (
          card.isArchived ||
          !["Issue", "DraftIssue"].includes(String(content.__typename))
        )
          throw new Error(
            "Project queue control card is unavailable or archived",
          );
        control = { itemId, metadata: fields.metadata };
        continue;
      }
      if (
        content.__typename !== "Issue" ||
        object(content.repository).nameWithOwner !== repository
      ) {
        if (fields.metadata !== null && fields.metadata !== "")
          throw new Error(
            "Project queue metadata admits an unsupported Objective target",
          );
        ignoredCards.push({
          itemId,
          archived: card.isArchived as boolean,
          kind:
            content.__typename === "DraftIssue"
              ? "draft"
              : content.__typename === "Issue"
                ? "foreign-issue"
                : "pull-request",
        });
        continue;
      }
      const issueNodeId = content.id as string;
      if (!card.isArchived && issues.has(issueNodeId))
        throw new Error("Project queue has duplicate Objective cards");
      if (!card.isArchived) issues.add(issueNodeId);
      const issue = await readIssue(issueNodeId, binding, graphql);
      if (issue.number !== content.number)
        throw new Error(
          "Project queue Objective changed identity during observation",
        );
      cards.push({
        itemId,
        issueNodeId,
        objective: issue.number as number,
        repository,
        title: issue.title as string,
        body: issue.body as string,
        state: issue.state === "OPEN" ? "open" : "closed",
        archived: card.isArchived as boolean,
        ...fields,
      });
    }
    if (!page.hasNextPage) break;
    if (!page.endCursor || cursors.has(page.endCursor))
      throw new Error("Project queue pagination is repeated or incomplete");
    cursors.add(page.endCursor);
    after = page.endCursor;
  }
  if (!control)
    throw new Error("Project queue lacks its configured control card");
  // Recheck capabilities after pagination; the API offers no version/CAS guarantee.
  const current = await readBinding(repository, binding, graphql);
  if (current.actorId !== access.actorId || current.owner !== access.owner)
    throw new Error("Project queue access changed during observation");
  const snapshot: ProjectQueueSnapshot = {
    binding: structuredClone(binding),
    ...access,
    observedAt: new Date(time.now()).toISOString(),
    control,
    cards,
    ignoredCards,
  };
  return { snapshot, originals };
}

export async function projectQueueReadOnGitHub(
  repository: string,
  binding: ProjectQueueBinding,
  graphql: ProjectGraphQL,
): Promise<ProjectQueueSnapshot> {
  return (await readQueue(repository, structuredClone(binding), graphql))
    .snapshot;
}

export async function projectQueueWriteOnGitHub(
  repository: string,
  request: ProjectQueueWriteRequest,
  graphql: ProjectGraphQL,
): Promise<ProjectQueueWriteReceipt> {
  request = { ...request, binding: structuredClone(request.binding) };
  assertProjectQueueBinding(request.binding, repository);
  if (request.pending)
    throw new Error("A submitted Project queue effect permits no replay");
  if (typeof request.beforeWrite !== "function")
    throw new Error("Project queue mutation lacks durable owner admission");
  const { snapshot, originals } = await readQueue(
    repository,
    request.binding,
    graphql,
  );
  const action =
    request.action === "ensure-card"
      ? { action: request.action, issueNodeId: request.issueNodeId }
      : request.action === "set-order"
        ? {
            action: request.action,
            itemId: request.itemId,
            order: request.order,
          }
        : {
            action: request.action,
            itemId: request.itemId,
            metadata: request.metadata,
          };
  const base = {
    binding: structuredClone(request.binding),
    requestId: request.requestId,
    actorId: snapshot.actorId,
    observedAt: new Date(time.now()).toISOString(),
    ...action,
    ...(request.action === "ensure-card"
      ? {}
      : {
          fieldId:
            request.action === "set-order"
              ? request.binding.orderFieldId
              : request.binding.metadataFieldId,
        }),
  } as IntentBase;
  const intent = {
    ...base,
    request: mutationRequest(base),
  } as ProjectQueueIntent;
  assertProjectQueueIntent(intent, request.binding);
  if (request.action === "ensure-card") {
    const controlContent = object(
      originals.get(request.binding.controlItemId)?.content,
    );
    if (controlContent.id === request.issueNodeId)
      throw new Error(
        "Project queue control content cannot become an Objective card",
      );
    const existing = snapshot.cards.find(
      (card) => !card.archived && card.issueNodeId === request.issueNodeId,
    );
    if (existing) {
      const receipt: ProjectQueueWriteReceipt = {
        intent,
        itemId: existing.itemId,
        observedAt: new Date(time.now()).toISOString(),
        kind: "existing-read",
        original: originals.get(existing.itemId),
      };
      assertProjectQueueWriteReceipt(receipt);
      return receipt;
    }
    if (snapshot.cards.some((card) => card.issueNodeId === request.issueNodeId))
      throw new Error(
        "An archived Objective card requires current unarchived membership",
      );
    const issue = await readIssue(
      request.issueNodeId,
      request.binding,
      graphql,
    );
    if (issue.state !== "OPEN")
      throw new Error("Project queue cannot admit a closed Objective");
  } else {
    const card = originals.get(request.itemId);
    if (!card)
      throw new Error("Project queue mutation target is not a current member");
    targetCard(card, intent);
    // An original response must supply the complete field proof without another read.
    if (connection(card.fieldValues).hasNextPage)
      throw new Error(
        "Project queue mutation cannot supply complete original field proof",
      );
  }
  const admitted = structuredClone(intent);
  await request.beforeWrite(structuredClone(admitted));
  let original: unknown;
  try {
    original = await graphql(
      admitted.request.query,
      admitted.request.variables,
      false,
    );
  } catch (error) {
    if (error instanceof GitHubProjectQueueGraphqlError)
      throw new ProjectQueueResponseError(admitted, error.original, error);
    throw error;
  }
  try {
    const key =
      admitted.action === "ensure-card"
        ? "addProjectV2ItemById"
        : "updateProjectV2ItemFieldValue";
    const response = object(object(original)[key]);
    const card = object(
      response[admitted.action === "ensure-card" ? "item" : "projectV2Item"],
    );
    const receipt: ProjectQueueWriteReceipt = {
      intent: admitted,
      itemId: card.id as string,
      observedAt: new Date(time.now()).toISOString(),
      kind: "response",
      original,
    };
    assertProjectQueueWriteReceipt(receipt);
    return receipt;
  } catch (error) {
    throw new ProjectQueueResponseError(admitted, original, error);
  }
}
