import {
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { crashPoint } from "./crash.js";
import {
  DEFAULT_LIMITS,
  type EngineLimits,
  ObjectiveRunner,
  type Workflow,
} from "./engine.js";
import type {
  GitHubModule,
  GitHubSync,
  UnreadableObjective,
} from "./github-sync.js";
import { takeServiceLock } from "./lock.js";
import { RunLog, rotateLogs } from "./log.js";
import type { Paths } from "./paths.js";
import { pathsOverlap } from "./planning/graph.js";
import { ACCEPTED_AT } from "./planning/steps.js";
import type { Plan } from "./planning/types.js";
import {
  pendingRequests,
  removeRequest,
  type StoredRequest,
} from "./requests.js";
import {
  listObjectives,
  loadState,
  newObjective,
  type ObjectiveState,
  removeState,
  saveState,
  TERMINAL,
} from "./state.js";
import { built, RERUN } from "./work/steps.js";
import { objectiveWorkflow } from "./workflow.js";

export interface ServeOptions {
  paths: Paths;
  workflow?: Workflow;
  limits?: EngineLimits;
  /** Objectives that may make progress at once (v1: 1). */
  maxActive?: number;
  tickMs?: number;
  /** GitHub queue, display and comments. Absent without configuration. */
  sync?: GitHubSync;
}

const KEEP_REQUEST_IDS = 50;
const RESULT_TTL_MS = 60 * 60 * 1000;

/**
 * `factory serve`: the only writer of Factory state. It returns only when
 * stopped by a signal. It never exits on an Objective's error: every error
 * is a step outcome.
 */
export async function serve(options: ServeOptions): Promise<number> {
  const { paths } = options;
  const workflow = options.workflow ?? objectiveWorkflow();
  const limits = options.limits ?? DEFAULT_LIMITS;
  const maxActive = options.maxActive ?? 1;
  const lock = await takeServiceLock(paths.lockName);
  if (!lock) {
    process.stderr.write("factory: the service is already running\n");
    return 3;
  }
  for (const dir of [paths.objectives, paths.requests, paths.logs])
    mkdirSync(dir, { recursive: true });
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
  const log = new RunLog(paths.logs, runId);
  // Unfinished Objectives, and finished ones until their cleanup and their
  // final sync are done. Other finished ones are read from disk only when a
  // request or the queue names them (rule 6: cost follows active work).
  const runners = new Map<number, ObjectiveRunner>();
  const unreadable = new Map<number, UnreadableObjective>();
  /** Checked Objectives waiting for a slot, as of the last tick. */
  const waitingForSlot = new Set<number>();
  const open = (state: ObjectiveState): ObjectiveRunner => {
    const runner = new ObjectiveRunner(
      state,
      workflow,
      paths.objectives,
      log,
      limits,
    );
    runners.set(state.issue, runner);
    return runner;
  };
  /**
   * The Objective's run: in memory, else read from disk (which may find it
   * unreadable). A read that fails (EMFILE, EIO) throws; nothing is
   * decided on it, and the caller tries again later.
   */
  const find = (issue: number): ObjectiveRunner | undefined => {
    const known = runners.get(issue);
    if (known || unreadable.has(issue)) return known;
    const loaded = loadState(paths.objectives, issue);
    if (loaded?.kind === "unreadable")
      unreadable.set(issue, { error: loaded.error });
    return loaded?.kind === "ok" ? open(loaded.state) : undefined;
  };
  /** State files not read yet because the read failed: tried every tick. */
  const unloaded = new Set<number>();
  const load = (issue: number): void => {
    let runner: ObjectiveRunner | undefined;
    try {
      runner = find(issue);
    } catch (error) {
      if (!unloaded.has(issue))
        log.write(issue, { event: "load-failed", error: String(error) });
      unloaded.add(issue);
      return;
    }
    unloaded.delete(issue);
    // A finished one stays only until its cleanup and its final sync are done.
    if (
      runner &&
      TERMINAL.includes(runner.state.status) &&
      !runner.hasWork &&
      (options.sync?.synced(runner.state) ?? true)
    )
      runners.delete(issue);
  };

  // Only the lock holder writes state, so leftover temporary files are from a crash.
  for (const name of readdirSync(paths.objectives))
    if (name.endsWith(".tmp"))
      rmSync(join(paths.objectives, name), { force: true });
  for (const issue of listObjectives(paths.objectives)) load(issue);
  crashPoint("serve:loaded");

  const applyRequests = (): void => {
    for (const { file, stored } of pendingRequests(paths.requests)) {
      if (!stored) {
        removeRequest(file);
        continue;
      }
      let message: string;
      try {
        message = applyRequest(stored);
      } catch (error) {
        // Not saved: the request file stays and is tried again next tick.
        log.write(stored.request.issue, {
          event: "request-failed",
          id: stored.id,
          error: String(error),
        });
        continue;
      }
      writeResult(paths.requests, stored.id, message);
      crashPoint("requests:applied");
      removeRequest(file);
    }
  };

  const applyRequest = (stored: StoredRequest): string => {
    const { request } = stored;
    const runner = find(request.issue);
    const broken = unreadable.get(request.issue);
    if (!runner && broken) {
      if (
        request.kind !== "cancel" &&
        !(request.kind === "answer" && request.answer === "cancel")
      )
        return `#${request.issue} has unreadable state (${broken.error}). Answers: cancel.`;
      // Start over from a fresh cancelled record that replaces the unreadable
      // file; cleanup closes the Objective's PRs and issue, and the sync
      // replies and shows it cancelled.
      const state = newObjective(request.issue, new Date());
      state.status = "cancelled";
      state.appliedRequests = [{ id: stored.id, message: "ok" }];
      if (broken.github) state.modules.github = broken.github;
      saveState(paths.objectives, state);
      unreadable.delete(request.issue);
      open(state);
      return "ok";
    }
    if (!runner) return `Factory has no Objective #${request.issue}.`;
    const seen = runner.state.appliedRequests.find((r) => r.id === stored.id);
    if (seen) return seen.message;
    // The change and the record that it was applied are saved together.
    const message = runner.transact(() => {
      const state = runner.state;
      let result: string | null = null;
      switch (request.kind) {
        case "cancel":
          result = runner.cancel(stored.by);
          break;
        case "retry":
          result = runner.retryNow(stored.by, request.question);
          break;
        case "answer":
          result = runner.answer(
            request.answer,
            request.text,
            stored.by,
            request.writtenAt,
            request.question,
          );
          break;
      }
      const text = result ?? "ok";
      state.appliedRequests = [
        ...state.appliedRequests,
        { id: stored.id, message: text },
      ].slice(-KEEP_REQUEST_IDS);
      return text;
    });
    log.write(request.issue, {
      event: "request",
      request,
      by: stored.by,
      message,
    });
    return message;
  };

  const tick = (): void => {
    for (const issue of [...unloaded]) load(issue);
    applyRequests();
    // Running steps keep their slot; then started Objectives; then queue order.
    const ordered = [...runners.values()].sort(
      (a, b) =>
        Number(b.busy) - Number(a.busy) ||
        Number(started(b)) - Number(started(a)) ||
        queueOrder(a) - queueOrder(b) ||
        a.state.issue - b.state.issue,
    );
    let slots = maxActive;
    waitingForSlot.clear();
    for (const runner of ordered) {
      const { state } = runner;
      let run = false;
      if (TERMINAL.includes(state.status)) run = runner.hasWork;
      // The check (and a new run's cleanup) runs when the Objective is first
      // seen, slot or not (rule 7); planning and building need a slot.
      else if (!state.done.check) run = true;
      else if (runner.busy) {
        // Running steps keep their slot, even while another step's question is open.
        slots -= 1;
        run = true;
      } else if (runner.held)
        // Questions that stop every step it could start take no slot;
        // settle an interrupted attempt, which may open a hold.
        run = Object.keys(state.attempts).length > 0;
      // A wait on a human gate (an approval, a required review) has no
      // deadline, so it takes no slot: it polls, and its paths stay owned.
      else if (gated(runner, workflow)) run = true;
      // Waiting on another Objective's paths takes no slot either, so a hold
      // that owns common paths can't stall the queue (rule 1).
      else if (waitsOnPaths(runner, ordered)) run = false;
      else if (slots > 0) {
        slots -= 1;
        run = true;
      } else waitingForSlot.add(state.issue);
      if (!run) continue;
      try {
        runner.tick();
      } catch (error) {
        // A failed save: that Objective's state stays as on disk and is tried again next tick.
        log.write(state.issue, {
          event: "tick-failed",
          error: String(error),
        });
      }
    }
    options.sync?.tick({
      runners,
      unreadable,
      requestsDir: paths.requests,
      waitingForSlot: (issue) => waitingForSlot.has(issue),
      find,
      admit: (issue: number, github: GitHubModule) => {
        const previous = find(issue);
        if (unreadable.has(issue)) return; // never over an unreadable file
        // Never over an unfinished run, nor one whose cleanup still runs.
        if (
          previous &&
          (!TERMINAL.includes(previous.state.status) || previous.hasWork)
        )
          return;
        // A run again after the operator queued a finished one: the old run
        // stops for good (its steps, its saves, its sync jobs) before the new
        // one exists, so only one run ever writes the file.
        previous?.stop();
        options.sync?.forget(issue);
        const state = newObjective(issue, new Date());
        state.modules.github = github;
        // The earlier run's PRs and worktrees go before the new run plans.
        if (previous) state.kept[RERUN] = true;
        saveState(paths.objectives, state);
        crashPoint("serve:admitted");
        open(state);
        log.write(issue, { event: "admitted", again: Boolean(previous) });
      },
      withdraw: (issue: number) => {
        const runner = runners.get(issue);
        if (
          !runner ||
          runner.busy ||
          TERMINAL.includes(runner.state.status) ||
          !unstarted(runner.state)
        )
          return false;
        // Dequeued before planning: the run goes as if never admitted, so
        // queuing it again checks it afresh.
        removeState(paths.objectives, issue);
        crashPoint("serve:withdrawn");
        runner.stop();
        runners.delete(issue);
        options.sync?.forget(issue);
        log.write(issue, { event: "withdrawn" });
        return true;
      },
      result: (id: string) => readResult(paths.requests, id),
    });
    // A finished Objective leaves memory once its cleanup and its final
    // sync are done; a request or a re-queue reads it again from disk.
    for (const runner of [...runners.values()]) {
      const issue = runner.state.issue;
      if (
        TERMINAL.includes(runner.state.status) &&
        !runner.hasWork &&
        (options.sync?.idle(issue) ?? true)
      ) {
        runners.delete(issue);
        options.sync?.forget(issue);
      }
    }
    writeHeartbeat(paths.root, runId, unreadable);
  };

  let stopping = false;
  const stop = (): void => {
    stopping = true;
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  // A stray rejection must not end the service: log it and keep serving.
  process.on("unhandledRejection", (reason) =>
    log.write(0, { event: "unhandled-rejection", error: String(reason) }),
  );
  const housekeeping = (): void => {
    try {
      rotateLogs(paths.logs);
      sweepResults(paths.requests);
    } catch (error) {
      log.write(0, { event: "housekeeping-failed", error: String(error) });
    }
  };
  housekeeping();
  let lastHousekeeping = Date.now();
  while (!stopping) {
    try {
      tick();
    } catch (error) {
      // A bug in the loop itself: log it and keep serving.
      log.write(0, { event: "loop-error", error: String(error) });
    }
    if (Date.now() - lastHousekeeping > RESULT_TTL_MS) {
      housekeeping();
      lastHousekeeping = Date.now();
    }
    await new Promise((resolve) => setTimeout(resolve, options.tickMs ?? 1000));
  }
  lock.close();
  return 0;
}

/**
 * An Objective builds only while no earlier unfinished Objective owns an
 * overlapping path; planning never waits. Earlier means its plan was
 * accepted earlier: an Objective still planning owns nothing yet, and once
 * its plan lands it waits on every plan accepted before it, so two
 * Objectives never build overlapping paths at once.
 */
function waitsOnPaths(
  runner: ObjectiveRunner,
  all: readonly ObjectiveRunner[],
): boolean {
  const mine = ownedPaths(runner.state);
  if (!mine.length || built(runner.state)) return false;
  const at = acceptedAt(runner.state);
  return all.some((other) => {
    if (other === runner) return false;
    if (TERMINAL.includes(other.state.status) || built(other.state))
      return false;
    const theirs = ownedPaths(other.state);
    if (!theirs.length) return false;
    const when = acceptedAt(other.state);
    if (when > at || (when === at && other.state.issue > runner.state.issue))
      return false;
    return mine.some((a) => theirs.some((b) => pathsOverlap(a, b)));
  });
}

function ownedPaths(state: ObjectiveState): string[] {
  const plan = state.done.plan as Plan | undefined;
  return plan ? plan.items.flatMap((item) => item.ownedPaths) : [];
}

/** When the Objective's plan was accepted (planning/steps.ts keeps it). */
function acceptedAt(state: ObjectiveState): string {
  return (state.kept?.[ACCEPTED_AT] as string | undefined) ?? "";
}

/**
 * Whether every step left to run waits on a human gate, or on an open
 * question: nothing it can do until a person acts.
 */
function gated(runner: ObjectiveRunner, workflow: Workflow): boolean {
  const steps = workflow.steps(runner.state);
  return (
    steps.length > 0 &&
    steps.every(
      (step) =>
        runner.state.retries[step.key]?.wait?.kind === "gate" ||
        runner.heldBy(step.key),
    )
  );
}

/** Not started: nothing past the check (and a re-run's cleanup) has run or begun. */
function unstarted(state: ObjectiveState): boolean {
  const early = (key: string) => key === "check" || key === "rerun:cleanup";
  return (
    !state.kept?.[RERUN] &&
    [
      ...Object.keys(state.done),
      ...Object.keys(state.retries),
      ...Object.keys(state.attempts),
    ].every(early)
  );
}

function started(runner: ObjectiveRunner): boolean {
  return (
    runner.busy || Object.keys(runner.state.done).some((key) => key !== "check")
  );
}

/** The Project's order number, read again on every queue read until it starts. */
function queueOrder(runner: ObjectiveRunner): number {
  return (
    (runner.state.modules.github as GitHubModule | undefined)?.order ??
    Number.MAX_SAFE_INTEGER
  );
}

function readResult(dir: string, id: string): string | undefined {
  try {
    return readFileSync(join(dir, `${id}.result`), "utf8").trim();
  } catch {
    return undefined;
  }
}

/** Write the result whole, and only once: a request re-read after a crash keeps its first result. */
function writeResult(dir: string, id: string, message: string): void {
  const temporary = join(dir, `.${id}.result.tmp`);
  try {
    writeFileSync(temporary, `${message}\n`);
    linkSync(temporary, join(dir, `${id}.result`));
  } catch {
    // Already written.
  } finally {
    rmSync(temporary, { force: true });
  }
}

function sweepResults(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - RESULT_TTL_MS;
  for (const name of names) {
    if (!name.endsWith(".result") && !name.endsWith(".tmp")) continue;
    const path = join(dir, name);
    try {
      if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
    } catch {
      // Already gone.
    }
  }
}

function writeHeartbeat(
  root: string,
  runId: string,
  unreadable: Map<number, UnreadableObjective>,
): void {
  try {
    writeFileSync(
      join(root, "service.json"),
      JSON.stringify({
        pid: process.pid,
        runId,
        at: new Date().toISOString(),
        unreadable: Object.fromEntries(
          [...unreadable].map(([issue, entry]) => [issue, entry.error]),
        ),
      }),
    );
  } catch {
    // Status falls back to the lock probe.
  }
}
