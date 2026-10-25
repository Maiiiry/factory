import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { attemptDir, captureDir, readContained } from "./paths.js";

/**
 * A new run id: the start time, then the process id. Ids sort by start
 * time, contain no dot, and name a run's log file and capture directory.
 */
export function newRunId(at = new Date()): string {
  return `${at.toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
}

/** The run a run-log file or capture directory belongs to: its name up to the first dot. */
export const runOfFile = (path: string): string =>
  basename(path).split(".")[0]!;

/**
 * Content capture (docs/reference/run-log.md#Content capture): off by default. Enabled, the
 * request and response bodies of each model call go to their own file,
 * redacted and cut to `maxBytesPerCall`, and the run log references it.
 */
export interface CaptureSettings {
  enabled: boolean;
  maxBytesPerCall: number;
}

export const CAPTURE_OFF: CaptureSettings = {
  enabled: false,
  maxBytesPerCall: 8 * 1024 * 1024,
};

/**
 * The key a model-usage event carries its bodies under. A symbol is never
 * serialized, so a body can't reach the run log; it survives the spreads
 * that add a step or hedge on the way to `RunLog.write`.
 */
export const CAPTURE = Symbol("capture");

export interface CaptureBody {
  request: string;
  response?: string;
  /** Native tool outputs, in order (usage.ts captureToolOutput), and their UTF-8 bytes. */
  tools?: { name: string; output: string }[];
  toolBytes?: number;
}

let toolCapture = false;

/** Whether a run log of this process captures: only then are tool outputs kept for it. */
export const capturingTools = (): boolean => toolCapture;

/**
 * The run log: one append-only JSON-lines file per Objective per service
 * run, `logs/<issue>/<run id>.jsonl`, and with capture on its bodies under
 * `logs/<issue>/<run id>.captures/`. It records what happened for status
 * and diagnostics (docs/reference/run-log.md#Run log). It never drives
 * progress, and losing it loses no work: a line that can't be written is
 * dropped.
 */
export class RunLog {
  /** Attempt files given out this run, oldest first, and their bytes on disk. */
  private readonly attempts: RunFile[] = [];

  constructor(
    private readonly dir: string,
    readonly runId: string,
    private readonly capture: CaptureSettings = CAPTURE_OFF,
    private readonly secrets: readonly string[] = [],
  ) {
    if (capture.enabled) toolCapture = true;
  }

  /** Append `{at, ...event}` to the issue's file of this run, and its capture's id. */
  write(issue: number, event: Record<string, unknown>): void {
    const body = (event as { [CAPTURE]?: CaptureBody })[CAPTURE];
    const id = body && this.capture.enabled && this.captured(issue, body);
    try {
      const dir = join(this.dir, String(issue));
      mkdirSync(dir, { recursive: true });
      appendFileSync(
        join(dir, `${this.runId}.jsonl`),
        `${JSON.stringify({ at: new Date().toISOString(), ...event, ...(id ? { capture: id } : {}) })}\n`,
      );
    } catch {
      // A full disk, a removed directory or an unserializable event must
      // not stop the run: the log only observes.
    }
  }

  /**
   * A private file of this run for one attempt, `<issue>/<run id>.attempts/<name>`
   * (docs/reference/run-log.md#Attempt files): `0600` segments in a `0700`
   * directory, redacted line by line, its head kept and its tail rolling,
   * and rotated with the run. A name given out before gets `-2`, `-3`, ...
   * Past the run's budget the oldest closed files go first, each noted with
   * an `attempt-file-dropped` event.
   */
  runFile(issue: number, name: string): RunFile {
    const clean = name.replace(/[^\w.-]/g, "_");
    const at = (unique: string) => `${attemptDir(issue, this.runId)}/${unique}`;
    // Taken: a file of this run still listed, or one already on disk.
    const taken = (unique: string) =>
      this.attempts.some((file) => file.file === at(unique)) ||
      existsSync(join(this.dir, `${at(unique)}.0`));
    let unique = clean;
    for (let n = 2; taken(unique); n++) unique = `${clean}-${n}`;
    const file = new RunFile(this.dir, at(unique), this.secrets, () =>
      this.budget(),
    );
    this.attempts.push(file);
    return file;
  }

  /** Over the run's attempt-file budget: remove the oldest closed files until within it. */
  private budget(): void {
    // Closed files with nothing left on disk (a passing command's) go from the list.
    for (let i = this.attempts.length - 1; i >= 0; i--) {
      const file = this.attempts[i]!;
      if (file.closed && file.onDisk === 0) this.attempts.splice(i, 1);
    }
    let total = this.attempts.reduce((sum, file) => sum + file.onDisk, 0);
    while (total > ATTEMPT_FILES_PER_RUN) {
      const oldest = this.attempts.findIndex((file) => file.closed);
      if (oldest < 0) return;
      const [file] = this.attempts.splice(oldest, 1);
      total -= file!.onDisk;
      file!.remove();
      this.write(Number(file!.file.split("/")[0]), {
        event: "attempt-file-dropped",
        file: file!.file,
      });
    }
  }

  /**
   * One call's bodies as `<id>.json`, 0600 in a 0700 directory: each body
   * redacted, then cut so the file stays within the bound. Its id, or
   * undefined when it couldn't be written.
   */
  private captured(issue: number, body: CaptureBody): string | undefined {
    try {
      const dir = join(this.dir, captureDir(issue, this.runId));
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const id = randomUUID();
      // Request and response share the bound; tool outputs, when any, take a quarter.
      const share = Math.floor(
        (this.capture.maxBytesPerCall * (body.tools?.length ? 3 : 4)) / 8,
      );
      const request = bounded(redact(body.request, this.secrets), share);
      const response =
        body.response === undefined
          ? undefined
          : bounded(redact(body.response, this.secrets), share);
      let toolBytes = Math.floor(this.capture.maxBytesPerCall / 4);
      let toolsCut = false;
      const tools: { name: string; output: string }[] = [];
      for (const tool of body.tools ?? []) {
        const output = bounded(redact(tool.output, this.secrets), toolBytes);
        tools.push({ name: tool.name, output: output.text });
        toolBytes -= Buffer.byteLength(output.text);
        toolsCut ||= output.cut;
      }
      // What was sent and answered before redaction and the cut: a cut
      // body still says how large it was and which it was.
      const original = (text: string) => ({
        bytes: Buffer.byteLength(text),
        sha256: createHash("sha256").update(text).digest("hex"),
      });
      writeFileSync(
        join(dir, `${id}.json`),
        JSON.stringify({
          id,
          run: this.runId,
          request: request.text,
          ...(response ? { response: response.text } : {}),
          ...(tools.length ? { tools } : {}),
          truncated: request.cut || Boolean(response?.cut) || toolsCut,
          original: {
            request: original(body.request),
            ...(body.response === undefined
              ? {}
              : { response: original(body.response) }),
            ...(body.tools?.length
              ? {
                  tools: {
                    count: body.tools.length,
                    bytes: body.tools.reduce(
                      (sum, tool) => sum + Buffer.byteLength(tool.output),
                      0,
                    ),
                  },
                }
              : {}),
          },
        }),
        { mode: 0o600 },
      );
      return id;
    } catch {
      return undefined;
    }
  }
}

/** What one service run keeps in attempt files, all issues together: the oldest closed go first past it. */
const ATTEMPT_FILES_PER_RUN = 1024 ** 3;
/** An attempt file's head, kept whole. */
const ATTEMPT_HEAD = 8 * 1024 ** 2;
/** Each tail segment past the head; the last two are kept. */
const ATTEMPT_SEGMENT = 4 * 1024 ** 2;
/** A line held for its newline at most this long before it is written anyway. */
const PENDING_LINE = 64 * 1024;
/** How much of such a line's end waits for the rest, at least. */
const PENDING_KEEP = 1024;
/** A character a redacted token (`redact`) can hold, or a pair's first half. */
const TOKEN_CHAR = /[\w.\-\uD800-\uDBFF]/;

/**
 * Where a line held past PENDING_LINE is cut: before its last
 * PENDING_KEEP characters (or the longest secret line), after a character
 * no token holds, and outside every secret, so each secret and token is
 * redacted whole once the rest comes. The whole text when no such place
 * exists (one unbroken token-like run).
 */
function flushCut(text: string, secrets: readonly string[]): number {
  const lines = secrets.flatMap((secret) =>
    secret.split(/\r?\n/).filter(Boolean),
  );
  let cut =
    text.length - Math.max(PENDING_KEEP, ...lines.map((line) => line.length));
  for (let was = -1; cut > 0 && was !== cut; ) {
    was = cut;
    while (cut > 0 && TOKEN_CHAR.test(text[cut - 1]!)) cut -= 1;
    for (const line of lines) {
      const start = text.lastIndexOf(line, cut - 1);
      if (start >= 0 && start + line.length > cut) cut = start;
    }
  }
  return cut > 0 ? cut : text.length;
}

/**
 * One attempt's private file (RunLog.runFile): text appended line by line,
 * each line redacted before it is written. The first ATTEMPT_HEAD bytes
 * stay in segment 0; after it, segments of ATTEMPT_SEGMENT roll and the
 * last two are kept, so the file keeps its start and its end within 16
 * MiB. Segments are `<file>.<n>`; `readRunFile` joins them. A write that
 * fails is counted, never retried: the file only observes.
 */
export class RunFile {
  /** Bytes written, and bytes rotated away from the middle. */
  written = 0;
  dropped = 0;
  failed = 0;
  closed = false;
  private segment = 0;
  private segmentBytes = 0;
  /** Bytes of the segments still on disk. */
  private kept = new Map<number, number>();
  /** Each stream's text waiting for its newline. */
  private pending = new Map<string, string>();

  constructor(
    private readonly logs: string,
    /** Under the logs directory, without its segment number: what an event names. */
    readonly file: string,
    private readonly secrets: readonly string[],
    private readonly grew: () => void,
  ) {}

  get onDisk(): number {
    let sum = 0;
    for (const bytes of this.kept.values()) sum += bytes;
    return sum;
  }

  /**
   * Text of one `stream` (a command's stdout and stderr apart, so their
   * chunks never split each other's lines): complete lines are written,
   * redacted, and the rest waits for its newline or `close`. A line past
   * PENDING_LINE is written up to `flushCut`.
   */
  append(text: string, stream = ""): void {
    if (this.closed) return;
    const pending = (this.pending.get(stream) ?? "") + text;
    const end = pending.lastIndexOf("\n");
    const cut =
      end >= 0
        ? end + 1
        : pending.length < PENDING_LINE
          ? 0
          : flushCut(pending, this.secrets);
    this.pending.set(stream, pending.slice(cut));
    this.write(redact(pending.slice(0, cut), this.secrets));
  }

  /**
   * One JSON line: `{at, ...record}`, each string redacted and cut to 64
   * KiB (`cutStrings`). A record that can't be serialized (a cycle, a
   * BigInt) is counted as a failed write: the caller is never stopped.
   */
  record(record: Record<string, unknown>): void {
    let line: string;
    try {
      line = `${JSON.stringify({ at: new Date().toISOString(), ...(cutStrings(record, this.secrets) as object) })}\n`;
    } catch {
      this.failed += 1;
      return;
    }
    this.append(line);
  }

  /** Write what is pending and stop. */
  close(): void {
    if (this.closed) return;
    for (const text of this.pending.values())
      this.write(redact(text, this.secrets));
    this.pending.clear();
    this.closed = true;
    this.grew();
  }

  /** Remove every segment: the run's budget dropped this file. */
  remove(): void {
    this.closed = true;
    for (const segment of this.kept.keys()) this.unlink(segment);
    this.kept.clear();
  }

  /** Remove one segment; a failure is counted, never thrown: the file only observes. */
  private unlink(segment: number): void {
    try {
      rmSync(this.path(segment), { force: true });
    } catch {
      this.failed += 1;
    }
  }

  private path(segment: number): string {
    return join(this.logs, `${this.file}.${segment}`);
  }

  private write(text: string): void {
    if (!text) return;
    let bytes = Buffer.from(text, "utf8");
    const limit = this.segment ? ATTEMPT_SEGMENT : ATTEMPT_HEAD;
    if (this.segmentBytes && this.segmentBytes + bytes.length > limit) {
      this.segment += 1;
      this.segmentBytes = 0;
      // Keep the head and the last two tail segments.
      const old = this.segment - 2;
      if (old >= 1 && this.kept.has(old)) {
        this.dropped += this.kept.get(old)!;
        this.unlink(old);
        this.kept.delete(old);
      }
    }
    const room = this.segment ? ATTEMPT_SEGMENT : ATTEMPT_HEAD;
    if (bytes.length > room) {
      this.dropped += bytes.length - room;
      bytes = bytes.subarray(bytes.length - room);
    }
    try {
      mkdirSync(join(this.logs, dirname(this.file)), {
        recursive: true,
        mode: 0o700,
      });
      appendFileSync(this.path(this.segment), bytes, { mode: 0o600 });
      this.segmentBytes += bytes.length;
      this.written += bytes.length;
      this.kept.set(
        this.segment,
        (this.kept.get(this.segment) ?? 0) + bytes.length,
      );
    } catch {
      this.failed += 1;
      return;
    }
    if (this.segmentBytes === bytes.length) this.grew();
  }
}

/** The longest string an attempt-file record keeps: its head and tail, the middle cut. */
const RECORD_STRING = 64 * 1024;

/** `value` with every string redacted, then cut in the middle when over RECORD_STRING. */
function cutStrings(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    // Redacted before the cut and the JSON escaping, so neither hides a secret.
    const shown = redact(value, secrets);
    return shown.length > RECORD_STRING
      ? `${shown.slice(0, RECORD_STRING / 2)}\n[… ${shown.length - RECORD_STRING} characters cut …]\n${shown.slice(-RECORD_STRING / 2)}`
      : shown;
  }
  if (Array.isArray(value))
    return value.map((entry) => cutStrings(entry, secrets));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        cutStrings(entry, secrets),
      ]),
    );
  return value;
}

/** The most `readRunFile` reads of one segment: a little over its bound. */
const SEGMENT_READ_MAX = ATTEMPT_HEAD + 1024 * 1024;

/**
 * An attempt file's text (`file` as its event names it, under `logs`):
 * its segments in order, read without following links, with a note where
 * the middle rotated away; redacted again with `secrets`. Undefined when
 * no segment is there (rotated away with its run, or never written).
 */
export function readRunFile(
  logs: string,
  file: string,
  secrets: readonly string[],
): { text: string; cut: boolean } | undefined {
  if (!/^\d+\/[\w.-]+\.attempts\/[\w.-]+$/.test(file)) return undefined;
  const dir = dirname(file);
  const name = basename(file);
  const segments = safeList(join(logs, dir))
    .filter(
      (entry) =>
        entry.startsWith(`${name}.`) &&
        /^\d+$/.test(entry.slice(name.length + 1)),
    )
    .map((entry) => Number(entry.slice(name.length + 1)))
    .sort((a, b) => a - b);
  if (!segments.length) return undefined;
  let text = "";
  let cut = false;
  let previous = -1;
  for (const segment of segments) {
    if (segment > previous + 1) {
      cut = true;
      text += "\n[… the middle rotated away …]\n";
    }
    previous = segment;
    try {
      text += readContained(
        logs,
        `${file}.${segment}`,
        SEGMENT_READ_MAX,
        true,
      ).toString("utf8");
    } catch {
      cut = true;
    }
  }
  return { text: redact(text, secrets), cut };
}

/** Factory's version: the nearest package.json above this module's. */
export function factoryVersion(): string | null {
  for (let dir = dirname(fileURLToPath(import.meta.url)); ; dir = dirname(dir))
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      return typeof pkg.version === "string" ? pkg.version : null;
    } catch {
      if (dirname(dir) === dir) return null;
    }
}

/** `text` within `bytes` of UTF-8, cut at a character boundary. */
function bounded(text: string, bytes: number): { text: string; cut: boolean } {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= bytes) return { text, cut: false };
  // A cut inside a character decodes to U+FFFD; drop it.
  return {
    text: buffer
      .subarray(0, bytes)
      .toString("utf8")
      .replace(/\uFFFD$/, ""),
    cut: true,
  };
}

/** One run log event: when, and what (step, event, outcome, ...). */
export type LogEvent = { at: string } & Record<string, unknown>;

/** The run log files of one Objective, oldest run first. */
export function logFiles(dir: string, issue: number): string[] {
  const issueDir = join(dir, String(issue));
  return safeList(issueDir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .map((name) => join(issueDir, name));
}

/**
 * The Objective's last `tail` events across its run logs, in time order,
 * and the byte offset each file was read to (the end of its last complete
 * line), so a follow carries on exactly there. Files are read back from
 * their end only as far as the events wanted, so the cost follows `tail`,
 * not history.
 */
export function readLog(
  dir: string,
  issue: number,
  tail: number,
): { events: LogEvent[]; ends: Map<string, number> } {
  const events: LogEvent[] = [];
  const ends = new Map<string, number>();
  // Newest run first: each file is read back from its end, a chunk at a
  // time, until it has the events still wanted or is read whole, so lines
  // of any length count and an older run is read only when needed.
  let wanted = tail;
  for (const file of logFiles(dir, issue).reverse()) {
    const end = lastLineEnd(file);
    ends.set(file, end);
    if (wanted <= 0) continue;
    let found: LogEvent[] = [];
    for (let chunk = TAIL_CHUNK; ; chunk *= 2) {
      const start = Math.max(0, end - chunk);
      found = parseLines(
        readFrom(file, start, end).toString("utf8"),
        start > 0,
      );
      if (found.length >= wanted || start === 0 || chunk >= TAIL_MAX) break;
    }
    found = found.slice(-wanted);
    wanted -= found.length;
    events.push(...ofRun(file, found));
  }
  return {
    events: events.sort((a, b) => a.at.localeCompare(b.at)).slice(-tail),
    ends,
  };
}

/** The offset after the file's last complete line: where a follow carries on. */
function lastLineEnd(file: string): number {
  const size = sizeOf(file);
  for (let to = size; to > 0; to -= TAIL_CHUNK) {
    const from = Math.max(0, to - TAIL_CHUNK);
    const newline = readFrom(file, from, to).lastIndexOf(10);
    if (newline >= 0) return from + newline + 1;
  }
  return 0;
}

/** `readLog`'s first read back from a file's end, doubled until it holds the events wanted. */
const TAIL_CHUNK = 64 * 1024;
/** The most `readLog` reads of one file. */
const TAIL_MAX = 256 * 1024 * 1024;

/**
 * The new complete lines of the Objective's run files since `offsets` (a
 * file not in it from its start), in time order; `offsets` moves past
 * them. A follow calls it with the offsets `readLog` returned.
 */
export function readNew(
  dir: string,
  issue: number,
  offsets: Map<string, number>,
): LogEvent[] {
  const fresh: LogEvent[] = [];
  for (const file of logFiles(dir, issue)) {
    const found: LogEvent[] = [];
    offsets.set(
      file,
      streamFile(file, offsets.get(file) ?? 0, (event) => found.push(event)),
    );
    fresh.push(...ofRun(file, found));
  }
  return fresh.sort((a, b) => a.at.localeCompare(b.at));
}

/** Bytes `streamFile` reads per chunk; a line longer than STREAM_LINE is skipped. */
const STREAM_CHUNK = 1024 * 1024;
const STREAM_LINE = 16 * 1024 * 1024;

/**
 * Read `file` from byte `from` in chunks, passing each complete event to
 * `visit`; returns the offset after the last complete line, where a follow
 * carries on. A large file costs time, not memory.
 */
export function streamFile(
  file: string,
  from: number,
  visit: (event: LogEvent) => void,
): number {
  const size = sizeOf(file);
  let position = from;
  let done = from;
  let rest = Buffer.alloc(0);
  let skipping = false;
  while (position < size) {
    const chunk = readFrom(
      file,
      position,
      Math.min(size, position + STREAM_CHUNK),
    );
    if (!chunk.length) break;
    position += chunk.length;
    let bytes = rest.length ? Buffer.concat([rest, chunk]) : chunk;
    if (skipping) {
      // Inside an overlong line: drop it through its newline.
      const end = bytes.indexOf(10);
      if (end < 0) {
        done += bytes.length;
        rest = Buffer.alloc(0);
        continue;
      }
      done += end + 1;
      bytes = bytes.subarray(end + 1);
      skipping = false;
    }
    const complete = completeLines(bytes);
    for (const event of parseLines(complete.toString("utf8"))) visit(event);
    done += complete.length;
    rest = Buffer.from(bytes.subarray(complete.length));
    if (rest.length > STREAM_LINE) {
      done += rest.length;
      rest = Buffer.alloc(0);
      skipping = true;
    }
  }
  return done;
}

/** Each event marked with the run whose file it was read from. */
function ofRun(file: string, events: LogEvent[]): LogEvent[] {
  const run = runOfFile(file);
  for (const event of events) event.run ??= run;
  return events;
}

/**
 * Call `poll` every `everyMs` until SIGINT, SIGTERM or `signal`, or until
 * it returns a result (anything but undefined): a follow's loop. Returns
 * that result, undefined when interrupted. `started` runs once the signals
 * are caught: what tells a person (or a script) that Ctrl-C now stops the
 * follow goes there, so a signal sent on seeing it never meets Node's
 * default exit.
 */
export async function untilInterrupted<T>(
  poll: () => T | undefined | Promise<T | undefined>,
  signal?: AbortSignal,
  everyMs = 500,
  started?: () => void,
): Promise<T | undefined> {
  let stop = signal?.aborted ?? false;
  const stopping = () => {
    stop = true;
  };
  process.once("SIGINT", stopping);
  process.once("SIGTERM", stopping);
  signal?.addEventListener("abort", stopping, { once: true });
  try {
    started?.();
    while (!stop) {
      await new Promise((resolve) => setTimeout(resolve, everyMs));
      if (stop) break;
      const result = await poll();
      if (result !== undefined) return result;
    }
    return undefined;
  } finally {
    process.off("SIGINT", stopping);
    process.off("SIGTERM", stopping);
    signal?.removeEventListener("abort", stopping);
  }
}

/** The issues with a run log directory, in number order (0, the service's, excluded). */
export function loggedIssues(dir: string): number[] {
  return safeList(dir)
    .map(Number)
    .filter((issue) => Number.isInteger(issue) && issue > 0)
    .sort((a, b) => a - b);
}

/** The bytes up to and including the last newline: the complete lines. */
function completeLines(bytes: Buffer): Buffer {
  return bytes.subarray(0, bytes.lastIndexOf(10) + 1);
}

/** The bytes of `file` from `start` to `end`; empty when it can't be read. */
function readFrom(file: string, start: number, end: number): Buffer {
  if (end <= start) return Buffer.alloc(0);
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buffer = Buffer.alloc(end - start);
    const read = readSync(fd, buffer, 0, buffer.length, start);
    return buffer.subarray(0, read);
  } catch {
    return Buffer.alloc(0);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Complete JSON lines as events; with `partialFirst`, the first line was cut and is dropped. */
function parseLines(text: string, partialFirst = false): LogEvent[] {
  const lines = text.split("\n");
  if (partialFirst) lines.shift();
  const events: LogEvent[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as LogEvent;
      if (typeof event.at === "string") events.push(event);
    } catch {
      // A line still being written, or a torn one: skipped.
    }
  }
  return events;
}

export interface Retention {
  runsPerObjective: number;
  totalBytes: number;
}

const DEFAULT_RETENTION: Retention = {
  runsPerObjective: 20,
  totalBytes: 2 * 1024 ** 3,
};

/** A run whose files changed this recently may still be written: rotation keeps it. */
const LIVE_MS = 10 * 60 * 1000;

/**
 * Keep the newest runs per Objective, then the newest runs overall within
 * the byte cap. A run is its log file, its capture directory and its
 * attempt directory, removed together. Run ids sort by start time, so id order is age order. The
 * `active` run (the caller's own) and any run changed in the last 10
 * minutes (a `factory dream` call still running) are never removed; they
 * still count toward both bounds.
 */
export function rotateLogs(
  dir: string,
  active?: string,
  retention = DEFAULT_RETENTION,
): void {
  const now = Date.now();
  const kept = (id: string, paths: string[]) =>
    id === active ||
    paths.some((path) => {
      try {
        return now - statSync(path).mtimeMs < LIVE_MS;
      } catch {
        return false;
      }
    });
  const runs: { paths: string[]; id: string; bytes: number }[] = [];
  for (const issue of safeList(dir)) {
    const issueDir = join(dir, issue);
    const byRun = new Map<string, string[]>();
    for (const name of safeList(issueDir)) {
      const id = runOfFile(name);
      byRun.set(id, [...(byRun.get(id) ?? []), join(issueDir, name)]);
    }
    const ids = [...byRun.keys()].sort();
    const excess = ids.length - retention.runsPerObjective;
    ids.forEach((id, i) => {
      const paths = byRun.get(id)!;
      if (i < excess && !kept(id, paths)) remove(paths);
      else runs.push({ paths, id, bytes: paths.reduce(addSize, 0) });
    });
  }
  runs.sort((a, b) => (a.id < b.id ? 1 : -1));
  let total = 0;
  for (const run of runs) {
    total += run.bytes;
    if (total > retention.totalBytes && !kept(run.id, run.paths))
      remove(run.paths);
  }
}

/** Remove a run's files; one that can't be removed now is tried again at the next pass. */
function remove(paths: string[]): void {
  for (const path of paths)
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Busy or not ours: the next rotation tries again.
    }
}

/** A file's size, or a capture directory's files' sizes. */
function addSize(sum: number, path: string): number {
  const own = sizeOf(path);
  try {
    if (statSync(path).isDirectory())
      return safeList(path).reduce(
        (inner, name) => inner + sizeOf(join(path, name)),
        sum,
      );
  } catch {
    // Gone meanwhile: counts nothing.
  }
  return sum + own;
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Tokens, JWTs, bearer headers and the named secret values, line by line, as [REDACTED]. */
export function redact(value: string, secrets: readonly string[] = []): string {
  let result = value
    .replace(
      /\b(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}\b/g,
      "[REDACTED]",
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g,
      "[REDACTED]",
    )
    .replace(/(Authorization:\s*Bearer\s+)\S+/gi, "$1[REDACTED]");
  for (const secret of secrets)
    for (const line of secret.split(/\r?\n/))
      if (line.length) result = result.split(line).join("[REDACTED]");
  return result;
}
