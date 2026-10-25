/**
 * `factory diagnostics`: its options, help and check, and what it does.
 */
import { diagnostics } from "../diagnostics.js";
import { configOf, Refusal } from "../host.js";
import { logFiles, runOfFile } from "../log.js";
import type { Paths } from "../paths.js";
import { listAllObjectives } from "../state.js";
import { type Args, type Command, issueCheck, issueOf } from "./shared.js";

export const spec: Command = {
  args: "ISSUE",
  flags: {
    follow: "switch",
    logs: "value",
    summary: "switch",
    run: "value",
    "all-runs": "switch",
    "show-captures": "switch",
    json: "switch",
  },
  help: "Show what an Objective's run did, from its run log: a timeline of steps, waits, repairs, holds and answers, model calls (role, provider, model, time, tokens) and worker activity, relative to the run's start; --follow streams new lines, --logs ITEM shows one Work Item's events in detail with each model call's capture file (--show-captures prints its request and response; capture.enabled keeps them) and each worker attempt's transcript (its tool calls with their targets and the provider's raw output), --summary the totals per role and phase, repairs, holds, the critical path and the slowest steps; the latest run, or --run ID, or --all-runs",
  check: (args, command) => {
    const { flags } = args;
    return (
      issueCheck(args, command) ??
      (flags.summary !== undefined && flags.logs !== undefined
        ? "give one of --summary, --logs, not several"
        : flags.follow !== undefined && flags.summary !== undefined
          ? "--follow goes with the timeline or --logs ITEM, not --summary"
          : flags.run !== undefined && flags["all-runs"] !== undefined
            ? "give --run ID or --all-runs, not both"
            : flags["show-captures"] !== undefined && flags.logs === undefined
              ? "--show-captures goes with --logs ITEM"
              : undefined)
    );
  },
  run: ({ paths, repository, args }) =>
    diagnosticsCommand(paths, repository, args),
};

/** `factory diagnostics ISSUE [--follow] [--logs ITEM [--show-captures]] [--summary] [--run ID | --all-runs] [--json]`. */
async function diagnosticsCommand(
  paths: Paths,
  repository: string,
  args: Args,
): Promise<number> {
  const issue = issueOf(args);
  const runs = logFiles(paths.logs, issue).map(runOfFile);
  if (!runs.length && !listAllObjectives(paths.objectives).includes(issue))
    throw new Refusal(
      "no_factory_state",
      `Factory has no run log or state for #${issue}.`,
    );
  const { flags } = args;
  if (flags.run !== undefined && !runs.includes(flags.run))
    throw new Refusal(
      "no_factory_state",
      `#${issue} has no run ${flags.run} in its run log; its runs: ${runs.join(", ") || "none"}.`,
    );
  await diagnostics(
    {
      logs: paths.logs,
      issue,
      runs:
        flags.run !== undefined
          ? { kind: "run", id: flags.run }
          : flags["all-runs"] !== undefined
            ? { kind: "all" }
            : { kind: "latest" },
      ...(flags.logs !== undefined ? { item: flags.logs } : {}),
      summary: flags.summary !== undefined,
      follow: flags.follow !== undefined,
      captures: flags["show-captures"] !== undefined,
      json: flags.json !== undefined,
      secrets: configOf(repository)?.secrets ?? [],
    },
    (text) => process.stdout.write(text),
  );
  return 0;
}
