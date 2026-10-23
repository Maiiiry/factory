import { crashPoint } from "./crash.js";
import type { RunLog } from "./log.js";
import {
  type Answer,
  type ObjectiveState,
  type ObjectiveStatus,
  type Retry,
  saveState,
  TERMINAL,
  type Wait,
} from "./state.js";
import { errorMessage } from "./text.js";

/** What a step reports. Every step ends in exactly one of these. */
export type Outcome =
  | {
      kind: "done";
      result?: unknown;
      /** Facts that outlive repairs, such as the heads already pushed (`state.kept`). */
      keep?: Record<string, unknown>;
    }
  /**
   * Try again. `afterMs: -1` is an error (an escaped exception, a missed
   * deadline, an idle model or an invalid answer): three in a row hold.
   * Anything else is a wait, classed by `wait` (CORE.md#Waits).
   */
  | {
      kind: "retry";
      reason: string;
      afterMs?: number;
      wait?: Wait;
      keep?: Record<string, unknown>;
    }
  | {
      kind: "hold";
      question: string;
      answers: string[];
      recommended: string;
      keep?: Record<string, unknown>;
    }
  /** The step can't succeed as planned. */
  | { kind: "fail"; reason: string }
  /**
   * The work is wrong (validation, review or CI refused it): clear `clear`
   * from the finished steps and run `target` again with the finding, within
   * the repair budget.
   */
  | {
      kind: "repair";
      finding: string;
      target: string;
      clear: string[];
      keep?: Record<string, unknown>;
    };

/** A question for the operator; the first answer is recommended unless another is named. */
export function hold(
  question: string,
  answers = ["retry", "cancel"],
  recommended = answers[0]!,
): Extract<Outcome, { kind: "hold" }> {
  return { kind: "hold", question, answers, recommended };
}

export interface StepContext {
  /** A copy: steps read state, the engine writes it. */
  readonly state: ObjectiveState;
  /** The answer to this step's last hold, until the step finishes. */
  readonly answer?: Answer;
  readonly signal: AbortSignal;
  log(event: Record<string, unknown>): void;
}

export interface Step {
  /** Stable for the Objective, such as `plan` or `item:a:work`. */
  readonly key: string;
  readonly deadlineMs: number;
  /** A host-wide limit this step counts against: model-bound workers or CPU-heavy validation. */
  readonly resource?: HostResource;
  run(context: StepContext): Promise<Outcome>;
}

/** What to do next. Both functions are pure functions of the state. */
export interface Workflow {
  steps(state: ObjectiveState): Step[];
  /** The status of a state that isn't holding or terminal. */
  status(state: ObjectiveState): ObjectiveStatus;
  /** The model providers configured, for the `switch` answer to a usage limit. */
  readonly providers?: readonly string[];
}

export type HostResource = "worker" | "cpu";

/**
 * Host-wide caps shared by every Objective in the service: how many worker
 * runs and how many CPU-heavy steps (validation) run at once.
 */
export class HostLimiter {
  private readonly used: Record<HostResource, number> = { worker: 0, cpu: 0 };
  constructor(private caps: Record<HostResource, number>) {}

  configure(caps: Record<HostResource, number>): void {
    this.caps = caps;
  }

  acquire(resource: HostResource): boolean {
    if (this.used[resource] >= this.caps[resource]) return false;
    this.used[resource] += 1;
    return true;
  }

  release(resource: HostResource): void {
    this.used[resource] = Math.max(0, this.used[resource] - 1);
  }

  usage(): Record<HostResource, number> {
    return { ...this.used };
  }
}

/** The service's limiter; `serve` sets its caps from configuration. */
export const hostLimits = new HostLimiter({ worker: 2, cpu: 2 });

export interface EngineLimits {
  /** Escaped errors and missed deadlines in a row before a step holds. */
  maxErrors: number;
  /** Repairs of one target before Factory asks. */
  maxRepairs: number;
  /**
   * How long an unknown transient cause is retried before Factory asks, and
   * the longest reset a limit is waited for without asking.
   */
  maxWaitMs: number;
  /** When a transient wait gets a status note on the issue. */
  noteAfterMs: number;
  /** When a human gate gets a reminder comment; how long `wait` lasts on a limit with no reset time. */
  remindAfterMs: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  /** Steps running at once for one Objective. */
  concurrency: number;
  /** A cap on every step's deadline (tests shorten it). */
  maxDeadlineMs?: number;
}

const HOUR = 60 * 60 * 1000;

export const DEFAULT_LIMITS: EngineLimits = {
  maxErrors: 3,
  maxRepairs: 6,
  maxWaitMs: 3 * HOUR,
  noteAfterMs: HOUR,
  remindAfterMs: 24 * HOUR,
  baseBackoffMs: 30_000,
  maxBackoffMs: 15 * 60 * 1000,
  concurrency: 2,
};

const ERROR_ANSWERS = ["retry", "cancel"];
/** Answers the engine applies itself, for its own wait questions. */
const WAIT = "wait";
const SWITCH = "switch";

interface Running {
  token: number;
  controller: AbortController;
}

const INTERRUPTED = "the service stopped during this step";

/**
 * Runs one Objective's steps. All state changes happen here, synchronously,
 * one at a time, and each is saved before the next begins. A step's start is
 * saved too, so a step that never finishes (because the process died) counts
 * as an error after a restart and holds after `maxErrors`.
 */
export class ObjectiveRunner {
  private readonly running = new Map<string, Running>();
  private nextToken = 1;
  /** Replaced by a new run of the same Objective: it never saves again. */
  private stopped = false;
  /** Effects outside the state, run only once the change is saved. */
  private afterSave: (() => void)[] = [];

  constructor(
    public state: ObjectiveState,
    private readonly workflow: Workflow,
    private readonly dir: string,
    private readonly log: RunLog,
    private readonly limits: EngineLimits = DEFAULT_LIMITS,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get busy(): boolean {
    return this.running.size > 0;
  }

  /** Whether this Objective has steps to run: cleanup after cancel counts. */
  get hasWork(): boolean {
    return this.busy || this.workflow.steps(this.state).length > 0;
  }

  /**
   * Run `change` against the state and save it. If anything throws, the
   * in-memory state goes back to what is on disk, so memory never claims
   * what a save didn't keep.
   */
  transact<T>(change: () => T): T {
    if (this.stopped)
      throw new Error(`#${this.state.issue}'s run was replaced`);
    const before = structuredClone(this.state);
    this.afterSave = [];
    try {
      const result = change();
      this.save();
      const effects = this.afterSave;
      this.afterSave = [];
      for (const effect of effects) effect();
      return result;
    } catch (error) {
      this.state = before;
      this.afterSave = [];
      throw error;
    }
  }

  /** Start every runnable step that isn't running or waiting to retry. */
  tick(): void {
    // An attempt saved as started but not running here was interrupted:
    // by a restart, or by a save that failed after the step finished.
    for (const key of Object.keys(this.state.attempts))
      if (!this.running.has(key))
        this.apply(key, { kind: "retry", reason: INTERRUPTED, afterMs: -1 });
    if (this.state.status === "holding") return;
    const now = this.now().getTime();
    for (const step of this.workflow.steps(this.state)) {
      if (this.running.size >= this.limits.concurrency) return;
      if (this.running.has(step.key)) continue;
      const retry = this.state.retries[step.key];
      if (retry && Date.parse(retry.nextAt) > now) continue;
      if (step.resource && !hostLimits.acquire(step.resource)) continue;
      try {
        this.start(step);
      } catch (error) {
        if (step.resource) hostLimits.release(step.resource);
        throw error;
      }
    }
  }

  private start(step: Step): void {
    this.transact(() => {
      this.state.attempts[step.key] = { startedAt: this.now().toISOString() };
    });
    crashPoint(`engine:${step.key}:started`);
    const token = this.nextToken++;
    const controller = new AbortController();
    this.running.set(step.key, { token, controller });
    const answer = this.state.answers[step.key];
    const context: StepContext = {
      state: structuredClone(this.state),
      ...(answer ? { answer } : {}),
      signal: controller.signal,
      log: (event) =>
        this.log.write(this.state.issue, { step: step.key, ...event }),
    };
    this.log.write(this.state.issue, { step: step.key, event: "start" });
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<Outcome>((resolve) => {
      timer = setTimeout(
        () => {
          controller.abort(new Error("deadline"));
          resolve({ kind: "retry", reason: "deadline", afterMs: -1 });
        },
        Math.min(step.deadlineMs, this.limits.maxDeadlineMs ?? Infinity),
      );
    });
    const run = (async () => step.run(context))().catch(
      (error: unknown): Outcome =>
        // A full disk needs a person; retrying can't free it.
        (error as NodeJS.ErrnoException | null)?.code === "ENOSPC"
          ? hold(
              `The service host's disk is full (${errorMessage(error)}). Free space, then answer retry; or cancel.`,
            )
          : {
              kind: "retry",
              reason: `error: ${errorMessage(error)}`,
              afterMs: -1,
            },
    );
    void Promise.race([run, deadline]).then((outcome) => {
      clearTimeout(timer);
      // Released once per start, even when cancel already dropped the step.
      if (step.resource) hostLimits.release(step.resource);
      if (this.running.get(step.key)?.token !== token) return;
      this.running.delete(step.key);
      try {
        this.apply(step.key, outcome);
      } catch (error) {
        // The save failed and the state went back to disk, where the
        // attempt is still open: the next tick retries it as interrupted.
        this.log.write(this.state.issue, {
          step: step.key,
          event: "apply-failed",
          error: String(error),
        });
      }
    });
  }

  /**
   * Apply one outcome and save. `afterMs: -1` marks an escaped error, missed
   * deadline or interrupted attempt, which counts toward `maxErrors`; other
   * retries are waits (see `retry`). Throws only if the save fails, after
   * putting the state back as it is on disk.
   */
  apply(key: string, outcome: Outcome): void {
    const terminal = TERMINAL.includes(this.state.status);
    if (
      terminal &&
      !this.workflow.steps(this.state).some((s) => s.key === key)
    ) {
      // A step from before cancel: drop its outcome and its open attempt.
      this.log.write(this.state.issue, {
        step: key,
        event: "ignored",
        outcome: outcome.kind,
      });
      if (this.state.attempts[key])
        this.transact(() => {
          delete this.state.attempts[key];
        });
      return;
    }
    crashPoint(`engine:${key}:before-apply`);
    this.transact(() => this.applyChange(key, outcome));
    this.log.write(this.state.issue, {
      step: key,
      event: "outcome",
      outcome: outcome.kind,
      ...("reason" in outcome ? { reason: outcome.reason } : {}),
    });
    crashPoint(`engine:${key}:applied`);
  }

  private applyChange(key: string, outcome: Outcome): void {
    const state = this.state;
    const now = this.now();
    delete state.attempts[key];
    if ("keep" in outcome && outcome.keep) {
      state.kept ??= {};
      Object.assign(state.kept, outcome.keep);
    }
    if (TERMINAL.includes(state.status) && outcome.kind !== "done") {
      // Cleanup after the end never asks and never blocks: it retries in
      // the background with the usual backoff.
      const previous = state.retries[key];
      const attempts = (previous?.attempts ?? 0) + 1;
      const backoff = Math.min(
        this.limits.baseBackoffMs * 2 ** (attempts - 1),
        this.limits.maxBackoffMs,
      );
      state.retries[key] = {
        count: (previous?.count ?? 0) + 1,
        attempts,
        since: previous?.since ?? now.toISOString(),
        nextAt: new Date(now.getTime() + backoff).toISOString(),
        lastError:
          "reason" in outcome
            ? outcome.reason
            : "question" in outcome
              ? outcome.question
              : outcome.finding,
      };
      return;
    }
    switch (outcome.kind) {
      case "done":
        state.done[key] = outcome.result ?? true;
        delete state.retries[key];
        delete state.answers[key];
        if (TERMINAL.includes(state.status)) break;
        // Another step's question may be open: keep holding, and resume
        // to the status this step's progress gives.
        if (state.status === "holding")
          state.resumeStatus = this.workflow.status(state);
        else state.status = this.workflow.status(state);
        break;
      case "retry":
        this.retry(key, outcome);
        break;
      case "hold":
        this.hold(key, outcome.question, outcome.answers, outcome.recommended);
        break;
      case "fail":
        this.hold(
          key,
          `Step ${key} failed: ${outcome.reason}`,
          ERROR_ANSWERS,
          "retry",
        );
        break;
      case "repair": {
        delete state.retries[key];
        for (const cleared of outcome.clear) {
          delete state.done[cleared];
          delete state.answers[cleared];
          delete state.attempts[cleared];
          if (cleared !== outcome.target) delete state.retries[cleared];
        }
        this.abortRunning(outcome.clear);
        state.repairs ??= {};
        const repair = state.repairs[outcome.target] ?? {
          count: 0,
          findings: [],
        };
        repair.count += 1;
        repair.findings = [...repair.findings, outcome.finding].slice(-10);
        state.repairs[outcome.target] = repair;
        // Over budget: ask, on the step that would repair. Each `retry` allows one more.
        if (
          repair.count > this.limits.maxRepairs &&
          state.answers[outcome.target]?.answer !== "retry"
        )
          this.hold(
            outcome.target,
            `${outcome.target} has been repaired ${repair.count - 1} times and still fails:\n\n${outcome.finding}\n\n\`retry\` allows one more repair.`,
            ERROR_ANSWERS,
            "retry",
          );
        break;
      }
    }
  }

  /**
   * A retry: an error counts toward `maxErrors`; a wait is classed by its
   * cause (CORE.md#Waits). The error count covers one run of consecutive
   * errors: any other outcome ends it. `since`, `cause`, the backoff and a
   * granted `wait` cover one run of one class (a reset, a gate, or an
   * unknown cause, which errors share): a new class starts them again, so
   * a long gate never spends the transient budget. Times are wall-clock
   * times saved in the state, so a restart doesn't reset a budget and a
   * suspended host doesn't spend it twice: the question comes only after
   * the step ran again and still had to wait.
   */
  private retry(
    key: string,
    outcome: Extract<Outcome, { kind: "retry" }>,
  ): void {
    const state = this.state;
    const now = this.now().getTime();
    const wait = outcome.wait;
    const isError = outcome.afterMs === -1;
    const before = state.retries[key];
    // The run of retries this one continues, if it is of the same class.
    const previous =
      before && waitClass(before.wait) === waitClass(wait) ? before : undefined;
    const attempts = (previous?.attempts ?? 0) + 1;
    const since = previous?.since ?? new Date(now).toISOString();
    const count = isError ? (previous?.count ?? 0) + 1 : 0;
    const backoff = Math.min(
      this.limits.baseBackoffMs * 2 ** (attempts - 1),
      this.limits.maxBackoffMs,
    );
    const granted =
      previous?.grantedUntil !== undefined &&
      now < Date.parse(previous.grantedUntil);
    let nextAt =
      outcome.afterMs !== undefined && outcome.afterMs >= 0
        ? now + outcome.afterMs
        : now + backoff;
    let question: { text: string; answers: string[] } | undefined;
    if (isError) {
      if (count >= this.limits.maxErrors)
        question = {
          text: `Step ${key} keeps failing (${outcome.reason}).`,
          answers: ERROR_ANSWERS,
        };
    } else if (wait?.kind === "reset") {
      const at = wait.at ? Date.parse(wait.at) : Number.NaN;
      // A reset already past (clock skew) still backs off: never a hot loop.
      if (Number.isFinite(at)) nextAt = Math.max(at, now + backoff);
      if (!granted && !(at - now <= this.limits.maxWaitMs)) {
        const other = this.workflow.providers?.find(
          (provider) => wait.provider && provider !== wait.provider,
        );
        question = {
          text: `${outcome.reason}\n\nThe limit resets ${Number.isFinite(at) ? `at ${new Date(at).toISOString()}` : "at a time it didn't say"}, more than ${hours(this.limits.maxWaitMs)} away. \`${WAIT}\` keeps waiting until it resets${other ? `; \`${SWITCH}\` runs this Objective on ${other} instead` : ""}; or cancel.`,
          answers: [WAIT, ...(other ? [SWITCH] : []), "cancel"],
        };
      }
    } else if (
      wait?.kind !== "gate" &&
      !granted &&
      now - Date.parse(since) >= this.limits.maxWaitMs
    )
      // A human gate (an approval, a required review) is never timed out:
      // the display shows it and a reminder follows a day later.
      question = {
        text: `Step ${key} has been retrying since ${since}, for more than ${hours(this.limits.maxWaitMs)}. It began with: ${(previous?.cause ?? outcome.reason).slice(0, 500)}\n\nLast error: ${outcome.reason.slice(0, 500)}\n\n\`${WAIT}\` keeps retrying for another ${hours(this.limits.maxWaitMs)}; \`retry\` tries again now; or cancel.`,
        answers: [WAIT, "retry", "cancel"],
      };
    const record: Retry = {
      count,
      attempts,
      since,
      nextAt: new Date(nextAt).toISOString(),
      lastError: outcome.reason,
      cause: previous?.cause ?? outcome.reason,
      ...(wait ? { wait } : {}),
      ...(granted ? { grantedUntil: previous.grantedUntil } : {}),
    };
    state.retries[key] = record;
    if (question)
      this.hold(key, question.text, question.answers, question.answers[0]!);
  }

  /** Stop running steps now; their late outcomes are dropped by the token check in `start`. */
  private abort(keys: readonly string[], reason: string): void {
    const stopped = keys.filter((key) => this.running.has(key));
    for (const key of stopped) {
      this.running.get(key)?.controller.abort(new Error(reason));
      this.running.delete(key);
    }
    if (stopped.length)
      this.log.write(this.state.issue, {
        event: "aborted",
        steps: stopped,
        reason,
      });
  }

  /**
   * Stop the running steps among `keys` once the change is saved, as cancel
   * does: the work they build on was cleared, so their late outcomes would
   * write back stale results.
   */
  private abortRunning(keys: readonly string[]): void {
    this.afterSave.push(() => this.abort(keys, "cleared"));
  }

  /**
   * This run is replaced by a new one for the same Objective (the operator
   * queued a finished Objective again): abort its steps, and never save
   * again, so only the new run writes the Objective's file.
   */
  stop(): void {
    this.stopped = true;
    this.abort([...this.running.keys()], "replaced");
  }

  /**
   * Open a question. One question is open at a time: a second step that
   * asks while another question is open runs again after the answer, and
   * asks then.
   */
  private hold(
    key: string,
    question: string,
    answers: string[],
    recommended: string,
  ): void {
    const state = this.state;
    const now = this.now().toISOString();
    if (state.hold && state.hold.step !== key) {
      const previous = state.retries[key];
      state.retries[key] = {
        ...previous,
        count: previous?.count ?? 0,
        attempts: previous?.attempts ?? 0,
        since: previous?.since ?? now,
        nextAt: now,
        lastError: "waiting for the open question",
      };
      return;
    }
    const all = answers.includes("cancel") ? answers : [...answers, "cancel"];
    state.hold = {
      id: `${key}@${now}`,
      step: key,
      question,
      answers: all,
      recommended: all.includes(recommended) ? recommended : all[0]!,
      askedAt: now,
    };
    if (state.status !== "holding") state.resumeStatus = state.status;
    state.status = "holding";
  }

  /**
   * Answer the open question. Returns null when applied, or the reason it
   * doesn't fit. The caller saves (see `transact`).
   */
  answer(
    answer: string,
    text: string | undefined,
    by: string,
    writtenAt?: string,
  ): string | null {
    if (answer === "cancel") return this.cancel(by);
    const hold = this.state.hold;
    if (!hold) return `#${this.state.issue} has no open question.`;
    if (writtenAt && Date.parse(writtenAt) < Date.parse(hold.askedAt) - 60_000)
      return `That answer was written before the current question was asked, so it wasn't applied. The open question asks: ${hold.question.slice(0, 300)} Answers: ${hold.answers.join(", ")}.`;
    if (!hold.answers.includes(answer))
      return `"${answer}" isn't an answer to this question. Answers: ${hold.answers.join(", ")}.`;
    const retry = this.state.retries[hold.step];
    if (answer === WAIT && retry) this.grant(retry);
    else {
      if (answer === SWITCH) {
        const from = retry?.wait?.kind === "reset" ? retry.wait.provider : "";
        this.state.kept ??= {};
        this.state.kept.provider = this.workflow.providers?.find(
          (provider) => provider !== from,
        );
      } else
        this.state.answers[hold.step] = {
          holdId: hold.id,
          question: hold.question,
          answer,
          ...(text ? { text } : {}),
          by,
          at: this.now().toISOString(),
        };
      delete this.state.retries[hold.step];
    }
    this.state.hold = null;
    this.state.status =
      this.state.resumeStatus ?? this.workflow.status(this.state);
    delete this.state.resumeStatus;
    return null;
  }

  /**
   * `wait`: keep waiting without asking, until a known reset (and the
   * usual budget after it), for a day on a limit with no reset time, or for
   * another `maxWaitMs` on a transient cause.
   */
  private grant(retry: Retry): void {
    const now = this.now().getTime();
    const reset = retry.wait?.kind === "reset";
    const at =
      reset && retry.wait?.kind === "reset" && retry.wait.at
        ? Math.max(Date.parse(retry.wait.at), now)
        : Number.NaN;
    retry.grantedUntil = new Date(
      Number.isFinite(at)
        ? at + this.limits.maxWaitMs
        : now + (reset ? this.limits.remindAfterMs : this.limits.maxWaitMs),
    ).toISOString();
    retry.nextAt = new Date(Number.isFinite(at) ? at : now).toISOString();
  }

  /**
   * Cancel at once: stop running steps and mark the Objective cancelled.
   * Cleanup steps follow. A finished Objective stays as it is.
   */
  cancel(by: string): string | null {
    const status = this.state.status;
    if (status === "done" || status === "failed")
      return `#${this.state.issue} has already finished (${status}).`;
    if (status === "cancelled") return null;
    this.state.status = "cancelled";
    this.state.hold = null;
    this.state.attempts = {};
    this.state.retries = {};
    delete this.state.resumeStatus;
    this.state.answers.cancel = {
      holdId: "",
      answer: "cancel",
      by,
      at: this.now().toISOString(),
    };
    // Stop running steps only once the cancel is saved.
    this.afterSave.push(() => {
      this.abort([...this.running.keys()], "cancelled");
      this.log.write(this.state.issue, { event: "cancelled", by });
    });
    return null;
  }

  /** Run waiting steps now, or answer `retry` to an open question that offers it. */
  retryNow(by: string): string | null {
    const hold = this.state.hold;
    if (hold) {
      if (!hold.answers.includes("retry"))
        return `#${this.state.issue}'s open question has no retry answer. Answers: ${hold.answers.join(", ")}.`;
      return this.answer("retry", undefined, by);
    }
    for (const retry of Object.values(this.state.retries))
      retry.nextAt = this.now().toISOString();
    return null;
  }

  private save(): void {
    this.state.updatedAt = this.now().toISOString();
    saveState(this.dir, this.state);
  }
}

/** A retry's class: a reset, a gate, or an unknown cause (errors included). */
function waitClass(wait: Wait | undefined): string {
  return wait?.kind ?? "unknown";
}

function hours(ms: number): string {
  const h = ms / (60 * 60 * 1000);
  return h >= 1 ? `${Number(h.toFixed(1))} h` : `${Math.round(ms / 1000)} s`;
}
