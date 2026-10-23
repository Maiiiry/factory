import type { CoreConfig } from "./config.js";
import type { GitHub, GraphQLError } from "./github.js";

/** One Objective card on the Project. */
export interface QueueItem {
  issue: number;
  itemId: string;
  /** The Factory field's option name, or null when unset. */
  option: string | null;
  /** When the option was last set, by anyone (GitHub's clock). */
  optionAt: string | null;
  order: number | null;
  open: boolean;
}

/** A queue read: the cards, and what it couldn't read. */
export interface QueueRead {
  items: QueueItem[];
  /** Known issues GitHub no longer has here: deleted, transferred or converted. */
  gone: number[];
  /** Queued cards past the read's bound, left for a later read. */
  truncated: number;
}

/*
 * The Project's queued cards, filtered by GitHub (the items `query`), so a
 * read costs one page per 100 queued cards, not per card ever added. GitHub
 * serves that list from a search index that can lag or omit cards (seen
 * for minutes on a new Project), so the issues Factory already knows
 * (queued or running) and the most recently updated open issues (a new
 * issue added to the Project by its form) are also read from the issue
 * side, which GitHub reads directly. Cost follows the queue and the active
 * work, not the Project's history or the repository's open issues.
 */
const ITEMS = `
query($project: ID!, $after: String, $query: String!, $field: String!, $order: String!) {
  node(id: $project) {
    ... on ProjectV2 {
      items(first: 100, after: $after, query: $query) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isArchived
          option: fieldValueByName(name: $field) {
            ... on ProjectV2ItemFieldSingleSelectValue { name updatedAt }
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
        ... on ProjectV2ItemFieldSingleSelectValue { name updatedAt }
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

type Value = { name?: string; number?: number; updatedAt?: string } | null;

interface ItemsPage {
  node: {
    items?: {
      totalCount: number;
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

/** Pages of queued cards read at most; the rest wait for a later read. */
const MAX_PAGES = 10;
/** Issues read by number in one request. */
const BY_NUMBER = 50;

/**
 * The Project filter for open queued cards: a field is named in lower
 * case with dashes for spaces, and its option is quoted.
 */
function queuedFilter(config: CoreConfig): string {
  const field = config.queue.field.trim().toLowerCase().replace(/\s+/g, "-");
  const option = config.queue.options.queued.replace(/"/g, "");
  return `${field}:"${option}" is:open`;
}

/**
 * Open queued issues of this repository on the configured Project, and
 * `known` issues (read from the issue side) whatever their option. A known
 * issue GitHub no longer has is reported in `gone`, never a failed read;
 * any other failed or partial read throws, and callers keep their last
 * good view.
 */
export async function readQueue(
  github: GitHub,
  config: CoreConfig,
  known: readonly number[] = [],
  signal?: AbortSignal,
): Promise<QueueRead> {
  const cards = new Map<number, QueueItem | null>();
  const fields = { field: config.queue.field, order: config.queue.orderField };
  const card = (
    issue: number,
    open: boolean,
    node: { id: string; option: Value; order: Value } | undefined,
  ) =>
    cards.set(
      issue,
      node && open
        ? {
            issue,
            itemId: node.id,
            option: node.option?.name ?? null,
            optionAt: node.option?.updatedAt ?? null,
            order: node.order?.number ?? null,
            open: true,
          }
        : null,
    );
  let after: string | null = null;
  let truncated = 0;
  for (let page = 0; ; page++) {
    const data: ItemsPage = await github.graphql<ItemsPage>(
      ITEMS,
      {
        project: config.queue.projectId,
        after,
        query: queuedFilter(config),
        ...fields,
      },
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
      card(content.number, content.state === "OPEN", node);
    }
    if (!items.pageInfo.hasNextPage) break;
    if (page + 1 === MAX_PAGES) {
      truncated = Math.max(0, items.totalCount - MAX_PAGES * 100);
      break;
    }
    after = items.pageInfo.endCursor;
  }
  // The issue side is read directly, so it wins over the lagging index.
  const numbers = [...new Set(known)];
  const gone: number[] = [];
  for (let at = 0; at === 0 || at < numbers.length; at += BY_NUMBER) {
    const chunk = numbers.slice(at, at + BY_NUMBER);
    const aliases = new Set(chunk.map((n) => `i${n}`));
    // A missing issue is an error on its own alias: that issue is gone,
    // and the rest of the read stands.
    const missing = (error: GraphQLError) =>
      error.type === "NOT_FOUND" &&
      error.path?.length === 2 &&
      error.path[0] === "repository" &&
      aliases.has(String(error.path[1]));
    const { data } = await github.graphqlPartial<{
      repository: Record<string, Card | { nodes: Card[] } | null> | null;
    }>(
      issuesQuery(chunk),
      { owner: github.owner, name: github.name, ...fields },
      signal,
      missing,
    );
    if (!data.repository)
      throw new Error(`Repository ${config.repository} not found`);
    for (const issue of (data.repository.recent as { nodes: Card[] } | null)
      ?.nodes ?? [])
      read(issue);
    for (const n of chunk) {
      const issue = data.repository[`i${n}`] as Card | null | undefined;
      if (issue) read(issue);
      else {
        gone.push(n);
        cards.set(n, null);
      }
    }
  }
  function read(issue: Card): void {
    const node = issue.projectItems.nodes.find(
      (n) => n?.project.id === config.queue.projectId && !n.isArchived,
    );
    card(issue.number, issue.state === "OPEN", node ?? undefined);
  }
  return {
    items: [...cards.values()].filter((item): item is QueueItem => !!item),
    gone,
    truncated,
  };
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
mutation($project: ID!, $item: ID!, $field: ID!, $option: String!, $name: String!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $project, itemId: $item, fieldId: $field,
    value: { singleSelectOptionId: $option }
  }) {
    projectV2Item {
      id
      value: fieldValueByName(name: $name) {
        ... on ProjectV2ItemFieldSingleSelectValue { updatedAt }
      }
    }
  }
}`;

/** Writes the Factory field. Field and option ids are looked up once per process. */
export class QueueDisplay {
  private field?: { id: string; options: Map<string, string> };

  constructor(
    private readonly github: GitHub,
    private readonly config: CoreConfig,
  ) {}

  /** Set the option; returns when the field now says it was set (GitHub's clock). */
  async set(
    itemId: string,
    option: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const field = await this.lookup(signal);
    const optionId = field.options.get(option);
    if (!optionId)
      throw new Error(
        `The Project field "${this.config.queue.field}" has no option "${option}"`,
      );
    const data = await this.github.graphql<{
      updateProjectV2ItemFieldValue: {
        projectV2Item: { value: { updatedAt?: string } | null } | null;
      } | null;
    }>(
      SET,
      {
        project: this.config.queue.projectId,
        item: itemId,
        field: field.id,
        option: optionId,
        name: this.config.queue.field,
      },
      signal,
    );
    return (
      data.updateProjectV2ItemFieldValue?.projectV2Item?.value?.updatedAt ??
      undefined
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
