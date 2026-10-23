import type { CoreConfig, QueueOption } from "./config.js";
import { crashPoint } from "./crash.js";
import type { EngineLimits, ObjectiveRunner } from "./engine.js";
import { type GitHub, TransientError } from "./github.js";
import type { RunLog } from "./log.js";
import { QueueDisplay, type QueueItem, queued, readQueue } from "./queue.js";
import { writeRequest } from "./requests.js";
import type { ObjectiveStatus } from "./state.js";
import { TERMINAL } from "./state.js";
import { errorMessage } from "./text.js";

/** What the sync keeps in an Objective's state (`modules.github`). */
export interface GitHubModule {
  itemId: string;
  /** The Project's order number when it was queued; ties go to the lower issue. */
  order?: number | null;
  /** The Factory field option last written. */
  shown?: string;
  /** The hold whose question comment exists. */
  askedHold?: string;
  /** Comments are read from here on. */
  commentsSince: string;
  /** Request ids already replied to. */
  replied?: string[];
  /** The wait the status note describes (`<step>@<since>`). */
  noted?: string;
  /** The human gate a reminder was posted for (`<step>@<since>`). */
  reminded?: string;
}

/** An Objective whose state file can't be read: it holds, with `cancel`. */
export interface UnreadableObjective {
  error: string;
  /** Its card and comment cursor, once the sync has seen it on the Project. */
  github?: GitHubModule;
}

export interface SyncView {
  runners: ReadonlyMap<number, ObjectiveRunner>;
  unreadable: ReadonlyMap<number, UnreadableObjective>;
  /** Start (or start again) an Objective seen queued; the service decides whether it may. */
  admit(issue: number, github: GitHubModule): void;
  /** Checked and waiting for a slot: still shown as queued. */
  waitingForSlot(issue: number): boolean;
  requestsDir: string;
  /** The result of an applied request, by id, while its result file exists. */
  result(id: string): string | undefined;
}

const MARK = (issue: number, kind: string, id: string) =>
  `<!-- factory:${issue}:${kind}:${id} -->`;

const OPTION: Record<ObjectiveStatus, QueueOption> = {
  checking: "queued",
  planning: "planning",
  building: "building",
  finishing: "building",
  holding: "holding",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
};

/** A sync job that failed waits this long, doubling, up to MAX_BACKOFF_MS. */
const BASE_BACKOFF_MS = 10_000;
const MAX_BACKOFF_MS = 10 * 60_000;

/**
 * GitHub is input and display, never a precondition: every call here runs in
 * the background, and nothing here can fail a run. A failed job is logged
 * and tried again after a backoff of its own (per job and Objective, capped
 * at ten minutes), so one Objective's bad card or locked issue never spends
 * the rate limit the others need. A finished Objective is synced once.
 */
export class GitHubSync {
  private view: QueueItem[] = [];
  private lastPoll = 0;
  /** Running jobs, by key, with their Objective. */
  private readonly busy = new Map<string, number>();
  private readonly backoff = new Map<
    string,
    { failures: number; nextAt: number }
  >();
  /** Finished Objectives that had their one sync pass. */
  private readonly settled = new Set<number>();
  private readonly display: QueueDisplay;
  private readonly writers = new Map<string, boolean>();

  constructor(
    private readonly github: GitHub,
    private readonly config: CoreConfig,
    private readonly log: RunLog,
    private readonly limits: Pick<
      EngineLimits,
      "noteAfterMs" | "remindAfterMs"
    >,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.display = new QueueDisplay(github, config);
  }

  tick(sync: SyncView): void {
    const due =
      this.now() - this.lastPoll >= this.config.queue.pollSeconds * 1000;
    if (due) {
      this.lastPoll = this.now();
      const known = [
        ...new Set([
          ...queued(this.view, this.config).map((item) => item.issue),
          ...[...sync.runners.values()]
            .filter((runner) => !TERMINAL.includes(runner.state.status))
            .map((runner) => runner.state.issue),
          ...sync.unreadable.keys(),
        ]),
      ];
      // The poll interval paces the queue read; it needs no backoff.
      this.background(
        0,
        "queue",
        async () => {
          this.view = await readQueue(this.github, this.config, known);
        },
        false,
      );
    }
    this.admit(sync);
    for (const runner of sync.runners.values()) {
      const module = runner.state.modules.github as GitHubModule | undefined;
      const issue = runner.state.issue;
      const finished =
        TERMINAL.includes(runner.state.status) && !runner.hasWork;
      if (finished && this.settled.has(issue)) continue;
      if (!module) {
        if (finished) this.settled.add(issue);
        continue;
      }
      this.show(runner, module, sync);
      this.ask(runner, module);
      this.reply(runner, module, sync);
      if (finished) {
        this.settled.add(issue);
        continue;
      }
      this.note(runner, module);
      if (due && !TERMINAL.includes(runner.state.status))
        this.readComments(
          issue,
          module.commentsSince,
          Boolean(runner.state.hold),
          sync,
          (latest) =>
            runner.transact(() => {
              (runner.state.modules.github as GitHubModule).commentsSince =
                latest;
            }),
        );
    }
    for (const [issue, entry] of sync.unreadable)
      this.unreadable(issue, entry, due, sync);
  }

  /** Whether a finished Objective had its sync pass and no job of it is running. */
  idle(issue: number): boolean {
    return (
      this.settled.has(issue) &&
      ![...this.busy.values()].some((owner) => owner === issue)
    );
  }

  /** Forget an Objective the service let go of, or whose run was replaced. */
  forget(issue: number): void {
    this.settled.delete(issue);
    for (const key of this.backoff.keys())
      if (key.endsWith(`:${issue}`) || key.includes(`:${issue}:`))
        this.backoff.delete(key);
  }

  /**
   * Every queued Objective without an unfinished run is offered to the
   * service at once, so it is checked when it is first seen; planning
   * waits for a slot.
   */
  private admit(sync: SyncView): void {
    for (const item of queued(this.view, this.config)) {
      const runner = sync.runners.get(item.issue);
      if (runner && !TERMINAL.includes(runner.state.status)) continue;
      // Never over an unreadable state: it waits for its own answer.
      if (sync.unreadable.has(item.issue)) continue;
      // A finished run shows its final option, so a queued one was queued again.
      sync.admit(item.issue, {
        itemId: item.itemId,
        order: item.order,
        commentsSince: new Date(this.now()).toISOString(),
      });
    }
  }

  private show(
    runner: ObjectiveRunner,
    module: GitHubModule,
    sync: SyncView,
  ): void {
    const status = runner.state.status;
    const issue = runner.state.issue;
    const option =
      this.config.queue.options[
        !TERMINAL.includes(status) &&
        status !== "holding" &&
        sync.waitingForSlot(issue)
          ? "queued"
          : OPTION[status]
      ];
    if (module.shown === option) return;
    this.background(issue, `show:${issue}`, async () => {
      crashPoint("sync:show:before");
      await this.display.set(module.itemId, option);
      crashPoint("sync:show:after");
      runner.transact(() => {
        (runner.state.modules.github as GitHubModule).shown = option;
      });
      const item = this.view.find((i) => i.issue === issue);
      if (item) item.option = option;
    });
  }

  /** Post the open question once, with its answers. */
  private ask(runner: ObjectiveRunner, module: GitHubModule): void {
    const hold = runner.state.hold;
    if (!hold || module.askedHold === hold.id) return;
    const issue = runner.state.issue;
    this.background(issue, `ask:${issue}`, async () => {
      const marker = MARK(issue, "hold", hold.id);
      if (!(await this.posted(issue, marker, hold.askedAt))) {
        const answers = hold.answers
          .map(
            (a) =>
              `\`/factory ${a}\`${a === hold.recommended ? " (recommended)" : ""}`,
          )
          .join(", ");
        crashPoint("sync:ask:before");
        await this.github.postComment(
          issue,
          `${marker}\n**Factory needs you.** ${hold.question}\n\nReply with one of: ${answers}. Add text after the answer to explain it.`,
        );
        crashPoint("sync:ask:after");
      }
      runner.transact(() => {
        (runner.state.modules.github as GitHubModule).askedHold = hold.id;
      });
    });
  }

  /**
   * A wait shown on the issue: one status note, edited in place, once an
   * unknown transient cause has lasted `noteAfterMs`; one reminder once a
   * human gate (an approval, a required review) has lasted `remindAfterMs`.
   */
  private note(runner: ObjectiveRunner, module: GitHubModule): void {
    const now = this.now();
    const issue = runner.state.issue;
    const waits = Object.entries(runner.state.retries)
      .filter(([, retry]) => retry.count === 0)
      .sort(([, a], [, b]) => a.since.localeCompare(b.since));
    const transient = waits.find(
      ([, retry]) =>
        !retry.wait && now - Date.parse(retry.since) >= this.limits.noteAfterMs,
    );
    if (transient && module.noted !== `${transient[0]}@${transient[1].since}`) {
      const [step, retry] = transient;
      const id = `${step}@${retry.since}`;
      this.background(issue, `note:${issue}`, async () => {
        const marker = MARK(issue, "waiting", "note");
        await this.github.upsertComment(
          issue,
          marker,
          `${marker}\n**Factory is waiting.** Step \`${step}\` has been retrying since ${retry.since}. It began with: ${(retry.cause ?? retry.lastError).slice(0, 500)}\n\nLast error: ${retry.lastError.slice(0, 500)}\n\nFactory keeps retrying on its own, and asks here if the wait goes on.`,
          "sync:note",
        );
        runner.transact(() => {
          (runner.state.modules.github as GitHubModule).noted = id;
        });
      });
    }
    const gate = waits.find(
      ([, retry]) =>
        retry.wait?.kind === "gate" &&
        now - Date.parse(retry.since) >= this.limits.remindAfterMs,
    );
    if (gate && module.reminded !== `${gate[0]}@${gate[1].since}`) {
      const [step, retry] = gate;
      const id = `${step}@${retry.since}`;
      const what = retry.wait?.kind === "gate" ? retry.wait.gate : step;
      this.background(issue, `remind:${issue}`, async () => {
        const marker = MARK(issue, "remind", id);
        if (!(await this.posted(issue, marker, retry.since))) {
          crashPoint("sync:remind:before");
          await this.github.postComment(
            issue,
            `${marker}\n**Factory is still waiting on ${what}**, since ${retry.since}. It carries on by itself once that is done.`,
          );
          crashPoint("sync:remind:after");
        }
        runner.transact(() => {
          (runner.state.modules.github as GitHubModule).reminded = id;
        });
      });
    }
  }

  /**
   * An unreadable state holds like any other Objective: its question is
   * posted on the issue, its card shows "Needs you", and `/factory cancel`
   * is read from the comments. Nothing is saved for it until it is cancelled.
   */
  private unreadable(
    issue: number,
    entry: UnreadableObjective,
    due: boolean,
    sync: SyncView,
  ): void {
    const item = this.view.find((i) => i.issue === issue);
    if (!entry.github && item)
      entry.github = {
        itemId: item.itemId,
        commentsSince: new Date(this.now()).toISOString(),
      };
    const module = entry.github;
    if (!module) return;
    const option = this.config.queue.options.holding;
    if (module.shown !== option)
      this.background(issue, `show:${issue}`, async () => {
        crashPoint("sync:show:before");
        await this.display.set(module.itemId, option);
        crashPoint("sync:show:after");
        module.shown = option;
      });
    if (module.askedHold !== "unreadable")
      this.background(issue, `ask:${issue}`, async () => {
        const marker = MARK(issue, "hold", "unreadable");
        const found = await this.github.markedComment(issue, marker);
        if (found) module.commentsSince = found.created_at;
        else {
          crashPoint("sync:ask:before");
          await this.github.postComment(
            issue,
            `${marker}\n**Factory needs you.** Factory can't read this Objective's state (${entry.error.slice(0, 500)}). Reply with \`/factory cancel\` (recommended) to start over from a cancelled record; then queue it again to run it again.`,
          );
          crashPoint("sync:ask:after");
        }
        module.askedHold = "unreadable";
      });
    else if (due)
      this.readComments(issue, module.commentsSince, true, sync, (latest) => {
        module.commentsSince = latest;
      });
  }

  /**
   * Read new `/factory` comments and turn each into a request. One comment
   * that can't be checked is logged and skipped; the cursor moves past it,
   * so it never blocks the comments after it.
   */
  private readComments(
    issue: number,
    since: string,
    holding: boolean,
    sync: SyncView,
    advance: (latest: string) => void,
  ): void {
    this.background(issue, `comments:${issue}`, async () => {
      const comments = await this.github.comments(issue, since);
      let latest = since;
      for (const comment of comments) {
        if (comment.created_at > latest) latest = comment.created_at;
        const command = comment.body
          .trim()
          .match(/^\/factory\s+(\S+)(?:\s+([\s\S]*))?$/);
        if (!command || !comment.user) continue;
        const login = comment.user.login;
        let allowed: boolean;
        try {
          allowed = await this.canWrite(login);
        } catch (error) {
          this.log.write(issue, {
            event: "comment-unchecked",
            comment: comment.id,
            login,
            error: errorMessage(error),
          });
          continue;
        }
        if (!allowed) {
          this.log.write(issue, {
            event: "comment-ignored",
            comment: comment.id,
            login,
          });
          continue;
        }
        const answer = command[1]!.toLowerCase();
        const text = command[2]?.trim();
        writeRequest(
          sync.requestsDir,
          answer === "cancel"
            ? { kind: "cancel", issue }
            : answer === "retry" && !holding
              ? { kind: "retry", issue }
              : {
                  kind: "answer",
                  issue,
                  answer,
                  ...(text ? { text } : {}),
                  writtenAt: comment.created_at,
                },
          login,
          `comment-${comment.id}`,
        );
      }
      if (latest !== since) advance(latest);
    });
  }

  /** Reply to each `/factory` comment with what happened. */
  private reply(
    runner: ObjectiveRunner,
    module: GitHubModule,
    sync: SyncView,
  ): void {
    const issue = runner.state.issue;
    const pending = runner.state.appliedRequests.filter(
      (r) =>
        r.id.startsWith("comment-") && !(module.replied ?? []).includes(r.id),
    );
    for (const request of pending) {
      this.background(issue, `reply:${issue}:${request.id}`, async () => {
        const marker = MARK(issue, "reply", request.id);
        const message = sync.result(request.id) ?? request.message;
        if (!(await this.posted(issue, marker, module.commentsSince))) {
          crashPoint("sync:reply:before");
          await this.github.postComment(
            issue,
            `${marker}\n${message === "ok" ? "Factory: done." : `Factory: ${message}`}`,
          );
          crashPoint("sync:reply:after");
        }
        runner.transact(() => {
          const github = runner.state.modules.github as GitHubModule;
          github.replied = [...(github.replied ?? []), request.id].slice(-50);
        });
      });
    }
  }

  /** Whether the marked comment exists; read from a little before `since`, for clock skew between this host and GitHub. */
  private async posted(
    issue: number,
    marker: string,
    since: string,
  ): Promise<boolean> {
    const from = new Date(Date.parse(since) - 10 * 60_000).toISOString();
    return (await this.github.findComment(issue, marker, from)) !== undefined;
  }

  private async canWrite(login: string): Promise<boolean> {
    const known = this.writers.get(login);
    if (known !== undefined) return known;
    const { permission } = await this.github.rest<{ permission: string }>(
      "GET",
      `/repos/${this.config.repository}/collaborators/${encodeURIComponent(login)}/permission`,
    );
    const ok = ["admin", "maintain", "write"].includes(permission);
    this.writers.set(login, ok);
    return ok;
  }

  /**
   * Run `job` for Objective `issue` (0: the queue) unless it is running or
   * backing off after a failure; log any failure and back off.
   */
  private background(
    issue: number,
    key: string,
    job: () => Promise<void>,
    backs = true,
  ): void {
    if (this.busy.has(key)) return;
    const wait = this.backoff.get(key);
    if (wait && this.now() < wait.nextAt) return;
    this.busy.set(key, issue);
    job()
      .then(() => this.backoff.delete(key))
      .catch((error: unknown) => {
        const failures = (this.backoff.get(key)?.failures ?? 0) + 1;
        if (backs)
          this.backoff.set(key, {
            failures,
            nextAt:
              this.now() +
              Math.min(BASE_BACKOFF_MS * 2 ** (failures - 1), MAX_BACKOFF_MS),
          });
        this.log.write(issue, {
          event: "github-sync",
          job: key,
          transient: error instanceof TransientError,
          failures,
          error: errorMessage(error),
        });
      })
      .finally(() => this.busy.delete(key));
  }
}
