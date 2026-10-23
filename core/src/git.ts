import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { TransientError } from "./github.js";
import { errorMessage } from "./text.js";

const run = promisify(execFile);
const MINUTE = 60_000;

/**
 * Configuration pinned for every Factory Git call, as GIT_CONFIG_* entries:
 * they outrank the repository's own configuration, so worker-planted config
 * or attributes can't run a program outside the sandbox.
 */
const PINNED: [string, string][] = [
  ["maintenance.auto", "false"],
  ["gc.auto", "0"],
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
  // Never descend into a submodule: its configuration is not Factory's.
  ["diff.ignoreSubmodules", "all"],
  ["submodule.recurse", "false"],
  ["core.alternateRefsCommand", ""],
  ["commit.gpgSign", "false"],
  ["tag.gpgSign", "false"],
  ["push.gpgSign", "false"],
  ["merge.verifySignatures", "false"],
  ["log.showSignature", "false"],
  ["protocol.ext.allow", "never"],
  ["protocol.git.allow", "never"],
  ["remote.origin.uploadpack", "git-upload-pack"],
  ["remote.origin.receivepack", "git-receive-pack"],
  // An empty helper clears every helper configured before it.
  ["credential.helper", ""],
  ["core.askPass", ""],
];

/**
 * Git without the operator's configuration: no system or global
 * configuration, no system attributes, no replace objects, no lazy fetch,
 * LFS skip-smudge, literal pathspecs, and the pins above. PATH keeps only
 * absolute entries: Git runs in a tree a worker wrote, so a relative or
 * empty entry would find its helpers (git-lfs, git-<command>) there.
 */
export function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith("GIT_")) delete env[key];
  if (env.PATH !== undefined)
    env.PATH = env.PATH.split(":")
      .filter((entry) => entry.startsWith("/"))
      .join(":");
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_CONFIG_COUNT: String(PINNED.length),
  });
  PINNED.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

export interface GitExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  /** At most the first 4 KiB, trimmed. */
  stderr: string;
}

/**
 * Run Git in `directory` with `env` (gitEnvironment by default) and report
 * how it exited. No timeout unless `timeoutMs` is given.
 */
export function pinnedGitExit(
  directory: string,
  args: string[],
  options: {
    input?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    /** Standard output to this file descriptor, or dropped, instead of returned. */
    stdout?: number | "ignore";
  } = {},
): Promise<GitExit> {
  return new Promise((done, failed) => {
    const child = spawn("git", ["-C", directory, ...args], {
      env: options.env ?? gitEnvironment(),
      stdio: ["pipe", options.stdout ?? "pipe", "pipe"],
      ...(options.timeoutMs !== undefined && {
        timeout: options.timeoutMs,
        killSignal: "SIGKILL" as const,
      }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const out: Buffer[] = [];
    let err = "";
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      if (err.length < 4096) err += chunk.toString("utf8");
    });
    child.on("error", failed);
    child.on("close", (code, signal) =>
      done({ code, signal, stdout: Buffer.concat(out), stderr: err.trim() }),
    );
    child.stdin?.on("error", () => {
      // git may exit before reading stdin; its exit code reports the failure.
    });
    child.stdin?.end(options.input ?? "");
  });
}

/** Runs one `git cat-file` with `input` on standard input; its output. */
export type CatFile = (args: string[], input: string) => Promise<Buffer>;

/**
 * The exact bytes of these blobs, in order, from one `cat-file --batch`.
 * Each header must be `<oid> blob <size>`: a missing object, or one that is
 * not a blob, throws instead of misreading every object after it.
 */
export async function readBlobs(
  catFile: CatFile,
  oids: readonly string[],
): Promise<Buffer[]> {
  if (!oids.length) return [];
  const output = await catFile(
    ["cat-file", "--batch"],
    oids.map((oid) => `${oid}\n`).join(""),
  );
  let offset = 0;
  return oids.map((oid) => {
    const newline = output.indexOf(10, offset);
    const header = output
      .subarray(offset, newline < 0 ? undefined : newline)
      .toString("utf8");
    const [named, type, size] = header.split(" ");
    const bytes = Number(size);
    const end = newline + 1 + bytes;
    if (
      newline < 0 ||
      named !== oid ||
      type !== "blob" ||
      !Number.isSafeInteger(bytes) ||
      end > output.length
    )
      throw new Error(`git cat-file returned "${header}" for ${oid}`);
    offset = end + 1;
    return output.subarray(newline + 1, end);
  });
}

/**
 * The sizes of these objects that are blobs, by object id, from one
 * `cat-file --batch-check`; a missing object or a non-blob has no entry.
 */
export async function blobSizes(
  catFile: CatFile,
  oids: readonly string[],
): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  if (!oids.length) return sizes;
  const output = await catFile(
    ["cat-file", "--batch-check"],
    oids.map((oid) => `${oid}\n`).join(""),
  );
  for (const line of output.toString("utf8").split("\n")) {
    const [oid, type, size] = line.split(" ");
    if (oid && type === "blob" && Number.isSafeInteger(Number(size)))
      sizes.set(oid, Number(size));
  }
  return sizes;
}

/** The lowercase hex SHA-256 of `bytes`. */
export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const LFS_POINTER_HEADER = "version https://git-lfs.github.com/spec/v1\n";
/** Git LFS reads blobs up to this size as possible pointers. */
export const LFS_POINTER_MAX_BYTES = 1024;

/** A Git LFS pointer's object id (sha256) and size, or undefined. */
export function lfsPointer(
  bytes: Buffer,
): { oid: string; size: number } | undefined {
  if (bytes.length > LFS_POINTER_MAX_BYTES) return undefined;
  const body = bytes.toString("utf8");
  if (!body.startsWith(LFS_POINTER_HEADER)) return undefined;
  const oid = /^oid sha256:([0-9a-f]{64})$/m.exec(body)?.[1];
  const size = /^size (\d+)$/m.exec(body)?.[1];
  return oid && size ? { oid, size: Number(size) } : undefined;
}

/**
 * Git with the operator's configuration, which holds credentials and
 * insteadOf rewrites: never prompting, with C messages. Returns standard
 * output; a non-zero exit rejects with execFile's error (code, stdout).
 */
export async function operatorGit(
  checkout: string,
  args: string[],
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string> {
  const { LANGUAGE: _language, LC_ALL: _all, ...env } = process.env;
  const { stdout } = await run("git", ["-C", checkout, ...args], {
    env: { ...env, GIT_TERMINAL_PROMPT: "0", LC_MESSAGES: "C" },
    encoding: "utf8",
    timeout: options.timeoutMs ?? MINUTE,
    maxBuffer: 16 * 1024 * 1024,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return stdout;
}

/**
 * Fetch the target and return its default branch head. Runs with the
 * operator's configuration, which holds the fetch credentials.
 */
export async function defaultHead(
  checkout: string,
  signal: AbortSignal,
): Promise<string> {
  try {
    await operatorGit(checkout, ["fetch", "--quiet", "--prune", "origin"], {
      signal,
      timeoutMs: 5 * MINUTE,
    });
    await operatorGit(checkout, ["remote", "set-head", "origin", "--auto"], {
      signal,
    });
    return (
      await operatorGit(
        checkout,
        ["rev-parse", "--verify", "refs/remotes/origin/HEAD^{commit}"],
        { signal },
      )
    ).trim();
  } catch (error) {
    if (signal.aborted) throw error;
    throw new TransientError(
      `git fetch in ${checkout}: ${errorMessage(error)}`,
    );
  }
}
