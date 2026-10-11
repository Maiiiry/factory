import { createHash } from "node:crypto";
import {
  factoryConfigDigest,
  stateRoot,
  type FactoryConfig,
} from "../config.js";
import type { ContentStore } from "../contracts.js";
import { retainLearningMemory } from "../learning.js";
import { pinnedGit } from "../process.js";
import {
  LocalRepositoryMemory,
  type MemoryApplicability,
  type MemoryLookup,
  type MemoryResult,
} from "../repository-memory.js";
import {
  contextDigest,
  contextMatch,
  contextResultBytes,
  repositoryContextResult,
  type ContextMatch,
  type ContextRequest,
  type ContextResult,
  type PlanningContextResolver,
} from "./context.js";
import type { PlanningSource } from "./sources.js";

const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const admittedPath = (path: string, selectors: string[]) =>
  selectors.some(
    (selector) =>
      path === selector ||
      (selector.endsWith("/") && path.startsWith(selector)),
  );

/** The installed controller's admitted, read-only source and retained-memory boundary. */
export function createPlanningContextResolver(input: {
  config: FactoryConfig;
  objective: number;
  runId: string;
  baseSha: string;
  sources: PlanningSource[];
  contentStore: ContentStore;
}): PlanningContextResolver | undefined {
  const { config, objective, runId, baseSha, sources, contentStore } = input;
  const options = config.planningContext;
  if (!options?.enabled) return undefined;
  const preparationStarted = Date.now();
  const treeSha = pinnedGit(config.checkout, "rev-parse", `${baseSha}^{tree}`);
  const configDigest = factoryConfigDigest(config);
  const applicability: MemoryApplicability = {
    treeSha,
    paths: Object.fromEntries(
      sources
        .filter(
          (source) =>
            source.path !== "OBJECTIVE" && source.heading === undefined,
        )
        .map((source) => [source.path, digest(source.content)]),
    ),
    environment: { configDigest },
    sources: Object.fromEntries(
      sources.map((source) => [
        source.path,
        { version: digest(source.content) },
      ]),
    ),
  };
  const lookup: MemoryLookup = {
    access: {
      repository: config.repository,
      visibility: ["repository", "private"],
    },
    applicability,
    scope: { objective, paths: options.selectors },
    limit: Math.min(256, Math.max(0, options.bounds.maxResults - 1)),
    maxBytes: options.bounds.maxBytes,
  };
  let memory: LocalRepositoryMemory | undefined;
  let memoryUnavailable = false;
  if (options.memory) {
    try {
      retainLearningMemory(config.repository);
      memory = new LocalRepositoryMemory(
        stateRoot(config.repository),
        config.repository,
      );
    } catch {
      memoryUnavailable = true;
    }
  }
  let metadata: ReturnType<LocalRepositoryMemory["metadata"]> | undefined;
  try {
    metadata = memory?.metadata(lookup);
  } catch {
    memoryUnavailable = true;
  }
  const eligible = new Set(
    metadata?.entries.map((entry) => entry.binding.id) ?? [],
  );
  const superseded = new Set(
    metadata?.entries.flatMap((entry) => entry.record.supersedes) ?? [],
  );
  const automatic: ContextRequest[] = options.memory
    ? [
        {
          id: "automatic-relevant-memory",
          operation: "search",
          collection: "memory",
          selector: "",
          query: [
            ...options.selectors,
            sources.find((source) => source.path === "OBJECTIVE")?.content ??
              "",
          ]
            .join("\n")
            .slice(0, 1024),
          required: false,
          reason:
            "Automatically supply relevant scoped decisions, repository maps and retained failure or correction context",
        },
      ]
    : [];
  if (metadata && !metadata.complete)
    automatic[0] = {
      id: "automatic-incomplete-memory-inventory",
      operation: "inventory",
      collection: "memory",
      selector: "",
      query: "",
      required: true,
      reason:
        "An incomplete eligible manifest inventory cannot establish that all current Objective decisions are supplied",
    };
  automatic.unshift(
    ...(metadata?.entries ?? [])
      .filter(
        ({ binding, record }) =>
          !superseded.has(binding.id) &&
          record.authority === "human-decision" &&
          record.producer.objective === objective &&
          record.validity.state === "current",
      )
      .map(({ binding }) => ({
        id: `automatic-decision-${binding.id}`,
        operation: "read" as const,
        collection: "memory",
        selector: binding.id,
        query: "",
        required: true,
        reason:
          "Supply retained current human decision for this Objective before graph compilation",
      })),
  );
  const catalog: PlanningContextResolver["catalog"] = [
    {
      id: "repository",
      selectors: [...options.selectors],
      operations: ["read", "search", "inventory"],
      freshness: `Immutable admitted Git commit ${baseSha}, tree ${treeSha}`,
      completeness: "complete",
    },
    {
      id: "pinned-sources",
      selectors: sources
        .slice(0, options.bounds.maxResults)
        .map((_, index) => String(index)),
      operations: ["read"],
      freshness:
        "Indexed exact required Sources already supplied in the planning packet; indices retain pinned path and heading",
      completeness:
        sources.length <= options.bounds.maxResults ? "complete" : "incomplete",
    },
  ];
  if (options.memory)
    catalog.push({
      id: "memory",
      selectors: ["", ...eligible],
      operations: ["read", "search", "inventory"],
      freshness:
        "Retained content only; source versions, current tree/path/environment and expiry are checked before reliance. No connector or network refresh is admitted",
      completeness: memoryUnavailable
        ? "unavailable"
        : metadata?.complete
          ? "complete"
          : "incomplete",
    });
  const bound = (
    request: ContextRequest,
    matches: ContextMatch[],
    remaining: { maxResults: number; maxBytes: number; deadlineAt: number },
    disposition: ContextResult["disposition"],
    detail: string,
  ): ContextResult => {
    if (Date.now() >= remaining.deadlineAt)
      return {
        request,
        disposition: "exhausted",
        matches: [],
        detail: "Admitted lookup elapsed allowance is exhausted",
      };
    if (
      matches.length > remaining.maxResults ||
      contextResultBytes({ matches }) > remaining.maxBytes
    )
      return {
        request,
        disposition: "incomplete",
        matches: [],
        detail:
          "Complete retained content exceeds the remaining allowance; narrow the request",
      };
    return { request, disposition, matches, detail };
  };
  const memoryMatch = (result: MemoryResult) =>
    contextMatch(
      `memory:${result.binding.id}`,
      JSON.stringify({ record: result.record, content: result.content }),
      {
        repository: config.repository,
        manifestRef: result.binding.manifestRef,
        disposition: result.disposition,
        gaps: result.gaps,
        authority: result.record.authority,
        ...(result.record.validity.expiresAt
          ? { validUntil: result.record.validity.expiresAt }
          : {}),
        complete: result.disposition === "current",
      },
    );
  return {
    binding: contextDigest({
      repository: config.repository,
      objective,
      runId,
      baseSha,
      treeSha,
      configDigest,
      sources,
      mandatoryDecisions: automatic
        .filter((request) => request.required)
        .map((request) => request.selector),
    }),
    bounds: { ...options.bounds },
    preparationElapsedMs: Date.now() - preparationStarted,
    catalog,
    automatic,
    contentStore,
    async resolve(request, remaining) {
      const answer = (
        disposition: ContextResult["disposition"],
        detail: string,
      ): ContextResult => ({ request, disposition, matches: [], detail });
      if (request.collection === "pinned-sources") {
        const index = sources.findIndex(
          (_, i) => String(i) === request.selector,
        );
        const source = sources[index];
        if (request.operation !== "read" || !source)
          return answer(
            "denied",
            "Read requires an exact admitted source index",
          );
        return bound(
          request,
          [
            contextMatch(`source:${index}`, source.content, {
              baseSha,
              sourceIndex: index,
              path: source.path,
              ...(source.heading ? { heading: source.heading } : {}),
              complete: true,
            }),
          ],
          remaining,
          "complete",
          "Reused exact required Source bytes already supplied to the compiler",
        );
      }
      if (request.collection === "repository") {
        if (!admittedPath(request.selector, options.selectors))
          return answer(
            "denied",
            "Repository selector is outside the explicit admitted scope",
          );
        const source = sources.find(
          (source) =>
            source.path === request.selector && source.heading === undefined,
        );
        const result =
          request.operation === "read" && source
            ? bound(
                request,
                [
                  contextMatch(
                    `git:${baseSha}:${source.path}`,
                    source.content,
                    { baseSha, path: source.path, complete: true },
                  ),
                ],
                remaining,
                "complete",
                "Reused complete pinned source body without another target read",
              )
            : repositoryContextResult(
                config.checkout,
                baseSha,
                request,
                remaining,
              );
        for (const match of result.matches) {
          const path = match.provenance.path;
          if (typeof path === "string" && match.provenance.complete === true)
            applicability.paths![path] = match.digest;
        }
        return result;
      }
      if (request.collection !== "memory" || !options.memory)
        return answer(
          "denied",
          "Collection is outside admitted planning context",
        );
      if (!memory || memoryUnavailable || !metadata)
        return answer(
          "unavailable",
          "Scoped retained memory is unavailable; no new provider or connector access is authorized",
        );
      if (request.operation === "inventory") {
        if (request.selector !== "")
          return answer(
            "denied",
            "Memory inventory uses the eligible collection selector",
          );
        const match = contextMatch(
          "memory:eligible-inventory",
          JSON.stringify(metadata.entries),
          {
            repository: config.repository,
            complete: metadata.complete,
            metadataOnly: true,
          },
        );
        return bound(
          request,
          [match],
          remaining,
          metadata.complete ? "complete" : "incomplete",
          "Eligible retained manifest inventory; inventories do not prove underlying body availability",
        );
      }
      if (request.operation === "read" && !eligible.has(request.selector))
        return answer(
          "denied",
          "Memory identity is outside current Objective, admitted source selectors and verified applicability",
        );
      if (request.operation === "search" && request.selector !== "")
        return answer(
          "denied",
          "Memory search uses the eligible collection selector",
        );
      const results =
        request.operation === "read"
          ? [
              memory.read({
                ...lookup,
                id: request.selector,
                maxBytes: remaining.maxBytes,
              }),
            ].filter((result): result is MemoryResult => result !== undefined)
          : memory
              .search({
                ...lookup,
                query: request.query,
                limit: Math.min(16, remaining.maxResults),
                maxBytes: remaining.maxBytes,
              })
              .filter((result) => eligible.has(result.binding.id));
      if (!results.length)
        return answer(
          metadata.complete ? "no-match" : "incomplete",
          metadata.complete
            ? "No retained match in the admitted eligible memory scope"
            : "Eligible manifest inventory is incomplete; absence remains unknown",
        );
      const disposition: ContextResult["disposition"] = results.some(
        (result) => result.disposition === "unavailable",
      )
        ? "unavailable"
        : results.some((result) => result.disposition === "incomplete") ||
            !metadata.complete ||
            (request.operation === "search" &&
              results.length === Math.min(16, remaining.maxResults))
          ? "incomplete"
          : results.some((result) => result.disposition !== "current")
            ? "stale"
            : "complete";
      return bound(
        request,
        results.map(memoryMatch),
        remaining,
        disposition,
        "Exact retained memory bodies with explicit applicability and freshness; historical leads cannot establish current facts and unavailable or expired references require an explicit unavailable refresh",
      );
    },
  };
}
