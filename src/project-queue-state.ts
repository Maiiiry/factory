import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  type FactoryConfig,
  factoryAuthorityDigest,
  factoryConfigDigest,
  stateRoot,
} from "./config.js";
import { LocalContentStore } from "./content/local.js";
import type {
  ContentRef,
  GitHubGateway,
  ProjectQueueAction,
  ProjectQueueBinding,
  ProjectQueueIntent,
  ProjectQueueSnapshot,
  ProjectQueueWriteReceipt,
} from "./contracts.js";
import {
  assertProjectQueueIntent,
  assertProjectQueueWriteReceipt,
} from "./github-project-queue.js";
import {
  awaitCheckpointAdmission,
  hasPrivateCheckpointScope,
  markCheckpointDirty,
  type RecoveryCheckpointClosure,
  readVerifiedRecoveryCheckpoint,
} from "./recovery-checkpoint.js";
import type { ContinuationState } from "./state.js";

export const queueDigest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const date = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Project queue receipt");
  return value as Record<string, unknown>;
};
const only = (value: Record<string, unknown>, keys: string[]) => {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error("Unsupported Project queue receipt field");
};

export type QueueMode = "running" | "paused" | "draining";
export type QueueMetadata =
  | {
      schemaVersion: 1;
      kind: "admission";
      admissionId: string;
      receiptId: string;
      state: "queued" | "withdrawn";
    }
  | {
      schemaVersion: 1;
      kind: "control";
      receiptId: string;
      mode: QueueMode;
      watch: boolean;
    };
export function parseQueueMetadata(text: string): QueueMetadata {
  const value = object(JSON.parse(text));
  if (value.schemaVersion !== 1 || !uuid(value.receiptId))
    throw new Error("Invalid Project queue metadata identity");
  if (value.kind === "admission") {
    only(value, ["schemaVersion", "kind", "admissionId", "receiptId", "state"]);
    if (
      !uuid(value.admissionId) ||
      !["queued", "withdrawn"].includes(String(value.state))
    )
      throw new Error("Invalid Project admission metadata");
  } else {
    only(value, ["schemaVersion", "kind", "receiptId", "mode", "watch"]);
    if (
      value.kind !== "control" ||
      !["running", "paused", "draining"].includes(String(value.mode)) ||
      typeof value.watch !== "boolean"
    )
      throw new Error("Invalid Project control metadata");
  }
  return value as unknown as QueueMetadata;
}
interface QueueEffect {
  intent: ProjectQueueIntent;
  receipt?: Omit<ProjectQueueWriteReceipt, "original">;
  original?: ContentRef;
  rejectedOriginal?: ContentRef;
}
export interface QueueOperation {
  schemaVersion: 1;
  kind: "project-queue-operation";
  id: string;
  repository: string;
  binding: ProjectQueueBinding;
  authorityDigest: string;
  at: string;
  action: "admit" | "withdraw" | "control" | "roadmap";
  /** Original explicit local operation; these historical receipts never supply membership. */
  approval: {
    kind: "queue-command" | "background-setup" | "proposal";
    proposalId?: string;
    approvalDigest?: string;
  };
  scope: string;
  previousReceiptId: string | null;
  objective?: number;
  issueNodeId?: string;
  bodyDigest?: string;
  order?: number;
  metadata?: string;
  effects: QueueEffect[];
  completed?: true;
}
export interface QueueOwnerClaim {
  schemaVersion: 1;
  kind: "project-queue-owner";
  id: string;
  repository: string;
  authorityDigest: string;
  admissionId: string;
  receiptId: string;
  objective: number;
  bodyDigest: string;
  ownerTokenDigest: string;
  at: string;
  deadlineAt: string | null;
  priorRunId?: string;
  settled?: { at: string; runId?: string; disposition: "quiescent" };
}
type QueueRecord = QueueOperation | QueueOwnerClaim;
const ref = (value: unknown): value is ContentRef => {
  const row = object(value);
  only(row, ["digest", "bytes", "mediaType"]);
  return (
    digest(row.digest) &&
    Number.isSafeInteger(row.bytes) &&
    Number(row.bytes) >= 0 &&
    row.mediaType === "application/json"
  );
};
export function parseQueueRecord(
  bytes: Uint8Array,
  repository: string,
  id: string,
): QueueRecord {
  const row = object(JSON.parse(Buffer.from(bytes).toString("utf8")));
  if (
    row.schemaVersion !== 1 ||
    row.repository !== repository ||
    row.id !== id ||
    !uuid(row.id) ||
    !digest(row.authorityDigest) ||
    !date(row.at)
  )
    throw new Error("Project queue history binding differs");
  if (row.kind === "project-queue-owner") {
    only(row, [
      "schemaVersion",
      "kind",
      "id",
      "repository",
      "authorityDigest",
      "admissionId",
      "receiptId",
      "objective",
      "bodyDigest",
      "ownerTokenDigest",
      "at",
      "deadlineAt",
      "priorRunId",
      "settled",
    ]);
    if (
      !uuid(row.admissionId) ||
      !uuid(row.receiptId) ||
      !digest(row.bodyDigest) ||
      !digest(row.ownerTokenDigest) ||
      !Number.isSafeInteger(row.objective) ||
      Number(row.objective) < 1 ||
      !(row.deadlineAt === null || date(row.deadlineAt)) ||
      (row.priorRunId !== undefined && !uuid(row.priorRunId))
    )
      throw new Error("Invalid Project queue owner identity");
    if (row.settled !== undefined) {
      const settled = object(row.settled);
      only(settled, ["at", "runId", "disposition"]);
      if (
        !date(settled.at) ||
        settled.disposition !== "quiescent" ||
        (settled.runId !== undefined && !uuid(settled.runId))
      )
        throw new Error("Invalid Project queue owner settlement");
    }
  } else {
    only(row, [
      "schemaVersion",
      "kind",
      "id",
      "repository",
      "binding",
      "authorityDigest",
      "at",
      "action",
      "approval",
      "scope",
      "previousReceiptId",
      "objective",
      "issueNodeId",
      "bodyDigest",
      "order",
      "metadata",
      "effects",
      "completed",
    ]);
    if (
      row.kind !== "project-queue-operation" ||
      !["admit", "withdraw", "control", "roadmap"].includes(
        String(row.action),
      ) ||
      typeof row.scope !== "string" ||
      !(row.previousReceiptId === null || uuid(row.previousReceiptId)) ||
      !Array.isArray(row.effects) ||
      row.effects.length > 3 ||
      (row.completed !== undefined && row.completed !== true)
    )
      throw new Error("Invalid Project queue operation");
    const binding = object(row.binding);
    only(binding, [
      "repository",
      "projectId",
      "metadataFieldId",
      "orderFieldId",
      "controlItemId",
      "factoryManagedFields",
    ]);
    if (
      binding.repository !== repository ||
      binding.factoryManagedFields !== true ||
      ["projectId", "metadataFieldId", "orderFieldId", "controlItemId"].some(
        (key) =>
          typeof binding[key] !== "string" ||
          !/^[A-Za-z0-9_-]{1,256}$/.test(String(binding[key])),
      )
    )
      throw new Error("Invalid Project queue field binding");
    const approval = object(row.approval);
    only(approval, ["kind", "proposalId", "approvalDigest"]);
    if (
      !["queue-command", "background-setup", "proposal"].includes(
        String(approval.kind),
      ) ||
      (approval.kind === "proposal" &&
        (!uuid(approval.proposalId) || !digest(approval.approvalDigest)))
    )
      throw new Error("Invalid Project queue approval provenance");
    if (
      row.action !== "control" &&
      (!Number.isSafeInteger(row.objective) ||
        Number(row.objective) < 1 ||
        typeof row.issueNodeId !== "string" ||
        !digest(row.bodyDigest))
    )
      throw new Error("Invalid Project queue Objective binding");
    if (
      row.order !== undefined &&
      (!Number.isSafeInteger(row.order) || Number(row.order) < 1)
    )
      throw new Error("Invalid Project queue order binding");
    if (row.metadata !== undefined) {
      if (
        typeof row.metadata !== "string" ||
        parseQueueMetadata(row.metadata).receiptId !== id
      )
        throw new Error("Project queue metadata differs from producer receipt");
    }
    const seen = new Set<string>();
    for (const raw of row.effects) {
      const effect = object(raw);
      only(effect, ["intent", "receipt", "original", "rejectedOriginal"]);
      assertProjectQueueIntent(effect.intent);
      const intent = effect.intent as ProjectQueueIntent;
      if (
        JSON.stringify(intent.binding) !== JSON.stringify(binding) ||
        seen.has(intent.requestId)
      )
        throw new Error("Project queue effect differs from operation");
      seen.add(intent.requestId);
      if (effect.original !== undefined && !ref(effect.original))
        throw new Error("Invalid Project queue original body reference");
      if (
        effect.rejectedOriginal !== undefined &&
        !ref(effect.rejectedOriginal)
      )
        throw new Error("Invalid rejected Project queue original reference");
      if ((effect.receipt === undefined) !== (effect.original === undefined))
        throw new Error("Project queue receipt requires its original response");
      if (
        effect.receipt !== undefined &&
        JSON.stringify(object(effect.receipt).intent) !== JSON.stringify(intent)
      )
        throw new Error("Project queue response intent differs");
    }
    if (
      row.completed &&
      row.effects.some((raw) => object(raw).receipt === undefined)
    )
      throw new Error("Completed Project queue operation has unknown effects");
  }
  return row as unknown as QueueRecord;
}
function privateBytes(path: string): Buffer {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.uid !== process.getuid?.() ||
    stat.mode & 0o077 ||
    realpathSync(dirname(path)) !== dirname(path)
  )
    throw new Error(
      "Project queue history must be an owned private regular file",
    );
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
function save(record: QueueRecord): void {
  const directory = join(stateRoot(record.repository), "project-queue-history");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (realpathSync(directory) !== directory)
    throw new Error(
      "Project queue history directory resolves through a symlink",
    );
  const path = join(directory, `${record.id}.json`);
  parseQueueRecord(
    Buffer.from(JSON.stringify(record)),
    record.repository,
    record.id,
  );
  if (existsSync(path)) {
    const previous = parseQueueRecord(
      privateBytes(path),
      record.repository,
      record.id,
    );
    if (previous.kind !== record.kind)
      throw new Error("Project receipt identity cannot change its role");
    if (
      previous.kind === "project-queue-operation" &&
      record.kind === "project-queue-operation"
    ) {
      const {
        effects: oldEffects,
        completed: oldCompleted,
        ...oldBinding
      } = previous;
      const {
        effects: newEffects,
        completed: newCompleted,
        ...newBinding
      } = record;
      if (
        JSON.stringify(oldBinding) !== JSON.stringify(newBinding) ||
        (oldCompleted && !newCompleted) ||
        newEffects.length < oldEffects.length
      )
        throw new Error(
          "Original Project admission and effect history are immutable",
        );
      for (const [index, oldEffect] of oldEffects.entries()) {
        const next = newEffects[index]!;
        if (
          JSON.stringify(oldEffect.intent) !== JSON.stringify(next.intent) ||
          (oldEffect.receipt &&
            JSON.stringify(oldEffect.receipt) !==
              JSON.stringify(next.receipt)) ||
          (oldEffect.original &&
            JSON.stringify(oldEffect.original) !==
              JSON.stringify(next.original)) ||
          (oldEffect.rejectedOriginal &&
            JSON.stringify(oldEffect.rejectedOriginal) !==
              JSON.stringify(next.rejectedOriginal))
        )
          throw new Error(
            "Original Project mutation intent/response cannot be replaced",
          );
      }
    } else if (
      previous.kind === "project-queue-owner" &&
      record.kind === "project-queue-owner"
    ) {
      const { settled: oldSettled, ...oldBinding } = previous;
      const { settled: newSettled, ...newBinding } = record;
      if (
        JSON.stringify(oldBinding) !== JSON.stringify(newBinding) ||
        (oldSettled &&
          JSON.stringify(oldSettled) !== JSON.stringify(newSettled))
      )
        throw new Error(
          "Original Project owner claim and settlement are immutable",
        );
    }
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(record)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  const parent = openSync(directory, constants.O_RDONLY);
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
  markCheckpointDirty(record.repository, {
    path,
    kind: "project-queue-receipt",
  });
}
export function projectQueuePersistenceClosure(
  config: FactoryConfig,
  root = stateRoot(config.repository),
): RecoveryCheckpointClosure {
  const directory = join(root, "project-queue-history");
  const store = new LocalContentStore(join(root, "content"));
  const closure: RecoveryCheckpointClosure = {
    files: [],
    contentRefs: [],
    gaps: [],
  };
  for (const name of existsSync(directory)
    ? readdirSync(directory).sort()
    : []) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name))
      throw new Error("Unrecognized Project queue history file");
    const bytes = privateBytes(join(directory, name));
    const record = parseQueueRecord(
      bytes,
      config.repository,
      name.slice(0, -5),
    );
    const body = store.putBytes(bytes, { mediaType: "application/json" });
    closure.files.push({
      kind: "historical",
      path: `project-queue-history/${name}`,
      ref: body,
      visibility: "private",
    });
    closure.contentRefs.push(body);
    if (record.kind === "project-queue-operation")
      for (const effect of record.effects) {
        if (effect.original) {
          assertProjectQueueWriteReceipt({
            ...effect.receipt,
            original: JSON.parse(
              store.readBytes(effect.original).toString("utf8"),
            ),
          });
          closure.contentRefs.push(effect.original);
        }
        if (effect.rejectedOriginal) {
          store.readBytes(effect.rejectedOriginal);
          closure.contentRefs.push(effect.rejectedOriginal);
        }
      }
  }
  return closure;
}
export function requireProjectQueueEffects(
  config: FactoryConfig,
): ProjectQueueBinding {
  const binding = config.queue?.project;
  if (!binding)
    throw new Error(
      "Queue operations require an explicitly bound Project; run Factory setup with its existing queue fields and control card",
    );
  if (
    config.gitPersistence?.scope !== "private-history" ||
    !hasPrivateCheckpointScope()
  )
    throw new Error(
      "Project queue mutation and dispatch require the configured private-history Git checkpoint scope",
    );
  return binding;
}
export async function readQueueHistory(
  config: FactoryConfig,
): Promise<QueueRecord[]> {
  if (config.gitPersistence?.scope !== "private-history")
    throw new Error(
      "Authenticated Project queue receipts require private-history Git persistence",
    );
  const archive = await readVerifiedRecoveryCheckpoint(config);
  const records: QueueRecord[] = [];
  for (const file of archive.manifest.files) {
    const match = /^project-queue-history\/([a-f0-9-]{36})\.json$/.exec(
      file.path,
    );
    if (!match) continue;
    if (file.visibility !== "private" || file.kind !== "historical")
      throw new Error("Project queue receipt has an invalid archive scope");
    const record = parseQueueRecord(
      await archive.readVerifiedBlob(file.ref),
      config.repository,
      match[1]!,
    );
    if (record.kind === "project-queue-operation")
      for (const effect of record.effects)
        if (effect.original) {
          assertProjectQueueWriteReceipt({
            ...effect.receipt,
            original: JSON.parse(
              Buffer.from(
                await archive.readVerifiedBlob(effect.original),
              ).toString("utf8"),
            ),
          });
        }
    if (records.some((previous) => previous.id === record.id))
      throw new Error("Duplicate archived Project queue receipt");
    records.push(record);
  }
  return records;
}
export interface VerifiedQueueEntry {
  objective: number;
  itemId: string;
  issueNodeId: string;
  admissionId: string;
  receiptId: string;
  bodyDigest: string;
  authorityDigest: string;
  order: number;
  state: "queued" | "withdrawn";
}
export interface VerifiedQueueObservation {
  snapshot: ProjectQueueSnapshot;
  history: QueueRecord[];
  control: Extract<QueueMetadata, { kind: "control" }>;
  entries: VerifiedQueueEntry[];
}
function producer(
  config: FactoryConfig,
  history: QueueRecord[],
  text: string,
  scope: string,
  itemId: string,
  historical = false,
): QueueOperation {
  const metadata = parseQueueMetadata(text);
  const record = history.find(
    (entry): entry is QueueOperation =>
      entry.kind === "project-queue-operation" &&
      entry.id === metadata.receiptId,
  );
  if (
    !record ||
    !record.completed ||
    record.scope !== scope ||
    record.metadata !== text ||
    (!historical &&
      record.authorityDigest !== factoryAuthorityDigest(config)) ||
    JSON.stringify(record.binding) !== JSON.stringify(config.queue?.project)
  )
    throw new Error(
      "Project queue metadata lacks its exact authenticated explicit producer receipt",
    );
  if (
    history.some(
      (entry) =>
        entry.kind === "project-queue-operation" &&
        entry.scope === scope &&
        entry.previousReceiptId === record.id,
    )
  )
    throw new Error(
      "Project queue metadata was superseded or has an unresolved successor",
    );
  const last = record.effects.at(-1);
  if (
    last?.intent.action !== "set-metadata" ||
    last.intent.itemId !== itemId ||
    last.intent.metadata !== text ||
    last.receipt?.kind !== "response"
  )
    throw new Error(
      "Project queue metadata has no exact original field-update receipt",
    );
  if (
    metadata.kind === "control"
      ? record.action !== "control"
      : record.action !== (metadata.state === "queued" ? "admit" : "withdraw")
  )
    throw new Error(
      "Project metadata role differs from its explicit original action",
    );
  return record;
}
export function verifyQueueObservation(
  config: FactoryConfig,
  snapshot: ProjectQueueSnapshot,
  history: QueueRecord[],
  historical = false,
): VerifiedQueueObservation {
  if (
    JSON.stringify(snapshot.binding) !==
      JSON.stringify(config.queue?.project) ||
    snapshot.control.metadata === null
  )
    throw new Error(
      "Project queue control metadata is missing or differs from its binding",
    );
  producer(
    config,
    history,
    snapshot.control.metadata,
    "control",
    snapshot.control.itemId,
    historical,
  );
  const control = parseQueueMetadata(snapshot.control.metadata);
  if (control.kind !== "control")
    throw new Error("Project control card contains admission metadata");
  const entries: VerifiedQueueEntry[] = [];
  for (const card of snapshot.cards) {
    if (card.archived) continue;
    if (card.metadata === null) continue;
    const operation = producer(
      config,
      history,
      card.metadata,
      card.issueNodeId,
      card.itemId,
      historical,
    );
    const metadata = parseQueueMetadata(card.metadata);
    if (
      metadata.kind !== "admission" ||
      operation.objective !== card.objective ||
      operation.issueNodeId !== card.issueNodeId ||
      operation.order !== card.order ||
      card.repository !== config.repository ||
      !Number.isSafeInteger(card.order) ||
      Number(card.order) < 1
    )
      throw new Error(
        "Project queue card/order differs from original admission",
      );
    entries.push({
      objective: card.objective,
      itemId: card.itemId,
      issueNodeId: card.issueNodeId,
      admissionId: metadata.admissionId,
      receiptId: metadata.receiptId,
      bodyDigest: operation.bodyDigest!,
      authorityDigest: operation.authorityDigest,
      order: card.order!,
      state: metadata.state,
    });
  }
  if (
    new Set(entries.map((entry) => entry.objective)).size !== entries.length ||
    new Set(entries.map((entry) => entry.order)).size !== entries.length ||
    new Set(entries.map((entry) => entry.admissionId)).size !== entries.length
  )
    throw new Error("Project queue has duplicate admission/order bindings");
  // An unknown operation can have failed before its metadata reached any card.
  if (
    history.some(
      (entry) =>
        entry.kind === "project-queue-operation" &&
        !entry.completed &&
        entry.authorityDigest === factoryAuthorityDigest(config),
    )
  )
    throw new Error(
      "A Project queue operation remains partial or unknown; preserve its original receipt and do not replay it",
    );
  return {
    snapshot,
    history,
    control,
    entries: entries.sort((a, b) => a.order - b.order),
  };
}
export async function observeProjectQueue(
  config: FactoryConfig,
  github: GitHubGateway,
  authority: "current" | "explicit-operation" = "current",
): Promise<VerifiedQueueObservation> {
  const binding = config.queue?.project;
  if (!binding || !github.projectQueueRead)
    throw new Error(
      "The configured GitHub gateway cannot read the bound Project queue",
    );
  const snapshot = await github.projectQueueRead(binding);
  return verifyQueueObservation(
    config,
    snapshot,
    await readQueueHistory(config),
    authority === "explicit-operation",
  );
}
export function createQueueOperation(
  config: FactoryConfig,
  fields: Pick<
    QueueOperation,
    "action" | "scope" | "previousReceiptId" | "approval"
  > &
    Partial<
      Pick<QueueOperation, "objective" | "issueNodeId" | "bodyDigest" | "order">
    >,
): QueueOperation {
  return {
    schemaVersion: 1,
    kind: "project-queue-operation",
    id: randomUUID(),
    repository: config.repository,
    binding: requireProjectQueueEffects(config),
    authorityDigest: factoryAuthorityDigest(config),
    at: new Date().toISOString(),
    ...fields,
    effects: [],
  };
}
export async function performQueueEffect(
  config: FactoryConfig,
  github: GitHubGateway,
  operation: QueueOperation,
  action: ProjectQueueAction,
): Promise<ProjectQueueWriteReceipt> {
  requireProjectQueueEffects(config);
  if (
    !github.projectQueueWrite ||
    operation.effects.some((effect) => !effect.receipt)
  )
    throw new Error(
      "Project queue write is unavailable or held by an unknown prior effect",
    );
  const requestId = randomUUID();
  const store = new LocalContentStore(
    join(stateRoot(config.repository), "content"),
  );
  let retained: QueueEffect | undefined;
  try {
    const returned = await github.projectQueueWrite({
      ...action,
      binding: operation.binding,
      requestId,
      beforeWrite: async (intent) => {
        assertProjectQueueIntent(intent);
        if (
          intent.requestId !== requestId ||
          JSON.stringify(intent.binding) !== JSON.stringify(operation.binding)
        )
          throw new Error("Project queue adapter intent differs");
        retained = { intent };
        operation.effects.push(retained);
        save(operation);
        await awaitCheckpointAdmission(config.repository, "before-effect");
      },
    });
    assertProjectQueueWriteReceipt(returned);
    if (returned.kind === "existing-read") {
      if (action.action !== "ensure-card" || retained)
        throw new Error(
          "Existing Project observation cannot settle a submitted effect",
        );
      retained = { intent: returned.intent };
      operation.effects.push(retained);
    }
    if (
      !retained ||
      JSON.stringify(retained.intent) !== JSON.stringify(returned.intent)
    )
      throw new Error("Project queue response differs from retained effect");
    const { original, ...receipt } = returned;
    retained.original = store.putBytes(Buffer.from(JSON.stringify(original)), {
      mediaType: "application/json",
    });
    retained.receipt = receipt;
    save(operation);
    await awaitCheckpointAdmission(config.repository, "explicit");
    return returned;
  } catch (error) {
    if (
      retained &&
      error &&
      typeof error === "object" &&
      "original" in error &&
      error.original !== undefined
    ) {
      retained.rejectedOriginal = store.putBytes(
        Buffer.from(JSON.stringify(error.original)),
        { mediaType: "application/json" },
      );
      save(operation);
    }
    throw error;
  }
}
export async function completeQueueOperation(
  config: FactoryConfig,
  operation: QueueOperation,
): Promise<void> {
  operation.completed = true;
  save(operation);
  await awaitCheckpointAdmission(config.repository, "explicit");
}
export async function claimProjectQueueRun(
  config: FactoryConfig,
  github: GitHubGateway,
  objective: number,
  ownerToken: string,
  snapshot?: ContinuationState,
): Promise<QueueOwnerClaim | undefined> {
  if (!config.queue?.project) return;
  requireProjectQueueEffects(config);
  if (snapshot && snapshot.configDigest !== factoryConfigDigest(config))
    throw new Error(
      "Existing execution configuration differs; use supported reconciliation without renewing admission or allowances",
    );
  // Existing archive without this host's verified baseline cannot be overwritten.
  await awaitCheckpointAdmission(config.repository, "explicit");
  const observed = await observeProjectQueue(config, github);
  const entry = observed.entries.find(
    (candidate) =>
      candidate.objective === objective && candidate.state === "queued",
  );
  const card = observed.snapshot.cards.find(
    (candidate) => !candidate.archived && candidate.objective === objective,
  );
  if (
    observed.control.mode !== "running" ||
    !entry ||
    card?.state !== "open" ||
    queueDigest(card.body) !== entry.bodyDigest
  )
    throw new Error(
      `Foreground and queue dispatch require a current open, exact-content approved Project admission and running control; use factory queue add ${objective}, or factory queue resume for an intentionally paused queue`,
    );
  const prior = observed.history.filter(
    (record): record is QueueOwnerClaim =>
      record.kind === "project-queue-owner" && record.objective === objective,
  );
  if (
    observed.history.some(
      (record) => record.kind === "project-queue-owner" && !record.settled,
    )
  )
    throw new Error(
      "This Project admission has an unfinished or foreign owner; supported resource reconciliation is required before dispatch",
    );
  if (
    prior.length &&
    (!snapshot ||
      prior.some(
        (claim) =>
          (claim.settled?.runId ?? claim.priorRunId) !== snapshot.runId,
      ))
  )
    throw new Error(
      "A prior Objective run exists; restore its exact continuation before dispatch, preserving its original results and spent allowances",
    );
  const recorded = prior.at(0)?.deadlineAt;
  if (prior.some((claim) => claim.deadlineAt !== recorded))
    throw new Error("Historical Objective deadlines differ; dispatch is held");
  const deadlineAt =
    recorded !== undefined
      ? recorded
      : snapshot
        ? (snapshot.coordinator?.deadlineAt ?? null)
        : config.queue?.objectiveDeadlineSeconds === undefined
          ? null
          : new Date(
              Date.now() + config.queue.objectiveDeadlineSeconds * 1000,
            ).toISOString();
  if (
    snapshot &&
    recorded !== undefined &&
    recorded !== (snapshot.coordinator?.deadlineAt ?? null)
  )
    throw new Error(
      "Project admission deadline differs from its original continuation",
    );
  if (deadlineAt !== null && Date.parse(deadlineAt) <= Date.now())
    throw new Error(
      "Project admission's frozen deadline elapsed; it cannot be renewed",
    );
  const claim: QueueOwnerClaim = {
    schemaVersion: 1,
    kind: "project-queue-owner",
    id: randomUUID(),
    repository: config.repository,
    authorityDigest: factoryAuthorityDigest(config),
    admissionId: entry.admissionId,
    receiptId: entry.receiptId,
    objective,
    bodyDigest: entry.bodyDigest,
    ownerTokenDigest: queueDigest(ownerToken),
    at: new Date().toISOString(),
    deadlineAt,
    ...(snapshot ? { priorRunId: snapshot.runId } : {}),
  };
  save(claim);
  await awaitCheckpointAdmission(config.repository, "before-effect");
  await assertProjectQueueRunLive(config, github, claim);
  return claim;
}
/** A fresh read can hold an actual owner; it never grants or releases ownership. */
export async function assertProjectQueueRunLive(
  config: FactoryConfig,
  github: GitHubGateway,
  claim: QueueOwnerClaim,
): Promise<void> {
  const observed = await observeProjectQueue(config, github);
  const entry = observed.entries.find(
    (candidate) =>
      candidate.admissionId === claim.admissionId &&
      candidate.receiptId === claim.receiptId &&
      candidate.state === "queued",
  );
  const card =
    entry &&
    observed.snapshot.cards.find(
      (candidate) => candidate.itemId === entry.itemId,
    );
  const retained = observed.history.find(
    (record) => record.kind === "project-queue-owner" && record.id === claim.id,
  );
  if (
    observed.control.mode !== "running" ||
    !entry ||
    card?.state !== "open" ||
    queueDigest(card.body) !== claim.bodyDigest ||
    !retained ||
    retained.kind !== "project-queue-owner" ||
    retained.settled ||
    retained.ownerTokenDigest !== claim.ownerTokenDigest
  )
    throw new Error(
      "The owned Project admission is unavailable, changed, paused or draining; retain its original claim and use supported queue reconciliation",
    );
}
/** Only the actual owning controller calls this after its existing resource check. */
export async function settleProjectQueueRun(
  config: FactoryConfig,
  claim: QueueOwnerClaim,
  ownerToken: string,
  runId?: string,
): Promise<void> {
  if (claim.ownerTokenDigest !== queueDigest(ownerToken) || claim.settled)
    throw new Error(
      "Project admission settlement differs from its actual owner",
    );
  claim.settled = {
    at: new Date().toISOString(),
    disposition: "quiescent",
    ...(runId ? { runId } : {}),
  };
  save(claim);
  await awaitCheckpointAdmission(config.repository, "explicit");
}
