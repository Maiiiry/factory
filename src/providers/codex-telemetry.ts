/**
 * What a Codex call's private CODEX_HOME holds about its thread: the
 * session record (rollout), read before the home is removed. It gives what
 * a failed turn's own records say about it, for its outcome (codex.ts
 * codexFailure); a continued thread's counts before its new turn and
 * whether Codex compacted it, for retained conversations (session.ts); and
 * the running thread's context, for its live view. The call's tokens come
 * from the SDK's `turn.completed` alone. Best effort and bounded: an
 * unreadable or missing record gives nothing, never an error.
 */
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { providerUsage, type Tokens, tokens } from "./usage.js";

/** The end of a session record read: its last token count is at the end. */
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 512;

export interface CodexRecord {
  /** The thread's cumulative counts at its last `token_count`. */
  tokens?: Tokens;
  /** Codex compacted the thread's history in what was read. */
  compacted?: true;
  /**
   * The last turn's error as Codex classified it (`codex_error_info` on its
   * `task_complete`): the kind, and an HTTP failure's status.
   */
  failure?: { kind: string; status?: number };
  /**
   * The usage windows of the last `token_count` that reported them (its
   * `rate_limits`, primary and secondary): percent used, and the reset in
   * epoch milliseconds when Codex gave one.
   */
  limits?: { used: number; resetsAt?: number }[];
}

/**
 * What the session record of `thread` in the Codex home `codexHome` says,
 * or undefined when it isn't there.
 */
export function codexRecord(
  codexHome: string,
  thread: string | undefined,
  /** A continued thread's record size before this turn: only what follows is this turn's. */
  from = 0,
): CodexRecord | undefined {
  if (!thread) return undefined;
  const file = codexSessionRecord(codexHome, thread);
  const lines = file && readTail(file, from);
  if (!lines) return undefined;
  let total: Record<string, unknown> | undefined;
  let compacted = false;
  let failure: CodexRecord["failure"];
  let limits: CodexRecord["limits"];
  for (const line of lines) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const { type, payload } = entry as {
      type?: unknown;
      payload?: Record<string, unknown> | null;
    };
    if (!payload || typeof payload !== "object") continue;
    // Codex replaced the thread's history with a summary.
    if (
      type === "compacted" ||
      (type === "event_msg" && payload.type === "context_compacted")
    )
      compacted = true;
    if (type === "event_msg" && payload.type === "token_count") {
      const counted = payload.info as Record<string, unknown> | null;
      if (
        counted?.total_token_usage &&
        typeof counted.total_token_usage === "object"
      )
        total = counted.total_token_usage as Record<string, unknown>;
      limits = usageWindows(payload.rate_limits) ?? limits;
    }
    if (type === "event_msg" && payload.type === "task_complete")
      failure = errorKind(payload.error);
  }
  return {
    ...(total && {
      tokens: tokens({
        input: total.input_tokens as number,
        output: total.output_tokens as number,
        cached: total.cached_input_tokens as number,
        reasoning: total.reasoning_output_tokens as number,
      }),
    }),
    ...(compacted ? { compacted: true as const } : {}),
    ...(failure ? { failure } : {}),
    ...(limits ? { limits } : {}),
  };
}

/** A `task_complete` error's `codex_error_info`: a kind's name, or `{kind: details}`. */
function errorKind(error: unknown): CodexRecord["failure"] {
  const info = (error as { codex_error_info?: unknown } | null)
    ?.codex_error_info;
  if (typeof info === "string") return { kind: info };
  if (!info || typeof info !== "object") return undefined;
  const [kind, details] = Object.entries(info)[0] ?? [];
  if (!kind) return undefined;
  const status = (details as { http_status_code?: unknown } | null)
    ?.http_status_code;
  return { kind, ...(typeof status === "number" ? { status } : {}) };
}

/** A `token_count`'s `rate_limits` windows; undefined when it reports none. */
function usageWindows(limits: unknown): CodexRecord["limits"] {
  if (!limits || typeof limits !== "object") return undefined;
  const { primary, secondary } = limits as Record<string, unknown>;
  const windows: NonNullable<CodexRecord["limits"]> = [];
  for (const window of [primary, secondary]) {
    const { used_percent: used, resets_at: resets } =
      (window as Record<string, unknown> | null) ?? {};
    if (typeof used !== "number" || !Number.isFinite(used)) continue;
    windows.push({
      used,
      ...(typeof resets === "number" && Number.isFinite(resets)
        ? { resetsAt: resets * 1000 }
        : {}),
    });
  }
  return windows.length ? windows : undefined;
}

/**
 * The `rollout-*.jsonl` records under `sessions/YYYY/MM/DD`, bounded: the
 * call's own thread and any sub-agent threads it started in the same home.
 */
function sessionRecords(dir: string): string[] {
  let entries = 0;
  const found: string[] = [];
  const walk = (at: string, depth: number): void => {
    let names: string[];
    try {
      names = readdirSync(at);
    } catch {
      return;
    }
    for (const name of names) {
      if (++entries > MAX_ENTRIES) return;
      const path = join(at, name);
      if (depth < 3) walk(path, depth + 1);
      else if (name.startsWith("rollout-") && name.endsWith(".jsonl"))
        found.push(path);
    }
  };
  walk(dir, 0);
  return found;
}

/** The record's last MAX_BYTES after `from` as complete lines; undefined when unreadable. */
function readTail(file: string, from: number): string[] | undefined {
  try {
    const size = statSync(file).size;
    const start = Math.max(from, size - MAX_BYTES);
    const fd = openSync(file, "r");
    try {
      const buffer = Buffer.alloc(size - start);
      const read = readSync(fd, buffer, 0, buffer.length, start);
      const lines = buffer.subarray(0, read).toString("utf8").split("\n");
      if (start > from) lines.shift();
      return lines;
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/**
 * A continued thread before its new turn: its record's byte size, and its
 * cumulative counts so far. Codex reports a continued thread's counts
 * cumulatively, so the turn's own are the new totals less these.
 */
export interface CodexBaseline {
  size: number;
  tokens?: Tokens;
}

export function codexBaseline(
  codexHome: string,
  thread: string,
): CodexBaseline {
  const file = codexSessionRecord(codexHome, thread);
  let size = 0;
  try {
    size = file ? statSync(file).size : 0;
  } catch {
    return { size: 0 };
  }
  const tokens = codexRecord(codexHome, thread)?.tokens;
  return { size, ...(tokens && { tokens }) };
}

/** A continued turn's own counts: cumulative `total` less `baseline`; unknown without one. */
export function turnTokens(total: Tokens, baseline?: Tokens): Tokens {
  const less = (a: number | null, b: number | null | undefined) =>
    a === null || b === null || b === undefined ? null : Math.max(0, a - b);
  return tokens({
    input: less(total.input, baseline?.input),
    output: less(total.output, baseline?.output),
    cached: less(total.cached, baseline?.cached),
    cacheWrite: less(total.cacheWrite, baseline?.cacheWrite),
    reasoning: less(total.reasoning, baseline?.reasoning),
  });
}

/** `thread`'s session record in the Codex home `codexHome`, when it is there. */
export function codexSessionRecord(
  codexHome: string,
  thread: string,
): string | undefined {
  return sessionRecords(join(codexHome, "sessions")).find((path) =>
    path.endsWith(`${thread}.jsonl`),
  );
}

/** The SDK's `turn.completed` usage as the record's `providerUsage.turn`. */
export function codexTurnUsage(
  record: Record<string, unknown>,
  usage: unknown,
): void {
  const turn = providerUsage(usage);
  if (turn)
    record.providerUsage = {
      ...(record.providerUsage as Record<string, unknown> | undefined),
      turn,
    };
}

/** An SDK item the model produced: its first marks the call's first token. */
export const modelItem = (item: { type: string } | undefined): boolean =>
  item !== undefined && item.type !== "error";

/** The SDK's `turn.completed` usage, normalized. */
export function codexTokens(usage: {
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens?: number;
  reasoning_output_tokens?: number;
}): Tokens {
  return tokens({
    input: usage.input_tokens,
    output: usage.output_tokens,
    cached: usage.cached_input_tokens,
    cacheWrite: usage.cache_write_input_tokens,
    reasoning: usage.reasoning_output_tokens,
  });
}

/** The most of a session record one live read takes; older lines are skipped. */
const LIVE_BYTES = 8 * 1024 * 1024;

/**
 * A running thread's context and compactions, read from its session record
 * as it grows: each call reads what was appended since the last one and
 * returns the last `token_count`'s context (its last request's input
 * tokens and the model's window) and the compactions it saw. Best effort:
 * a missing or unreadable record gives nothing.
 */
export function codexLiveRecord(
  codexHome: string,
  /** A continued thread's record size before this turn. */
  from = 0,
): (thread: string) => {
  context?: { tokens: number; window?: number };
  compactions: number;
  /** Model responses since the last read (one `token_count` each). */
  responses: number;
} {
  let file: string | undefined;
  let offset = from;
  let rest = "";
  // Codex writes a compaction as a `compacted` record and a
  // `context_compacted` event: one compaction until the next count or item.
  let compacting = false;
  return (thread) => {
    let compactions = 0;
    let responses = 0;
    let context: { tokens: number; window?: number } | undefined;
    file ??= codexSessionRecord(codexHome, thread);
    if (!file) return { compactions, responses };
    let text: string;
    try {
      const size = statSync(file).size;
      if (size <= offset) return { compactions, responses };
      const start = Math.max(offset, size - LIVE_BYTES);
      if (start > offset) rest = "";
      const fd = openSync(file, "r");
      try {
        const buffer = Buffer.alloc(size - start);
        const read = readSync(fd, buffer, 0, buffer.length, start);
        offset = start + read;
        text = rest + buffer.subarray(0, read).toString("utf8");
      } finally {
        closeSync(fd);
      }
    } catch {
      return { compactions, responses };
    }
    const lines = text.split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) {
      let entry: { type?: unknown; payload?: Record<string, unknown> | null };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const payload = entry?.payload;
      if (!payload || typeof payload !== "object") continue;
      if (
        entry.type === "compacted" ||
        (entry.type === "event_msg" && payload.type === "context_compacted")
      ) {
        if (!compacting) compactions += 1;
        compacting = true;
        continue;
      }
      if (entry.type === "response_item") compacting = false;
      if (entry.type !== "event_msg" || payload.type !== "token_count")
        continue;
      compacting = false;
      const info = payload.info as Record<string, unknown> | null | undefined;
      const last = info?.last_token_usage as
        | Record<string, unknown>
        | undefined;
      const tokens = last?.input_tokens;
      if (typeof tokens !== "number") continue;
      responses += 1;
      const window = info?.model_context_window;
      context = {
        tokens,
        ...(typeof window === "number" ? { window } : {}),
      };
    }
    return { ...(context ? { context } : {}), compactions, responses };
  };
}
