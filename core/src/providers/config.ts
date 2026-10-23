/**
 * Named providers: each pairs a planner (plan and every review) with a
 * worker (the work step). The configuration holds any number of them and
 * names one `defaultProvider`; an Objective freezes its provider when it is
 * admitted (selection.ts). Checked once here, when configuration loads.
 */

import type { ClaudePlannerOptions } from "./claude.js";
import type { ClaudeWorkerConfig } from "./claude-worker.js";
import type { CodexEffort } from "./codex.js";
import { PLANNER_PHASES, type PlannerModels } from "./planner.js";

export const PLANNERS = ["codex", "claude", "copilot"] as const;
export type PlannerKind = (typeof PLANNERS)[number];

export const WORKERS = [
  "codex",
  "claude",
  "copilot",
  "openai-agents",
  "claude-managed-agents",
] as const;
export type WorkerKind = (typeof WORKERS)[number];

/** A worker's settings: `kind` plus the adapter's own fields, checked here. */
export type WorkerConfig =
  | { kind: "codex"; network: "off" | "host" }
  /** The Claude worker settings given; the adapter's defaults fill the rest. */
  | { kind: "claude"; settings: Partial<ClaudeWorkerConfig> }
  | {
      kind: "copilot";
      model: string;
      effort: string;
      /** The tool ceiling; the SDK names grep `rg`. */
      tools: string[];
    }
  | {
      kind: "openai-agents";
      model: string;
      effort: "low" | "medium" | "high";
      containerSize: "small" | "medium" | "large";
      /** The controller variable (or service credential) holding the API key. */
      apiKeyEnv: string;
      timeoutSeconds: number;
      /** Hosted runs per Work Item before Factory asks (`more` grants as many again). */
      maxRuns: number;
      /** Tokens per Work Item, across runs, before Factory asks. */
      itemBudgetTokens?: number;
    }
  | {
      kind: "claude-managed-agents";
      agentId: string;
      agentVersion: number;
      environmentId: string;
      workspaceId: string;
      credentialEnv: string;
      /** A positive whole-cent list-cost ceiling per session. */
      budgetCents?: string;
      timeoutSeconds: number;
      /** Hosted runs per Work Item before Factory asks (`more` grants as many again). */
      maxRuns: number;
      /** List cost per Work Item, across runs, before Factory asks. */
      itemBudgetCents?: number;
    };

/** A planner with the model choices given; each adapter has defaults. */
export type ProviderConfig = { worker: WorkerConfig } & (
  | { planner: "claude"; models?: Partial<ClaudePlannerOptions> }
  | { planner: "codex"; models?: Partial<PlannerModels<CodexEffort>> }
  | { planner: "copilot"; models?: Partial<PlannerModels> }
);

export const CLAUDE_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export const CODEX_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "persistent",
] as const satisfies readonly CodexEffort[];
/** The Claude worker's tools: the SDK's file tools and Factory's Validate. */
export const CLAUDE_TOOLS = [
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
  "Validate",
] as const;

export const COPILOT_TOOLS = [
  "view",
  "create",
  "edit",
  "apply_patch",
  "grep",
  "glob",
];

/** A hosted run's limit: well inside the work step's 2-hour deadline. */
export const MAX_HOSTED_SECONDS = 6000;

/** Settings that moved into `providers`. */
const MOVED = [
  ["planning", "provider"],
  ["planning", "models"],
  ["execution", "workerProvider"],
  ["execution", "codexNetwork"],
  ["execution", "claudeWorker"],
] as const;

const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const ENV = /^[A-Z_][A-Z0-9_]*$/;

type Fields = Record<string, unknown>;

/**
 * The `providers` and `defaultProvider` settings, with problems appended.
 * Without `providers` there is one, `codex`, planning and working with
 * Codex.
 */
export function providersConfig(
  raw: Fields,
  problems: string[],
): { providers: Record<string, ProviderConfig>; defaultProvider: string } {
  for (const [section, name] of MOVED)
    if ((raw[section] as Fields | undefined)?.[name] !== undefined)
      problems.push(
        `${section}.${name} is not a setting: name the planner and worker under providers.<name>`,
      );
  if (raw.providers === undefined)
    return {
      providers: {
        codex: { planner: "codex", worker: { kind: "codex", network: "off" } },
      },
      defaultProvider: text(raw.defaultProvider, "codex"),
    };
  const providers: Record<string, ProviderConfig> = {};
  const all = object(raw.providers, "providers", problems);
  for (const [name, value] of Object.entries(all ?? {})) {
    if (!NAME.test(name)) {
      problems.push(
        `providers.${name}: a provider name is lower-case letters, digits and dashes`,
      );
      continue;
    }
    const provider = providerConfig(value, `providers.${name}`, problems);
    if (provider) providers[name] = provider;
  }
  const names = Object.keys(all ?? {});
  if (all && names.length === 0)
    problems.push("providers must name at least one provider");
  const defaultProvider = text(raw.defaultProvider, names[0] ?? "");
  if (names.length && !names.includes(defaultProvider))
    problems.push(
      `defaultProvider ${JSON.stringify(defaultProvider)} is not one of providers (${names.join(", ")})`,
    );
  return { providers, defaultProvider };
}

function providerConfig(
  value: unknown,
  path: string,
  problems: string[],
): ProviderConfig | undefined {
  const provider = object(value, path, problems);
  if (!provider) return undefined;
  known(provider, ["planner", "models", "worker"], path, problems);
  const planner = provider.planner ?? "codex";
  if (!PLANNERS.includes(planner as PlannerKind)) {
    problems.push(`${path}.planner must be one of ${PLANNERS.join(", ")}`);
    return undefined;
  }
  const before = problems.length;
  const models =
    provider.models === undefined
      ? undefined
      : modelsConfig(
          provider.models,
          planner as PlannerKind,
          `${path}.models`,
          problems,
        );
  const worker = workerConfig(
    provider.worker ?? { kind: planner },
    `${path}.worker`,
    problems,
  );
  if (!worker || problems.length !== before) return undefined;
  return {
    planner,
    ...(models ? { models } : {}),
    worker,
  } as ProviderConfig;
}

/**
 * Planner and reviewer model choices, with the keys and efforts of the
 * planner's kind: a choice names both model and effort.
 */
function modelsConfig(
  value: unknown,
  planner: PlannerKind,
  path: string,
  problems: string[],
): Fields | undefined {
  const models = object(value, path, problems);
  if (!models) return undefined;
  const efforts: readonly string[] | undefined =
    planner === "claude"
      ? CLAUDE_EFFORTS
      : planner === "codex"
        ? CODEX_EFFORTS
        : undefined;
  const effort = (entry: unknown, at: string) => {
    if (
      efforts
        ? efforts.includes(entry as string)
        : typeof entry === "string" && entry.trim()
    )
      return;
    problems.push(
      `${at} must be ${efforts ? `one of ${efforts.join(", ")}` : "a non-empty string"}`,
    );
  };
  known(
    models,
    [
      "planner",
      "reviewer",
      "reviewEffort",
      ...(planner === "claude" ? ["maxOutputTokens"] : []),
    ],
    path,
    problems,
  );
  for (const role of ["planner", "reviewer"]) {
    if (models[role] === undefined) continue;
    const at = `${path}.${role}`;
    const choice = object(models[role], at, problems);
    if (!choice) continue;
    known(
      choice,
      ["model", "effort", ...(planner === "codex" ? ["serviceTier"] : [])],
      at,
      problems,
    );
    if (typeof choice.model !== "string" || !choice.model.trim())
      problems.push(`${at}.model must be a non-empty string`);
    effort(choice.effort, `${at}.effort`);
    if (
      choice.serviceTier !== undefined &&
      choice.serviceTier !== "standard" &&
      choice.serviceTier !== "fast"
    )
      problems.push(`${at}.serviceTier must be one of standard, fast`);
  }
  if (models.reviewEffort !== undefined) {
    const at = `${path}.reviewEffort`;
    const phases = object(models.reviewEffort, at, problems);
    for (const [phase, entry] of Object.entries(phases ?? {}))
      if (PLANNER_PHASES.includes(phase as never))
        effort(entry, `${at}.${phase}`);
      else problems.push(`${at}.${phase} is not a setting`);
  }
  const tokens = models.maxOutputTokens;
  if (
    tokens !== undefined &&
    !(Number.isSafeInteger(tokens) && (tokens as number) > 0)
  )
    problems.push(`${path}.maxOutputTokens must be a positive whole number`);
  return models;
}

function workerConfig(
  value: unknown,
  path: string,
  problems: string[],
): WorkerConfig | undefined {
  const worker = object(value, path, problems);
  if (!worker) return undefined;
  const before = problems.length;
  const string = (name: string, pattern?: RegExp): string => {
    const entry = worker[name];
    if (
      typeof entry === "string" &&
      entry.trim() &&
      pattern?.test(entry) !== false
    )
      return entry;
    problems.push(
      `${path}.${name} must be ${pattern ? `a name matching ${pattern.source}` : "a non-empty string"}`,
    );
    return "";
  };
  const oneOf = <T extends string>(
    name: string,
    values: readonly T[],
    fallback?: T,
  ): T => {
    const entry = worker[name] ?? fallback;
    if (values.includes(entry as T)) return entry as T;
    problems.push(`${path}.${name} must be one of ${values.join(", ")}`);
    return values[0]!;
  };
  const whole = (name: string, fallback: number, most: number): number => {
    const entry = worker[name] ?? fallback;
    if (
      Number.isSafeInteger(entry) &&
      (entry as number) > 0 &&
      (entry as number) <= most
    )
      return entry as number;
    problems.push(`${path}.${name} must be a whole number from 1 to ${most}`);
    return fallback;
  };
  const names = <T extends string>(
    name: string,
    values: readonly T[],
    empty: boolean,
  ): T[] => {
    const entry = worker[name];
    if (
      Array.isArray(entry) &&
      (empty || entry.length > 0) &&
      entry.every((item) => values.includes(item as T)) &&
      new Set(entry).size === entry.length
    )
      return entry as T[];
    problems.push(
      `${path}.${name} must be distinct names from ${values.join(", ")}`,
    );
    return [];
  };
  // A hosted run ends before the work step's 2-hour deadline.
  const seconds = () => whole("timeoutSeconds", 3600, MAX_HOSTED_SECONDS);
  const runs = () => whole("maxRuns", 3, 100);
  const optional = (name: string) =>
    worker[name] === undefined
      ? {}
      : { [name]: whole(name, 1, Number.MAX_SAFE_INTEGER) };
  let config: WorkerConfig;
  switch (worker.kind) {
    case "codex":
      known(worker, ["kind", "network"], path, problems);
      config = {
        kind: "codex",
        network: oneOf("network", ["off", "host"], "off"),
      };
      break;
    case "claude": {
      known(
        worker,
        [
          "kind",
          "model",
          "effort",
          "permissionMode",
          "settingSources",
          "tools",
          "allowedTools",
          "maxTurns",
        ],
        path,
        problems,
      );
      const settings: Partial<ClaudeWorkerConfig> = {};
      if (worker.model !== undefined) settings.model = string("model");
      if (worker.effort !== undefined)
        settings.effort = oneOf("effort", CLAUDE_EFFORTS);
      if (worker.permissionMode !== undefined)
        settings.permissionMode = oneOf("permissionMode", [
          "acceptEdits",
          "dontAsk",
        ] as const);
      if (worker.settingSources !== undefined) {
        // Project and local settings are files in the worktree, which the
        // repository or the worker writes; the CLI runs their hooks on the
        // host, outside the sandbox.
        const sources = worker.settingSources;
        if (
          Array.isArray(sources) &&
          sources.some((source) => source === "project" || source === "local")
        )
          problems.push(
            `${path}.settingSources may name only "user": project and local settings come from the worktree, and their hooks would run outside the sandbox`,
          );
        else
          settings.settingSources = names(
            "settingSources",
            ["user"] as const,
            true,
          );
      }
      if (worker.tools !== undefined)
        settings.tools = names("tools", CLAUDE_TOOLS, false);
      if (worker.allowedTools !== undefined) {
        settings.allowedTools = names("allowedTools", CLAUDE_TOOLS, true);
        const offered: readonly string[] = settings.tools ?? CLAUDE_TOOLS;
        if (settings.allowedTools.some((tool) => !offered.includes(tool)))
          problems.push(`${path}.allowedTools must be a subset of tools`);
      }
      if (worker.maxTurns !== undefined)
        settings.maxTurns = whole("maxTurns", 1, Number.MAX_SAFE_INTEGER);
      config = { kind: "claude", settings };
      break;
    }
    case "copilot": {
      known(worker, ["kind", "model", "effort", "tools"], path, problems);
      const tools = worker.tools ?? COPILOT_TOOLS;
      if (
        !Array.isArray(tools) ||
        !tools.length ||
        tools.some((tool) => !COPILOT_TOOLS.includes(tool as string)) ||
        new Set(tools).size !== tools.length
      )
        problems.push(
          `${path}.tools must be distinct names from ${COPILOT_TOOLS.join(", ")}`,
        );
      config = {
        kind: "copilot",
        model: worker.model === undefined ? "gpt-6.1-sol" : string("model"),
        effort: worker.effort === undefined ? "medium" : string("effort"),
        tools: Array.isArray(tools) ? (tools as string[]) : COPILOT_TOOLS,
      };
      break;
    }
    case "openai-agents":
      known(
        worker,
        [
          "kind",
          "model",
          "effort",
          "containerSize",
          "apiKeyEnv",
          "timeoutSeconds",
          "maxRuns",
          "itemBudgetTokens",
        ],
        path,
        problems,
      );
      config = {
        kind: "openai-agents",
        model: string("model"),
        effort: oneOf("effort", ["low", "medium", "high"]),
        containerSize: oneOf("containerSize", ["small", "medium", "large"]),
        apiKeyEnv: string("apiKeyEnv", ENV),
        timeoutSeconds: seconds(),
        maxRuns: runs(),
        ...optional("itemBudgetTokens"),
      };
      break;
    case "claude-managed-agents": {
      known(
        worker,
        [
          "kind",
          "agentId",
          "agentVersion",
          "environmentId",
          "workspaceId",
          "credentialEnv",
          "budgetCents",
          "timeoutSeconds",
          "maxRuns",
          "itemBudgetCents",
        ],
        path,
        problems,
      );
      if (
        !Number.isSafeInteger(worker.agentVersion) ||
        (worker.agentVersion as number) < 1
      )
        problems.push(`${path}.agentVersion must pin a positive agent version`);
      const budget = worker.budgetCents;
      if (
        budget !== undefined &&
        (typeof budget !== "string" || !/^[1-9][0-9]*$/.test(budget))
      )
        problems.push(
          `${path}.budgetCents must be a positive whole-cent string, such as "500"`,
        );
      config = {
        kind: "claude-managed-agents",
        agentId: string("agentId"),
        agentVersion: worker.agentVersion as number,
        environmentId: string("environmentId"),
        workspaceId: string("workspaceId"),
        credentialEnv: string("credentialEnv", ENV),
        ...(typeof budget === "string" ? { budgetCents: budget } : {}),
        timeoutSeconds: seconds(),
        maxRuns: runs(),
        ...optional("itemBudgetCents"),
      };
      break;
    }
    default:
      problems.push(`${path}.kind must be one of ${WORKERS.join(", ")}`);
      return undefined;
  }
  return problems.length === before ? config : undefined;
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function object(
  value: unknown,
  path: string,
  problems: string[],
): Fields | undefined {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Fields;
  problems.push(`${path} must be an object`);
  return undefined;
}

function known(
  value: Fields,
  names: string[],
  path: string,
  problems: string[],
): void {
  for (const key of Object.keys(value))
    if (!names.includes(key)) problems.push(`${path}.${key} is not a setting`);
}
