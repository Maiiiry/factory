#!/usr/bin/env node
import { existsSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { type CoreConfig, configPath, loadConfig } from "./config.js";
import { DEFAULT_LIMITS, type EngineLimits, hostLimits } from "./engine.js";
import { GitHub } from "./github.js";
import { GitHubSync } from "./github-sync.js";
import { RunLog } from "./log.js";
import { installationPaths, type Paths } from "./paths.js";
import {
  ClaudePlanner,
  type ClaudePlannerOptions,
  DEFAULT_CLAUDE_MODELS,
} from "./providers/claude.js";
import { ClaudeWorker } from "./providers/claude-worker.js";
import { CodexPlanner, DEFAULT_CODEX_MODELS } from "./providers/codex.js";
import { CodexWorker } from "./providers/codex-worker.js";
import { HedgedPlanner } from "./providers/planner.js";
import { type Request, writeRequest } from "./requests.js";
import { serve } from "./service.js";
import {
  type Hold,
  listObjectives,
  loadState,
  type ObjectiveState,
  type ObjectiveStatus,
} from "./state.js";
import { objectiveWorkflow } from "./workflow.js";

type Provider = CoreConfig["planning"]["provider"];

const USAGE = `Usage: factory <command> --repo OWNER/NAME

  serve                          Run the service (the only writer of state)
  status [ISSUE] [--json]        Show Objectives and open questions
  answer ISSUE ANSWER [--question ID] [--text T]
                                 Answer the question ID (default: the oldest open one)
  cancel ISSUE                   Cancel an Objective
  retry ISSUE [--question ID]    Retry an Objective's waiting steps now, or
                                 answer retry to an open question
`;

interface StatusRow {
  issue: number;
  status: ObjectiveStatus | "unreadable";
  /** Open questions, oldest first. */
  holds: Hold[];
  waiting: {
    step: string;
    nextAt: string;
    lastError: string;
    since: string;
    /** A person outside Factory the step waits on, such as an environment approval. */
    gate?: string;
  }[];
  error?: string;
}

async function main(argv: string[]): Promise<number> {
  const args = parse(argv);
  const command = args.positional[0];
  if (!command || command === "help") {
    process.stdout.write(USAGE);
    return command ? 0 : 2;
  }
  const repository = args.flags.repo ?? process.env.FACTORY_REPOSITORY;
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    process.stderr.write("factory: give --repo OWNER/NAME\n");
    return 2;
  }
  const paths = installationPaths(repository);
  switch (command) {
    case "serve": {
      const limits = envLimits();
      let sync: GitHubSync | undefined;
      let loaded: CoreConfig | undefined;
      let workflow = objectiveWorkflow();
      if (existsSync(configPath(repository))) {
        const config = loadConfig(repository);
        loaded = config;
        const github = new GitHub(
          config.repository,
          process.env.FACTORY_GITHUB_API,
        ).redacting(
          config.policy.allowedSecretNames.flatMap(
            (name) => process.env[name] ?? [],
          ),
        );
        sync = new GitHubSync(
          github,
          config,
          new RunLog(paths.logs, "sync"),
          limits,
        );
        // Each provider's planner, made when an Objective first needs it.
        const planners = new Map<Provider, HedgedPlanner>();
        const plannerOf = (provider: Provider): HedgedPlanner => {
          let planner = planners.get(provider);
          if (planner) return planner;
          // Configured models belong to the planning provider; a switched
          // Objective uses the other provider's defaults.
          const models =
            provider === config.planning.provider
              ? (config.planning.models ?? {})
              : {};
          planner = new HedgedPlanner(
            provider === "claude"
              ? new ClaudePlanner({
                  ...DEFAULT_CLAUDE_MODELS,
                  ...models,
                } as ClaudePlannerOptions)
              : new CodexPlanner({
                  ...DEFAULT_CODEX_MODELS,
                  ...models,
                } as typeof DEFAULT_CODEX_MODELS),
          );
          planners.set(provider, planner);
          return planner;
        };
        const switched = (state: ObjectiveState): Provider | undefined => {
          const provider = state.kept?.provider;
          return provider === "claude" || provider === "codex"
            ? provider
            : undefined;
        };
        workflow = objectiveWorkflow({
          config,
          github,
          planner: (state) =>
            plannerOf(switched(state) ?? config.planning.provider),
          workDir: (issue) => join(paths.root, "work", String(issue)),
          worker: (state, plan, body) =>
            (switched(state) ?? config.execution.workerProvider) === "claude"
              ? new ClaudeWorker({
                  sandbox: config.sandbox,
                  plan,
                  body,
                  repository: config.repository,
                  config: config.execution.claudeWorker,
                  allowedSecretNames: config.policy.allowedSecretNames,
                })
              : new CodexWorker({
                  sandbox: config.sandbox,
                  network: config.execution.codexNetwork,
                  allowedSecretNames: config.policy.allowedSecretNames,
                }),
        });
      }
      if (loaded)
        hostLimits.configure({
          worker: loaded.execution.workers,
          cpu: loaded.execution.validations,
        });
      return await serve({
        paths,
        workflow,
        ...(loaded ? { maxActive: loaded.queue.maxActiveObjectives } : {}),
        ...(sync ? { sync } : {}),
        ...(process.env.FACTORY_TICK_MS
          ? { tickMs: Number(process.env.FACTORY_TICK_MS) }
          : {}),
        limits: {
          ...limits,
          ...(loaded
            ? {
                concurrency: loaded.execution.concurrency,
                maxRepairs: loaded.execution.repairs,
              }
            : {}),
        },
      });
    }
    case "status":
      return await status(paths, args);
    case "answer":
    case "cancel":
    case "retry":
      return await request(paths, command, args);
    default:
      process.stderr.write(USAGE);
      return 2;
  }
}

/**
 * The engine's limits, with shorter timings from the environment for
 * tests: FACTORY_BACKOFF_MS (first backoff), FACTORY_WAIT_MS (transient
 * budget), FACTORY_NOTE_MS (status note), FACTORY_REMIND_MS (gate
 * reminder), FACTORY_DEADLINE_MS (a cap on step deadlines).
 */
function envLimits(): EngineLimits {
  const env = (name: string): number | undefined => {
    const value = Number(process.env[name]);
    return process.env[name] && Number.isFinite(value) && value >= 0
      ? value
      : undefined;
  };
  const set = <K extends keyof EngineLimits>(key: K, name: string) => {
    const value = env(name);
    return value === undefined ? {} : { [key]: value };
  };
  return {
    ...DEFAULT_LIMITS,
    ...set("baseBackoffMs", "FACTORY_BACKOFF_MS"),
    ...set("maxWaitMs", "FACTORY_WAIT_MS"),
    ...set("noteAfterMs", "FACTORY_NOTE_MS"),
    ...set("remindAfterMs", "FACTORY_REMIND_MS"),
    ...set("maxDeadlineMs", "FACTORY_DEADLINE_MS"),
  };
}

async function status(paths: Paths, args: Args): Promise<number> {
  const only = args.positional[1] ? Number(args.positional[1]) : undefined;
  const rows: StatusRow[] = [];
  for (const issue of listObjectives(paths.objectives)) {
    if (only !== undefined && issue !== only) continue;
    let loaded: ReturnType<typeof loadState>;
    try {
      loaded = loadState(paths.objectives, issue);
    } catch (error) {
      process.stderr.write(`#${issue}: can't read its state now: ${error}\n`);
      continue;
    }
    if (!loaded) continue;
    if (loaded.kind === "unreadable") {
      rows.push({
        issue,
        status: "unreadable",
        holds: [
          {
            id: "unreadable",
            step: "state",
            question: `Factory can't read this Objective's state (${loaded.error}).`,
            answers: ["cancel"],
            recommended: "cancel",
            askedAt: "",
          },
        ],
        waiting: [],
        error: loaded.error,
      });
      continue;
    }
    const { state } = loaded;
    rows.push({
      issue,
      status: state.status,
      holds: state.holds,
      waiting: Object.entries(state.retries).map(([step, retry]) => ({
        step,
        nextAt: retry.nextAt,
        lastError: retry.lastError,
        since: retry.since,
        ...(retry.wait?.kind === "gate" ? { gate: retry.wait.gate } : {}),
      })),
    });
  }
  const live = await serviceLive(paths);
  if (args.flags.json !== undefined) {
    process.stdout.write(
      `${JSON.stringify({ service: live ? "running" : "stopped", objectives: rows }, null, 2)}\n`,
    );
    return 0;
  }
  const lines = [`Service: ${live ? "running" : "stopped"}`];
  if (rows.length === 0) lines.push("No Objectives.");
  for (const row of rows) {
    lines.push(`#${row.issue}: ${row.status}`);
    for (const hold of row.holds)
      lines.push(
        `  Question ${hold.id}${hold.item ? ` (Work Item ${hold.item})` : ""}: ${hold.question}`,
        `  Answers: ${hold.answers.join(", ")} (recommended: ${hold.recommended})`,
        `  Answer with: factory answer ${row.issue} <answer> --question ${hold.id}`,
      );
    for (const wait of row.waiting)
      lines.push(
        wait.gate
          ? `  Waiting on ${wait.gate} (${wait.step}, since ${wait.since})`
          : `  Waiting: ${wait.step} retries at ${wait.nextAt} (${wait.lastError})`,
      );
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

async function request(
  paths: Paths,
  command: "answer" | "cancel" | "retry",
  args: Args,
): Promise<number> {
  const issue = Number(args.positional[1]);
  if (!Number.isInteger(issue) || issue <= 0) {
    process.stderr.write(`factory: ${command} needs an issue number\n`);
    return 2;
  }
  let body: Request;
  if (command === "answer") {
    const answer = args.positional[2];
    if (!answer) {
      process.stderr.write("factory: answer needs an answer\n");
      return 2;
    }
    body = {
      kind: "answer",
      issue,
      answer,
      ...(args.flags.text ? { text: args.flags.text } : {}),
      ...(args.flags.question ? { question: args.flags.question } : {}),
    };
  } else if (command === "retry")
    body = {
      kind: "retry",
      issue,
      ...(args.flags.question ? { question: args.flags.question } : {}),
    };
  else body = { kind: command, issue };
  const by = process.env.USER ?? "operator";
  const id = writeRequest(paths.requests, body, by);
  if (!(await serviceLive(paths))) {
    process.stdout.write(
      "The service isn't running; the request will apply when it starts.\n",
    );
    return 0;
  }
  const result = join(paths.requests, `${id}.result`);
  for (let i = 0; i < 100; i++) {
    if (i % 10 === 9 && !(await serviceLive(paths))) {
      process.stdout.write(
        "The service stopped; the request will apply when it starts again.\n",
      );
      return 0;
    }
    if (existsSync(result)) {
      const message = readFileSync(result, "utf8").trim();
      rmSync(result, { force: true });
      process.stdout.write(`${message === "ok" ? "Done." : message}\n`);
      return message === "ok" ? 0 : 1;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  process.stdout.write("Sent; the service hasn't applied it yet.\n");
  return 0;
}

/** The service holds its abstract socket while it lives. */
async function serviceLive(paths: Paths): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = connect(paths.lockName);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

interface Args {
  positional: string[];
  flags: Record<string, string>;
}

function parse(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (name === "json") flags.json = "";
    else if (next !== undefined) {
      flags[name] = next;
      i++;
    }
  }
  return { positional, flags };
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(
      `factory: ${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exit(1);
  },
);
