/**
 * `factory export-captures`: its options, help and check, and what it does.
 */
import { buildExport, sendExport } from "../capture-export.js";
import { configOf, Refusal } from "../host.js";
import { logFiles, runOfFile } from "../log.js";
import type { Paths } from "../paths.js";
import { type Args, type Command, issueCheck, issueOf } from "./shared.js";

export const spec: Command = {
  args: "ISSUE",
  flags: {
    run: "value",
    "all-runs": "switch",
    content: "value",
    endpoint: "value",
    send: "switch",
  },
  help: "Print an Objective's model calls as OpenTelemetry spans (OTLP/HTTP JSON), one request per line, and send nothing: --content metadata (the default; no captured text) or retained (adds the captured request and response, redacted again); --endpoint URL --send posts them to that collector instead (its base URL, HTTPS or loopback HTTP; headers from OTEL_EXPORTER_OTLP_TRACES_HEADERS or OTEL_EXPORTER_OTLP_HEADERS, never shown), in bounded batches; the latest run, or --run ID, or --all-runs",
  check: (args, command) => {
    const { flags } = args;
    const content = flags.content ?? "metadata";
    return (
      issueCheck(args, command) ??
      (content !== "metadata" && content !== "retained"
        ? "--content takes metadata or retained"
        : flags.run !== undefined && flags["all-runs"] !== undefined
          ? "give --run ID or --all-runs, not both"
          : (flags.send !== undefined) !== (flags.endpoint !== undefined)
            ? "a send needs both --endpoint URL and --send"
            : undefined)
    );
  },
  run: ({ paths, repository, args }) => exportCommand(paths, repository, args),
};

/**
 * `factory export-captures ISSUE [--run ID | --all-runs] [--content
 * metadata|retained] [--endpoint URL --send]`: the OTLP requests on
 * stdout, or sent. A send exits 0 only when every batch was fully
 * acknowledged.
 */
async function exportCommand(
  paths: Paths,
  repository: string,
  args: Args,
): Promise<number> {
  const issue = issueOf(args);
  const { flags } = args;
  const runs = logFiles(paths.logs, issue).map(runOfFile);
  if (!runs.length)
    throw new Refusal(
      "no_factory_state",
      `Factory has no run log for #${issue}.`,
    );
  if (flags.run !== undefined && !runs.includes(flags.run))
    throw new Refusal(
      "no_factory_state",
      `#${issue} has no run ${flags.run} in its run log; its runs: ${runs.join(", ")}.`,
    );
  const content = flags.content === "retained" ? "retained" : "metadata";
  const built = buildExport({
    logs: paths.logs,
    repository,
    issue,
    runs:
      flags.run !== undefined
        ? { kind: "run", id: flags.run }
        : flags["all-runs"] !== undefined
          ? { kind: "all" }
          : { kind: "latest" },
    content,
    secrets: configOf(repository)?.secrets ?? [],
  });
  if (typeof built === "string") throw new Refusal("export_refused", built);
  const summary = `${built.spans} model call${built.spans === 1 ? "" : "s"} of #${issue} in ${built.runs.length} run${built.runs.length === 1 ? "" : "s"} · ${content} · ${built.batches.length} batch${built.batches.length === 1 ? "" : "es"}`;
  if (flags.send === undefined) {
    for (const batch of built.batches) process.stdout.write(`${batch}\n`);
    process.stderr.write(
      `Export preview: ${summary} · nothing sent; --endpoint URL --send sends it. Span ids are stable, so a repeat send may duplicate spans at the collector.\n`,
    );
    return 0;
  }
  const receipt = await sendExport(built, flags.endpoint!);
  if (typeof receipt === "string") throw new Refusal("export_refused", receipt);
  process.stdout.write(
    `Export ${receipt.status}: ${summary}, ${receipt.sent} sent to ${receipt.endpoint}${receipt.status === "accepted" ? "" : `; ${JSON.stringify(receipt.results.at(-1))}: check the collector before sending again`}\n`,
  );
  return receipt.status === "accepted" ? 0 : 1;
}
