import type { Plan, WorkItem } from "./types.js";

/**
 * Delivery units for native-stack delivery: the plan split into linear
 * chains. Each chain is delivered as chained PRs (layer i's base is layer
 * i-1's branch) and merged as one native stack on its top item. A unit of
 * one item is an ordinary PR, so a plan with no chains delivers exactly like
 * regular delivery.
 *
 * Pure: no I/O, and a malformed plan is a problem, never a throw.
 *
 * How the steps use it (core/src/work/steps.ts, native-stack mode only):
 * - Compute `units(plan)` once per steps() call. `{ problem }` is a
 *   deterministic plan fault: hold with replan or cancel (a retry would see
 *   the same plan). Checked plans never produce it.
 * - `unitOf(result, id)` finds an item's unit; `layer` is its index in
 *   `unit.items`. Layer i>0 is runnable once `item:<items[i-1]>:publish` is
 *   done, and starts from that predecessor's published head.
 * - Only `unit.items.at(-1)` gets a merge step when `items.length > 1`; it
 *   merges the whole stack. Every item of the unit counts as merged once that
 *   step is done. `externalDependencies` must all be merged before the
 *   unit's bottom layer starts.
 */
export interface DeliveryUnit {
  /** The bottom item's id. */
  id: string;
  /** Bottom first; each item's only dependency is the one before it. */
  items: WorkItem[];
  /** Dependencies outside the unit, which must merge before it starts. */
  externalDependencies: string[];
}

export type Units = { units: DeliveryUnit[] } | { problem: string };

/** A fork ends its parent's chain; a join starts a new chain. */
export function units(
  plan: Pick<Plan, "items" | "coverage" | "expansions">,
): Units {
  const byId = new Map(plan.items.map((item) => [item.id, item]));
  for (const item of plan.items)
    for (const dependency of item.dependencies)
      if (!byId.has(dependency))
        return {
          problem: `Work Item ${item.id} depends on ${dependency}, which is not in the plan`,
        };
  const ordered: WorkItem[] = [];
  const remaining = new Set(plan.items.map((item) => item.id));
  while (remaining.size) {
    const next = plan.items.find(
      (item) =>
        remaining.has(item.id) &&
        item.dependencies.every((dependency) => !remaining.has(dependency)),
    );
    if (!next)
      return {
        problem: `The plan's dependencies form a cycle among: ${[...remaining].join(", ")}`,
      };
    ordered.push(next);
    remaining.delete(next.id);
  }
  const children = new Map<string, string[]>();
  for (const item of plan.items)
    for (const dependency of item.dependencies)
      children.set(dependency, [...(children.get(dependency) ?? []), item.id]);
  const blocked = expansionBarriers(plan);
  // Items that never join a chain, as a child or as a parent.
  const standalone = (item: WorkItem | undefined) =>
    item === undefined ||
    item.kind === "qa" ||
    item.kind === "aggregate" ||
    item.kind === "discovery" ||
    item.condition !== undefined ||
    blocked(item.id);
  const continuation = new Map<string, string>();
  const childOf = new Set<string>();
  for (const item of plan.items) {
    if (standalone(item) || item.dependencies.length !== 1) continue;
    // Environment preparation must integrate before the consumer is admitted.
    if (
      plan.coverage.some(
        (entry) =>
          entry.itemId === item.id && entry.environment.readiness === "prepare",
      )
    )
      continue;
    const parent = item.dependencies[0] as string;
    if (standalone(byId.get(parent)) || children.get(parent)?.length !== 1)
      continue;
    continuation.set(parent, item.id);
    childOf.add(item.id);
  }
  const result: DeliveryUnit[] = [];
  for (const root of ordered) {
    if (childOf.has(root.id)) continue;
    const items: WorkItem[] = [];
    // Each item has at most one parent and one continuation, and the order
    // above is acyclic, so every chain ends.
    for (
      let current: string | undefined = root.id;
      current;
      current = continuation.get(current)
    )
      items.push(byId.get(current) as WorkItem);
    const own = new Set(items.map((item) => item.id));
    result.push({
      id: root.id,
      items,
      externalDependencies: [
        ...new Set(
          items.flatMap((item) =>
            item.dependencies.filter((dependency) => !own.has(dependency)),
          ),
        ),
      ],
    });
  }
  return { units: result };
}

/** The unit holding an item, and the item's layer (0 is the bottom). */
export function unitOf(
  all: readonly DeliveryUnit[],
  id: string,
): { unit: DeliveryUnit; layer: number } | undefined {
  for (const unit of all) {
    const layer = unit.items.findIndex((item) => item.id === id);
    if (layer >= 0) return { unit, layer };
  }
  return undefined;
}

/**
 * Items at or behind an expansion's integration barrier never chain: the
 * barrier must integrate on its own. Core does not settle expansions, so
 * every declared barrier counts.
 */
function expansionBarriers(
  plan: Pick<Plan, "items" | "expansions">,
): (id: string) => boolean {
  const barriers = new Set(
    (plan.expansions ?? []).flatMap(
      (envelope) => envelope.integrationBarrierItemIds,
    ),
  );
  const byId = new Map(plan.items.map((item) => [item.id, item]));
  const memo = new Map<string, boolean>();
  const blocked = (id: string): boolean => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    memo.set(id, false);
    const value =
      barriers.has(id) || (byId.get(id)?.dependencies.some(blocked) ?? false);
    memo.set(id, value);
    return value;
  };
  return blocked;
}
