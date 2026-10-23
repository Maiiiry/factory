import type { CoreConfig } from "./config.js";
import type { GitHub } from "./github.js";

/** One Objective card on the Project. */
export interface QueueItem {
  issue: number;
  itemId: string;
  /** The Factory field's option name, or null when unset. */
  option: string | null;
  order: number | null;
  open: boolean;
}

/*
 * The Project's own item list, which costs one page per 100 cards. GitHub
 * serves it from a search index that can lag or omit cards (seen for
 * minutes on a new Project), so the issues Factory already knows (queued
 * or running) and the most recently updated open issues (a new issue added
 * to the Project by its form) are also read from the issue side, which
 * GitHub reads directly. Cost follows the Project and the active work, not
 * the repository's open issues.
 */
const ITEMS = `
query($project: ID!, $after: String, $field: String!, $order: String!) {
  node(id: $project) {
    ... on ProjectV2 {
      items(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isArchived
          option: fieldValueByName(name: $field) {
            ... on ProjectV2ItemFieldSingleSelectValue { name }
          }
          order: fieldValueByName(name: $order) {
            ... on ProjectV2ItemFieldNumberValue { number }
          }
          content {
            ... on Issue { number state repository { nameWithOwner } }
          }
        }
      }
    }
  }
}`;

const ISSUE_FIELDS = `
fragment Card on Issue {
  number
  state
  projectItems(first: 20) {
    nodes {
      id
      isArchived
      project { id }
      option: fieldValueByName(name: $field) {
        ... on ProjectV2ItemFieldSingleSelectValue { name }
      }
      order: fieldValueByName(name: $order) {
        ... on ProjectV2ItemFieldNumberValue { number }
      }
    }
  }
}`;

/** Recently updated open issues, and these issues by number. */
const issuesQuery = (numbers: number[]) => `
query($owner: String!, $name: String!, $field: String!, $order: String!) {
  repository(owner: $owner, name: $name) {
    recent: issues(states: OPEN, first: 20, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { ...Card }
    }
${numbers.map((n) => `    i${n}: issue(number: ${n}) { ...Card }`).join("\n")}
  }
}
${ISSUE_FIELDS}`;

type Value = { name?: string; number?: number } | null;

interface ItemsPage {
  node: {
    items?: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: ({
        id: string;
        isArchived: boolean;
        option: Value;
        order: Value;
        content: {
          number?: number;
          state?: string;
          repository?: { nameWithOwner?: string };
        } | null;
      } | null)[];
    };
  } | null;
}

interface Card {
  number: number;
  state: string;
  projectItems: {
    nodes: ({
      id: string;
      isArchived: boolean;
      project: { id: string };
      option: Value;
      order: Value;
    } | null)[];
  };
}

/** Pages of the Project read at most; a longer Project is a failed read. */
const MAX_PAGES = 100;
/** Issues read by number in one request. */
const BY_NUMBER = 50;

/**
 * Open issues of this repository on the configured Project. `known` are
 * issue numbers read from the issue side as well. Throws on any failed or
 * partial read: callers keep their last good view.
 */
export async function readQueue(
  github: GitHub,
  config: CoreConfig,
  known: readonly number[] = [],
  signal?: AbortSignal,
): Promise<QueueItem[]> {
  const cards = new Map<number, QueueItem | null>();
  const fields = { field: config.queue.field, order: config.queue.orderField };
  let after: string | null = null;
  for (let page = 0; ; page++) {
    if (page === MAX_PAGES)
      throw new Error(
        `The Project has more than ${MAX_PAGES * 100} items; Factory read only part of it`,
      );
    const data: ItemsPage = await github.graphql<ItemsPage>(
      ITEMS,
      { project: config.queue.projectId, after, ...fields },
      signal,
    );
    const items = data.node?.items;
    if (!items) throw new Error(`Project ${config.queue.projectId} not found`);
    for (const node of items.nodes) {
      const content = node?.content;
      if (
        !node ||
        node.isArchived ||
        typeof content?.number !== "number" ||
        content.repository?.nameWithOwner?.toLowerCase() !==
          config.repository.toLowerCase()
      )
        continue;
      cards.set(
        content.number,
        content.state === "OPEN"
          ? {
              issue: content.number,
              itemId: node.id,
              option: node.option?.name ?? null,
              order: node.order?.number ?? null,
              open: true,
            }
          : null,
      );
    }
    if (!items.pageInfo.hasNextPage) break;
    after = items.pageInfo.endCursor;
  }
  // The issue side is read directly, so it wins over the lagging index.
  const numbers = [...new Set(known)];
  for (let at = 0; at === 0 || at < numbers.length; at += BY_NUMBER) {
    const chunk = numbers.slice(at, at + BY_NUMBER);
    const data = await github.graphql<{
      repository: Record<string, Card | { nodes: Card[] } | null> | null;
    }>(
      issuesQuery(chunk),
      { owner: github.owner, name: github.name, ...fields },
      signal,
    );
    if (!data.repository)
      throw new Error(`Repository ${config.repository} not found`);
    const read = [
      ...((data.repository.recent as { nodes: Card[] } | null)?.nodes ?? []),
      ...chunk.map((n) => data.repository![`i${n}`] as Card | null),
    ];
    for (const issue of read) {
      if (!issue) continue;
      const node = issue.projectItems.nodes.find(
        (n) => n?.project.id === config.queue.projectId && !n.isArchived,
      );
      cards.set(
        issue.number,
        node && issue.state === "OPEN"
          ? {
              issue: issue.number,
              itemId: node.id,
              option: node.option?.name ?? null,
              order: node.order?.number ?? null,
              open: true,
            }
          : null,
      );
    }
  }
  return [...cards.values()].filter((item): item is QueueItem => !!item);
}

/** Queued Objectives in queue order: the order field, then issue number. */
export function queued(items: QueueItem[], config: CoreConfig): QueueItem[] {
  return items
    .filter((item) => item.open && item.option === config.queue.options.queued)
    .sort(
      (a, b) =>
        (a.order ?? Number.MAX_SAFE_INTEGER) -
          (b.order ?? Number.MAX_SAFE_INTEGER) || a.issue - b.issue,
    );
}

const FIELD = `
query($project: ID!, $field: String!) {
  node(id: $project) {
    ... on ProjectV2 {
      field(name: $field) {
        ... on ProjectV2SingleSelectField { id options { id name } }
      }
    }
  }
}`;

const SET = `
mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $project, itemId: $item, fieldId: $field,
    value: { singleSelectOptionId: $option }
  }) { projectV2Item { id } }
}`;

/** Writes the Factory field. Field and option ids are looked up once per process. */
export class QueueDisplay {
  private field?: { id: string; options: Map<string, string> };

  constructor(
    private readonly github: GitHub,
    private readonly config: CoreConfig,
  ) {}

  async set(
    itemId: string,
    option: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const field = await this.lookup(signal);
    const optionId = field.options.get(option);
    if (!optionId)
      throw new Error(
        `The Project field "${this.config.queue.field}" has no option "${option}"`,
      );
    await this.github.graphql(
      SET,
      {
        project: this.config.queue.projectId,
        item: itemId,
        field: field.id,
        option: optionId,
      },
      signal,
    );
  }

  private async lookup(signal?: AbortSignal) {
    if (this.field) return this.field;
    const data = await this.github.graphql<{
      node: {
        field: { id?: string; options?: { id: string; name: string }[] } | null;
      } | null;
    }>(
      FIELD,
      { project: this.config.queue.projectId, field: this.config.queue.field },
      signal,
    );
    const field = data.node?.field;
    if (!field?.id || !field.options)
      throw new Error(
        `The Project has no single-select field "${this.config.queue.field}"`,
      );
    this.field = {
      id: field.id,
      options: new Map(field.options.map((o) => [o.name, o.id])),
    };
    return this.field;
  }
}
