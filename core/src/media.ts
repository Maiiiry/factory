/**
 * Media: Work Items that take files as input and produce candidate asset
 * sets a person picks from, delivered through Git LFS. Every function
 * returns its answer as data (`MediaOutcome`), never a throw for a
 * deterministic problem; a failed Git read or a dropped connection throws,
 * and the calling step retries.
 *
 * The flow, as the item steps call it:
 *
 *   work      resolveInputs → (prepareWorkPrompt stages them) → worker →
 *             captureAssets → collect → destinationFinding
 *   select    selectionQuestion / readSelection → materializeSelection
 *   validate  validationMembers → hydrateSelected (in the fresh checkout) →
 *             commands → rewrittenMedia
 *   publish   lfsPushIfPointers, called by delivery's publish before it pushes
 *   final     validationMembers → verifyOriginMedia
 *
 * Bytes live as plain files under the Objective's private work directory
 * (`mediaDirectory`), with their sha256 and size in the step's done result;
 * anything committed lives in Git LFS's own content-addressed store.
 *
 * Hold answers: a media hold is the calling step's hold, so the step gets
 * the answer back on its next run and must route each named answer:
 * `retry` runs the step again; `replan` takes the step's replan route (as
 * for an item that can't be done as planned); `repair` returns repair to
 * the work step; `cancel` is the engine's. Each function names the answers
 * its holds can carry. The select step checks `replan` BEFORE readSelection,
 * which knows only set ids and `repair`.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  createWriteStream,
  lstatSync,
} from "node:fs";
import { chmod, copyFile, mkdir, rm, unlink } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebStream } from "node:stream/web";
import { hold } from "./engine.js";
import {
  batchObjects,
  LFS_POINTER_MAX_BYTES,
  lfsPointer,
  operatorGit,
  sha256,
} from "./git.js";
import { validPath } from "./objective.js";
import {
  ContainedError,
  copyContained,
  forceRemove,
  openParent,
  readContained,
} from "./paths.js";
import { isRecord, ownsPath } from "./planning/graph.js";
import type { Plan, SourceAssetBinding, WorkItem } from "./planning/types.js";
import { errorMessage } from "./text.js";
import {
  FACTORY_EMAIL,
  privateStagingPath,
  scanStaging,
} from "./work/collect.js";
import {
  addWorktree,
  hasGitlink,
  hostGit,
  hostGitExit,
  originProblem,
  removeWorktree,
} from "./worktree.js";

const MINUTE = 60_000;
const MIB = 1024 * 1024;
/** GitHub accepts attachments up to 100 MB; the bound leaves room above that. */
const MAX_ATTACHMENT_BYTES = 256 * MIB;
/** GitHub's smallest Git LFS file limit (Free and Pro plans). */
const MAX_MEMBER_BYTES = 2 * 1024 * MIB;
/** All members one capture keeps, so a worker can't fill the work directory. */
const MAX_CAPTURE_BYTES = 8 * 1024 * MIB;
const MAX_MANIFEST_BYTES = 1 * MIB;

/** A media answer: a step maps each kind onto its own outcome. */
export type MediaOutcome<T> =
  | { kind: "done"; value: T }
  /** The worker's result is wrong; the finding goes back to the work step. */
  | { kind: "repair"; finding: string }
  | { kind: "hold"; question: string; answers: string[]; recommended: string }
  /** Transient; `repushed` is set once verifyOriginMedia has re-pushed, for the step to keep. */
  | { kind: "retry"; reason: string; repushed?: true };

/** Where a set came from and on what terms it may be used. */
export interface Provenance {
  source: string;
  rights: string;
  visibility: "private" | "repository";
  lineage: string[];
}

/** One captured member: Factory's private copy, its digest and where it goes. */
export interface CapturedMember {
  role: string;
  destination: string;
  mediaType: string;
  sha256: string;
  bytes: number;
  /** Factory's copy, absolute, under the item's media directory. */
  file: string;
  /** Opaque `{source, values}` an authoritative tool supplied. */
  formatMetadata?: unknown;
}

/** A candidate set as capture checked it; the work step's done result carries these. */
export interface CandidateSet {
  id: string;
  members: CapturedMember[];
  provenance: Provenance;
  relationships?: unknown;
  production?: unknown;
}

/** The select step's done result. */
export interface Selection {
  /** The commit that adds the selected bytes to the work commit; later steps use it. */
  commit: string;
  tree: string;
  set: CandidateSet;
  /** Direct dependents that receive the set as read-only inputs. */
  bound: string[];
}

/** A file a worker gets read-only under `.factory-inputs/assets`. */
export interface MediaInput {
  /** An Objective source asset, or a dependency's selected member. */
  origin: "source" | "selected";
  role: string;
  mediaType: string;
  sha256: string;
  bytes: number;
  /** Factory's private copy, absolute; never shown to the worker. */
  file: string;
  /** Sources: the binding's kind and path. */
  kind?: NonNullable<SourceAssetBinding["kind"]>;
  path?: string;
  visibility?: "private" | "repository";
  /** Selected members: where they came from and where they sit in the checkout. */
  fromItem?: string;
  set?: string;
  destination?: string;
  provenance?: Provenance;
  formatMetadata?: unknown;
}

/** A selected member a validation or final check expects in a tree. */
export interface SelectedMember {
  item: string;
  set: string;
  role: string;
  destination: string;
  sha256: string;
  bytes: number;
  /** Its item lists the role in requiredLfsRoles, so the tree must hold its pointer. */
  required: boolean;
}

/**
 * Git LFS's own filter for one call, instead of `git lfs install --local`
 * writing the shared configuration. These are the exact values worktree.ts
 * allows in repository configuration.
 */
const LFS = [
  "-c",
  "filter.lfs.clean=git-lfs clean -- %f",
  "-c",
  "filter.lfs.smudge=git-lfs smudge -- %f",
  "-c",
  "filter.lfs.process=git-lfs filter-process",
  "-c",
  "filter.lfs.required=true",
];
/** Set and role ids; set ids are also hold answers. */
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
/** Answers a select hold has besides the set ids. */
const RESERVED = new Set(["repair", "retry", "replan", "cancel", "answer"]);

/** A deterministic problem with the worker's candidates. */
class Finding extends Error {}

/** The item's private media directory: `<workDir>/assets/<item>`. Pass `deps.workDir(issue)`. */
export function mediaDirectory(workDir: string, itemId: string): string {
  return join(workDir, "assets", itemId);
}

/** Whether the item produces candidate sets, so it has a select step between work and validate. */
export function needsSelection(item: WorkItem): boolean {
  return Boolean(item.expectedOutputRoles?.length);
}

// ── Inputs ──────────────────────────────────────────────────────────────

export interface InputsRequest {
  /** The operator's checkout: base blobs, the LFS store and origin. */
  checkout: string;
  /** `owner/name`, for the origin check before an LFS fetch. */
  repository: string;
  /** The item's media directory (`mediaDirectory`). */
  directory: string;
  plan: Plan;
  item: WorkItem;
  /** The commit the item's worktree starts from: repository sources are read there. */
  base: string;
  /** Each dependency's select result, when it has one. */
  selection(itemId: string): Selection | undefined;
  /** The service's GitHub token, for attachments; the worker never sees it. */
  githubToken(): Promise<string>;
  signal: AbortSignal;
}

/**
 * Every file the item's worker reads as input: its source assets (a base
 * blob, LFS bytes from the local store or origin, a private local file or
 * a GitHub attachment) and the selected members its dependencies bound to
 * it. Each is copied fresh into `<directory>/inputs/` with its digest; pass
 * the list to prepareWorkPrompt as `mediaInputs`, which stages them.
 *
 * Step: call before prepareWorkPrompt on every attempt. done → pass on;
 * retry → retry; hold → hold. Its holds carry `retry` (run the work step
 * again), `replan` (the work step's replan route) and `cancel`; a source
 * attachment over its byte bound holds with `replan` and `cancel` only.
 */
export async function resolveInputs(
  request: InputsRequest,
): Promise<MediaOutcome<MediaInput[]>> {
  const { item, signal } = request;
  const root = join(request.directory, "inputs");
  await forceRemove(root);
  const inputs: MediaInput[] = [];
  for (const [index, binding] of (item.sourceAssets ?? []).entries()) {
    const file = join(root, `source-${index}`);
    const kind = binding.kind ?? "repository";
    const copied =
      kind === "repository"
        ? await repositorySource(request, binding.path, file)
        : kind === "local"
          ? await localSource(binding.path, file)
          : await attachmentSource(request, binding.path, file);
    if (copied.kind !== "done") return copied;
    inputs.push({
      origin: "source",
      role: binding.role,
      mediaType: binding.mediaType,
      ...copied.value,
      file,
      kind,
      path: binding.path,
      visibility: binding.visibility,
    });
    signal.throwIfAborted();
  }
  for (const dependency of item.dependencies) {
    const selection = request.selection(dependency);
    if (!selection?.bound.includes(item.id)) continue;
    for (const member of selection.set.members) {
      const held = await digestFile(member.file).catch(() => undefined);
      if (held?.sha256 !== member.sha256 || held.bytes !== member.bytes)
        return hold(
          `Factory's copy of ${dependency}'s selected ${member.role} (${member.file}) is missing or changed, so Work Item ${item.id} can't get it as input. Restore it and answer retry, or answer replan or cancel.`,
          ["retry", "replan", "cancel"],
        );
      inputs.push({
        origin: "selected",
        role: member.role,
        mediaType: member.mediaType,
        sha256: member.sha256,
        bytes: member.bytes,
        file: member.file,
        fromItem: dependency,
        set: selection.set.id,
        destination: member.destination,
        provenance: selection.set.provenance,
        ...(member.formatMetadata !== undefined && {
          formatMetadata: member.formatMetadata,
        }),
      });
    }
  }
  return { kind: "done", value: inputs };
}

type Copied = MediaOutcome<{ sha256: string; bytes: number }>;

/** A file tracked at the base; an LFS pointer is resolved to its bytes. */
async function repositorySource(
  request: InputsRequest,
  path: string,
  file: string,
): Promise<Copied> {
  const { checkout, base, signal } = request;
  const blob = await hostGitExit(
    checkout,
    ["cat-file", "blob", `${base}:${path}`],
    {
      signal,
    },
  );
  if (blob.code !== 0)
    return hold(
      `Source asset ${path} is not a file at ${base.slice(0, 12)}, where Work Item ${request.item.id} starts. Answer replan to cite one that is, or cancel.`,
      ["replan", "cancel"],
    );
  const lfs = lfsPointer(blob.stdout);
  if (!lfs) {
    await mkdir(join(file, ".."), { recursive: true, mode: 0o700 });
    await pipeline(
      Readable.from([blob.stdout]),
      createWriteStream(file, { mode: 0o600 }),
    );
    return {
      kind: "done",
      value: { sha256: sha256(blob.stdout), bytes: blob.stdout.length },
    };
  }
  let stored = await lfsObject(checkout, lfs.oid, signal);
  if (!stored) {
    const fetched = await lfsFetch(request, base, path);
    if (fetched) return fetched;
    stored = await lfsObject(checkout, lfs.oid, signal);
  }
  if (!stored)
    return hold(
      `Source asset ${path} is a Git LFS pointer whose object origin did not serve (oid ${lfs.oid}). Push the object to origin's LFS storage and answer retry, or replan or cancel.`,
      ["retry", "replan", "cancel"],
    );
  return copyChecked(stored, file, lfs);
}

/** `git lfs fetch` of one path at `commit` into the checkout's store. */
async function lfsFetch(
  request: Pick<InputsRequest, "checkout" | "repository" | "signal">,
  commit: string,
  path: string,
): Promise<MediaOutcome<never> | undefined> {
  const problem = await originProblem(
    request.checkout,
    request.repository,
    request.signal,
  );
  if (problem)
    return hold(
      `${problem}. Factory fetches LFS objects from origin's default route. Fix origin, then answer retry; or cancel.`,
    );
  try {
    await operatorGit(
      request.checkout,
      [
        "-c",
        "protocol.file.allow=never",
        ...LFS,
        "lfs",
        "fetch",
        "origin",
        commit,
        "--include",
        path,
      ],
      { signal: request.signal, timeoutMs: 30 * MINUTE },
    );
  } catch (error) {
    request.signal.throwIfAborted();
    return {
      kind: "retry",
      reason: `git lfs fetch of ${path}: ${errorMessage(error)}`,
    };
  }
  return undefined;
}

/**
 * A private file the Objective names; planning checked the binding. It is
 * read without following any link on its absolute path.
 */
async function localSource(path: string, file: string): Promise<Copied> {
  await mkdir(join(file, ".."), { recursive: true, mode: 0o700 });
  try {
    if (!isAbsolute(path))
      throw new ContainedError(`${path} is not an absolute path`);
    return {
      kind: "done",
      value: await copyContained(
        "/",
        path.slice(1),
        file,
        Number.MAX_SAFE_INTEGER,
      ),
    };
  } catch (error) {
    if (!(error instanceof ContainedError)) throw error;
    return hold(
      `Local source asset ${path} can't be read: ${error.message}. Put a regular file there, reached without links, and answer retry; or replan or cancel.`,
      ["retry", "replan", "cancel"],
    );
  }
}

/** Hosts an attachment may redirect to. */
function attachmentHost(host: string): boolean {
  return host === "github.com" || host.endsWith(".githubusercontent.com");
}

/** A download that passed MAX_ATTACHMENT_BYTES. */
class TooLarge extends Error {}

/**
 * A GitHub attachment the Objective names, with the service's token sent
 * only to the URL itself; at most 5 redirects, only to GitHub content
 * hosts, never an HTML page, at most MAX_ATTACHMENT_BYTES, and 30 minutes
 * for the whole download.
 */
async function attachmentSource(
  request: InputsRequest,
  path: string,
  file: string,
): Promise<Copied> {
  const refused = (why: string): Copied =>
    hold(
      `GitHub attachment ${path} ${why}. Check the attachment and Factory's GitHub login, then answer retry; or replan or cancel.`,
      ["retry", "replan", "cancel"],
    );
  const tooLarge = (bytes?: number): Copied =>
    hold(
      `GitHub attachment ${path} is larger than Factory's bound of ${MAX_ATTACHMENT_BYTES} bytes for an attachment${bytes ? ` (${bytes} bytes)` : ""}. Answer replan to cite a smaller file (or put it in the repository through Git LFS), or cancel.`,
      ["replan", "cancel"],
    );
  const token = await request.githubToken();
  const deadline = AbortSignal.any([
    request.signal,
    AbortSignal.timeout(30 * MINUTE),
  ]);
  let url = path;
  for (let redirect = 0; redirect <= 5; redirect++) {
    let response: Response;
    try {
      response = await fetch(url, {
        redirect: "manual",
        headers: url === path ? { authorization: `Bearer ${token}` } : {},
        signal: deadline,
      });
    } catch (error) {
      request.signal.throwIfAborted();
      return {
        kind: "retry",
        reason: `Downloading ${path}: ${errorMessage(error)}`,
      };
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) return refused("redirected without a location");
      const next = new URL(location, url);
      if (next.protocol !== "https:" || !attachmentHost(next.hostname))
        return refused(
          `redirected outside GitHub's content hosts (${next.hostname})`,
        );
      url = next.href;
      continue;
    }
    if (response.status === 429 || response.status >= 500)
      return {
        kind: "retry",
        reason: `Downloading ${path}: HTTP ${response.status}`,
      };
    if (!response.ok || !response.body)
      return refused(`could not be downloaded (HTTP ${response.status})`);
    if ((response.headers.get("content-type") ?? "").startsWith("text/html"))
      return refused("answered with an HTML page instead of the file");
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_ATTACHMENT_BYTES) {
      await response.body.cancel();
      return tooLarge(declared);
    }
    await mkdir(join(file, ".."), { recursive: true, mode: 0o700 });
    try {
      let received = 0;
      await pipeline(
        Readable.fromWeb(response.body as WebStream),
        async function* (source: AsyncIterable<Buffer>) {
          for await (const chunk of source) {
            received += chunk.length;
            if (received > MAX_ATTACHMENT_BYTES) throw new TooLarge();
            yield chunk;
          }
        },
        createWriteStream(file, { mode: 0o600 }),
      );
    } catch (error) {
      await rm(file, { force: true });
      if (error instanceof TooLarge) return tooLarge();
      request.signal.throwIfAborted();
      return {
        kind: "retry",
        reason: `Downloading ${path}: ${errorMessage(error)}`,
      };
    }
    return { kind: "done", value: await digestFile(file) };
  }
  return refused("redirected more than 5 times");
}

/**
 * Copy each input read-only into `<worktree>/.factory-inputs/assets/`,
 * which the caller made fresh, and name each copy by its checkout-relative
 * path. prepareWorkPrompt calls it; collection never commits it.
 */
export async function stageInputs(
  worktree: string,
  inputs: readonly MediaInput[],
): Promise<(Omit<MediaInput, "file"> & { staged: string })[]> {
  if (!inputs.length) return [];
  const root = join(worktree, ".factory-inputs", "assets");
  await mkdir(root, { mode: 0o700 });
  const staged: (Omit<MediaInput, "file"> & { staged: string })[] = [];
  for (const [index, { file, ...input }] of inputs.entries()) {
    const name = `${index}-${safeName(input.destination ?? input.path ?? input.role)}`;
    await copyFile(file, join(root, name));
    await chmod(join(root, name), 0o400);
    staged.push({ ...input, staged: `.factory-inputs/assets/${name}` });
  }
  return staged;
}

/** A file name from the last part of a path or URL, kept to safe characters. */
function safeName(path: string): string {
  return (
    basename(path)
      .replace(/[^A-Za-z0-9._-]/g, "_")
      .slice(-80) || "input"
  );
}

// ── Capture ─────────────────────────────────────────────────────────────

/**
 * Check the worker's candidate sets and keep their bytes. Reads
 * `.factory-assets.json` (at most MAX_MANIFEST_BYTES) and secret-scans its
 * exact bytes, since its text reaches the select question; checks ids,
 * roles, owned and unique destinations, provenance, the minimum set count
 * and distinct content; then copies each member from `.factory-media/`,
 * reached without links, to `<directory>/candidates/<set>/<role>-<name>`
 * with its sha256 and size (at most MAX_MEMBER_BYTES each and
 * MAX_CAPTURE_BYTES in all), and removes `.factory-media`.
 *
 * Step: call right after the worker finishes and BEFORE collect (collect
 * deletes the manifest). Items without expectedOutputRoles get done [].
 * done → keep `value` for the work result (`sets`); repair → repair to
 * work with the finding; retry → retry (the secret scanner couldn't run);
 * hold → hold. The hold is collect's secret hold, with `repair` (repair to
 * work), `retry` (run the work step's collection again) and `cancel`:
 * route it as the step routes collect's. After collect, call
 * destinationFinding.
 */
export async function captureAssets(input: {
  /** The target checkout: the operator's Secretlint config lies outside it. */
  checkout: string;
  worktree: string;
  item: WorkItem;
  directory: string;
  signal: AbortSignal;
}): Promise<MediaOutcome<CandidateSet[]>> {
  const { worktree, item } = input;
  if (!needsSelection(item)) return { kind: "done", value: [] };
  const candidates = join(input.directory, "candidates");
  await forceRemove(candidates);
  try {
    const manifest = readContained(
      worktree,
      ".factory-assets.json",
      MAX_MANIFEST_BYTES,
    );
    const stopped = await scanStaging(input, ".factory-assets.json", manifest);
    if (stopped) return stopped;
    const sets = readManifest(manifest, item);
    const captured: CandidateSet[] = [];
    let total = 0;
    for (const set of sets) {
      const members: CapturedMember[] = [];
      for (const member of set.members) {
        const file = join(
          candidates,
          set.id.toLowerCase(),
          `${member.role}-${safeName(member.path)}`,
        );
        await mkdir(join(file, ".."), { recursive: true, mode: 0o700 });
        const copied = await copyContained(
          worktree,
          member.path,
          file,
          Math.min(MAX_MEMBER_BYTES, MAX_CAPTURE_BYTES - total),
        );
        total += copied.bytes;
        members.push({
          role: member.role,
          destination: member.destination,
          mediaType: member.mediaType,
          ...copied,
          file,
          ...(member.formatMetadata !== undefined && {
            formatMetadata: member.formatMetadata,
          }),
        });
      }
      captured.push({
        id: set.id,
        members,
        provenance: set.provenance,
        ...(set.relationships !== undefined && {
          relationships: set.relationships,
        }),
        ...(set.production !== undefined && { production: set.production }),
      });
    }
    const contents = captured.map((set) =>
      JSON.stringify(
        set.members.map(({ role, sha256 }) => [role, sha256]).sort(),
      ),
    );
    if (new Set(contents).size !== contents.length)
      throw new Finding(
        "Two candidate sets have the same content; each set must differ",
      );
    await forceRemove(join(worktree, ".factory-media"));
    return { kind: "done", value: captured };
  } catch (error) {
    if (error instanceof Finding || error instanceof ContainedError) {
      await forceRemove(candidates);
      return {
        kind: "repair",
        finding: `Candidate sets refused: ${error.message}. Stage each set as regular files under a real .factory-media/ directory (at most ${MAX_MEMBER_BYTES} bytes a member, ${MAX_CAPTURE_BYTES} in all) and describe it in .factory-assets.json (at most ${MAX_MANIFEST_BYTES} bytes) as the media instructions say.`,
      };
    }
    throw error;
  }
}

interface DeclaredMember {
  role: string;
  path: string;
  mediaType: string;
  destination: string;
  formatMetadata?: unknown;
}

interface DeclaredSet {
  id: string;
  members: DeclaredMember[];
  provenance: Provenance;
  relationships?: unknown;
  production?: unknown;
}

const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/** `.factory-assets.json`'s bytes, decoded and checked once, here. */
function readManifest(bytes: Buffer, item: WorkItem): DeclaredSet[] {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Finding(".factory-assets.json is not JSON");
  }
  if (!isRecord(value) || !Array.isArray(value.sets))
    throw new Finding(
      ".factory-assets.json must be an object with a sets array",
    );
  const minimum = item.minimumAssetSets ?? 1;
  if (value.sets.length < minimum)
    throw new Finding(
      `${value.sets.length} set(s) declared; produce at least ${minimum}`,
    );
  const ids = new Set<string>();
  return value.sets.map((raw): DeclaredSet => {
    if (!isRecord(raw) || !text(raw.id) || !ID.test(raw.id))
      throw new Finding(
        "Every set needs an id of letters, digits, - and _ starting with a letter or digit",
      );
    const id = raw.id;
    if (ids.has(id.toLowerCase()) || RESERVED.has(id.toLowerCase()))
      throw new Finding(
        `Set id ${id} is repeated (ids ignore case) or reserved (${[...RESERVED].join(", ")})`,
      );
    ids.add(id.toLowerCase());
    const provenance = raw.provenance;
    if (
      !isRecord(provenance) ||
      !text(provenance.source) ||
      !text(provenance.rights) ||
      (provenance.visibility !== "private" &&
        provenance.visibility !== "repository") ||
      !Array.isArray(provenance.lineage) ||
      !provenance.lineage.every((entry) => typeof entry === "string")
    )
      throw new Finding(
        `Set ${id} needs provenance with source, rights, visibility (private or repository) and lineage`,
      );
    if (!Array.isArray(raw.members) || !raw.members.length)
      throw new Finding(`Set ${id} has no members`);
    const roles = new Set<string>();
    const destinations = new Set<string>();
    const members = raw.members.map((member): DeclaredMember => {
      if (
        !isRecord(member) ||
        !text(member.role) ||
        !ID.test(member.role) ||
        !text(member.path) ||
        !text(member.mediaType) ||
        !text(member.destination)
      )
        throw new Finding(
          `Set ${id} has a member without role, path, mediaType and destination`,
        );
      const { role, path, destination } = member;
      if (roles.has(role))
        throw new Finding(`Set ${id} lists role ${role} twice`);
      roles.add(role);
      if (!validPath(path) || !path.startsWith(".factory-media/"))
        throw new Finding(
          `Set ${id} member ${role}: path ${path} is not under .factory-media/`,
        );
      if (
        !validPath(destination) ||
        privateStagingPath(destination) ||
        destination === ".git" ||
        destination.startsWith(".git/") ||
        !ownsPath(destination, item.ownedPaths) ||
        destinations.has(destination)
      )
        throw new Finding(
          `Set ${id} member ${role}: destination ${destination} must be a repository path this item owns, used once per set`,
        );
      destinations.add(destination);
      const metadata = member.formatMetadata;
      if (
        metadata !== undefined &&
        (!isRecord(metadata) ||
          !text(metadata.source) ||
          !isRecord(metadata.values))
      )
        throw new Finding(
          `Set ${id} member ${role}: formatMetadata must be {"source": "...", "values": {...}}`,
        );
      return {
        role,
        path,
        mediaType: member.mediaType,
        destination,
        ...(metadata !== undefined && { formatMetadata: metadata }),
      };
    });
    for (const role of item.expectedOutputRoles ?? [])
      if (!roles.has(role))
        throw new Finding(`Set ${id} lacks expected role ${role}`);
    if (
      raw.relationships !== undefined &&
      !(
        Array.isArray(raw.relationships) &&
        raw.relationships.every(
          (edge) =>
            isRecord(edge) &&
            text(edge.from) &&
            text(edge.kind) &&
            typeof edge.toRole === "string" &&
            roles.has(edge.toRole),
        )
      )
    )
      throw new Finding(
        `Set ${id} relationships must each have from, kind and a toRole of the set`,
      );
    if (
      raw.production !== undefined &&
      !(
        isRecord(raw.production) &&
        ["model", "tool"].every(
          (key) =>
            (raw.production as Record<string, unknown>)[key] === undefined ||
            text((raw.production as Record<string, unknown>)[key]),
        )
      )
    )
      throw new Finding(
        `Set ${id} production must be an object whose model and tool, when given, are text`,
      );
    return {
      id,
      members,
      provenance: {
        source: provenance.source,
        rights: provenance.rights,
        visibility: provenance.visibility,
        lineage: provenance.lineage as string[],
      },
      ...(raw.relationships !== undefined && {
        relationships: raw.relationships,
      }),
      ...(raw.production !== undefined && { production: raw.production }),
    };
  });
}

/**
 * Why the collected result is refused for touching a candidate
 * destination, or undefined. Only the selected set is ever written there,
 * by Factory; the worker may neither write nor delete one.
 *
 * Step: call after collect returns `collected`, with the captured sets.
 * A finding → repair to work.
 */
export async function destinationFinding(input: {
  worktree: string;
  base: string;
  commit: string;
  sets: readonly CandidateSet[];
  signal: AbortSignal;
}): Promise<string | undefined> {
  const destinations = [
    ...new Set(
      input.sets.flatMap((set) => set.members.map((m) => m.destination)),
    ),
  ];
  if (!destinations.length) return undefined;
  const changed = (
    await hostGit(
      input.worktree,
      [
        "diff-tree",
        "-r",
        "-z",
        "--name-only",
        "--no-renames",
        input.base,
        input.commit,
        "--",
        ...destinations,
      ],
      { signal: input.signal },
    )
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  return changed.length
    ? `The result writes or deletes candidate destinations ${changed.join(", ")}. Factory writes the selected set there; leave final destinations as they are and stage candidates under .factory-media/.`
    : undefined;
}

// ── Selection ───────────────────────────────────────────────────────────

/** Plan items that depend directly on `item`: the only ones a selection can bind. */
function directDependents(plan: Plan, item: WorkItem): string[] {
  return plan.items
    .filter((other) => other.dependencies.includes(item.id))
    .map((other) => other.id);
}

/**
 * The select hold: the candidate directory, each set and its members, and
 * the answers (each set id in lower case, repair, cancel). Step: return it
 * as a hold while the step has no valid answer.
 */
export function selectionQuestion(
  plan: Plan,
  item: WorkItem,
  sets: readonly CandidateSet[],
  directory: string,
): { kind: "hold"; question: string; answers: string[]; recommended: string } {
  const listed = sets
    .map(
      (set) =>
        `- \`${set.id.toLowerCase()}\`: ${set.members.map((m) => `${m.role} → ${m.destination} (${m.mediaType}, ${m.bytes} bytes)`).join("; ")}. Source: ${set.provenance.source}; rights: ${set.provenance.rights}.`,
    )
    .join("\n");
  const dependents = directDependents(plan, item);
  const bind = dependents.length
    ? ` To give the set to dependents as read-only input, add \`bind ${dependents.join(" ")}\` (any of them) after the id.`
    : "";
  return hold(
    `Work Item ${item.id} produced ${sets.length} candidate set${sets.length === 1 ? "" : "s"}, in ${join(directory, "candidates")}:\n${listed}\n\nLook at them, then answer with the id of the set to deliver.${bind} Answer repair to have the worker make new candidates, or cancel.`,
    [...sets.map((set) => set.id.toLowerCase()), "repair", "cancel"],
  );
}

/**
 * The operator's answer to the select hold. Set ids match ignoring case;
 * `bind ITEM...` in the answer text names direct dependents.
 *
 * Step: first, if the answer is `replan`, take the step's replan route:
 * materializeSelection's holds offer it and this function doesn't know it
 * (it would return invalid and ask the selection question again). Then
 * chosen → materializeSelection; repair → repair to work (clearing work
 * and select), from the selection question or a materialize hold alike;
 * invalid → hold selectionQuestion again with `problem` in front; cancel
 * is the engine's.
 */
export function readSelection(
  plan: Plan,
  item: WorkItem,
  sets: readonly CandidateSet[],
  answer: { answer: string; text?: string },
):
  | { kind: "chosen"; set: CandidateSet; bound: string[] }
  | { kind: "repair" }
  | { kind: "invalid"; problem: string } {
  const chosen = answer.answer.toLowerCase();
  if (chosen === "repair") return { kind: "repair" };
  const set = sets.find((candidate) => candidate.id.toLowerCase() === chosen);
  if (!set)
    return {
      kind: "invalid",
      problem: `${answer.answer} is not one of the candidate set ids.`,
    };
  const words = (answer.text ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length && words[0]!.toLowerCase() !== "bind")
    return {
      kind: "invalid",
      problem: "The text after the set id may only be `bind ITEM...`.",
    };
  const dependents = directDependents(plan, item);
  const bound = [...new Set(words.slice(1))];
  const unknown = bound.filter((id) => !dependents.includes(id));
  if (unknown.length)
    return {
      kind: "invalid",
      problem: `${unknown.join(", ")} ${unknown.length === 1 ? "is not a" : "are not"} direct dependent${unknown.length === 1 ? "" : "s"} of ${item.id}${dependents.length ? ` (${dependents.join(", ")})` : ""}.`,
    };
  return { kind: "chosen", set, bound };
}

/**
 * Write the chosen set at its destinations on top of the work commit, in a
 * fresh worktree, through Git LFS where `.gitattributes` says so, and
 * commit it as `Factory: selected <set> assets`. Checks first that every
 * captured copy still has its digest, that `.gitattributes` routes every
 * requiredLfsRoles destination through LFS, and that no destination exists
 * (except a plain tracked repository source of the same bytes that LFS
 * converts); after, that the staged paths are exactly the destinations and
 * each LFS pointer carries the member's sha256 and size.
 *
 * Step: done → done `{commit, tree, set, bound}` (Selection); later steps
 * use selection.commit in place of work.commit, and a repair must still
 * replay work.commit, not this one. repair → repair to work; hold → hold
 * as the select step's own hold. Its answers come back to the select step
 * and route through readSelection's contract: `replan` (checked before
 * readSelection) → the replan route; `repair` → repair to work (clearing
 * work and select); the chosen set's id (offered where trying again can
 * help) → readSelection chooses it again and this runs again; `cancel` is
 * the engine's.
 */
export async function materializeSelection(input: {
  checkout: string;
  /** A fresh worktree path, such as `<item worktree>.select`; removed after. */
  directory: string;
  item: WorkItem;
  /** The work step's commit. */
  commit: string;
  set: CandidateSet;
  signal: AbortSignal;
}): Promise<MediaOutcome<{ commit: string; tree: string }>> {
  const { checkout, directory, item, set, signal } = input;
  const again = set.id.toLowerCase();
  for (const member of set.members) {
    const held = await digestFile(member.file).catch(() => undefined);
    if (held?.sha256 !== member.sha256 || held.bytes !== member.bytes)
      return hold(
        `Factory's copy of candidate ${set.id} ${member.role} (${member.file}) is missing or changed since capture. Answer repair to have the worker make new candidates, or cancel.`,
        ["repair", "cancel"],
      );
  }
  await removeWorktree(checkout, directory, signal);
  await addWorktree(checkout, directory, input.commit, signal);
  try {
    const git = (args: string[]) => hostGit(directory, args, { signal });
    if (await hasGitlink(directory, { commit: input.commit, signal }))
      return hold(
        `Work Item ${item.id}'s result holds a submodule gitlink; Factory does not write media into such a tree. Answer replan or cancel.`,
        ["replan", "cancel"],
      );
    const destinations = set.members.map((m) => m.destination);
    const filtered = lfsFiltered(
      await git(["check-attr", "-z", "filter", "--", ...destinations]),
    );
    const uncovered = set.members.filter(
      (m) =>
        item.requiredLfsRoles?.includes(m.role) && !filtered.has(m.destination),
    );
    if (uncovered.length) {
      const paths = uncovered.map((m) => m.destination).join(", ");
      return ownsPath(".gitattributes", item.ownedPaths)
        ? {
            kind: "repair",
            finding: `.gitattributes does not route ${paths} through Git LFS, but the roles ${uncovered.map((m) => m.role).join(", ")} must be stored in LFS. Add a filter=lfs rule that covers them.`,
          }
        : hold(
            `The repository's .gitattributes does not route ${paths} through Git LFS, and Work Item ${item.id} must store ${uncovered.map((m) => m.role).join(", ")} there but doesn't own .gitattributes. Answer replan to give an item that rule, or cancel.`,
            ["replan", "cancel"],
          );
    }
    for (const member of set.members) {
      const placed = await place(
        directory,
        input.commit,
        item,
        member,
        filtered,
        signal,
      );
      if (placed) return placed;
    }
    await hostGit(directory, [...LFS, "add", "--", ...destinations], {
      signal,
    });
    const staged = (
      await git(["diff", "--cached", "--name-only", "-z", "--no-renames"])
    )
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    if (
      staged.length !== destinations.length ||
      staged.some((path) => !destinations.includes(path))
    )
      return hold(
        `Writing set ${set.id} staged ${staged.join(", ") || "nothing"}, not exactly its destinations ${destinations.join(", ")}. Answer ${again} (with the same bind text, if any) to write it again; if it repeats, report it. Or answer repair or cancel.`,
        [again, "repair", "cancel"],
      );
    await git([
      "-c",
      "user.name=Factory",
      "-c",
      `user.email=${FACTORY_EMAIL}`,
      "commit",
      "--quiet",
      "-m",
      `Factory: selected ${set.id} assets`,
    ]);
    const commit = (await git(["rev-parse", "HEAD"])).toString("utf8").trim();
    for (const member of set.members) {
      if (!filtered.has(member.destination)) continue;
      const found = lfsPointer(
        await git(["cat-file", "blob", `${commit}:${member.destination}`]),
      );
      if (
        found?.oid !== member.sha256 ||
        found.size !== member.bytes ||
        !(await lfsObject(checkout, member.sha256, signal))
      )
        return hold(
          `Git LFS did not store ${member.destination} as the selected bytes (sha256 ${member.sha256}, ${member.bytes} bytes). Check that git-lfs is installed for the service, then answer ${again} (with the same bind text, if any) to write the set again; or cancel.`,
          [again, "cancel"],
        );
    }
    const tree = (await git(["rev-parse", "HEAD^{tree}"]))
      .toString("utf8")
      .trim();
    return { kind: "done", value: { commit, tree } };
  } finally {
    await removeWorktree(checkout, directory, signal);
  }
}

/**
 * Write one member at its destination without following a link. An
 * existing destination may only be a plain tracked repository source with
 * the same bytes, which LFS now stores as a pointer. Its holds offer
 * `replan` and `cancel` and are materializeSelection's (see its routing).
 */
async function place(
  directory: string,
  commit: string,
  item: WorkItem,
  member: CapturedMember,
  filtered: ReadonlySet<string>,
  signal: AbortSignal,
): Promise<MediaOutcome<never> | undefined> {
  let parent: ReturnType<typeof openParent>;
  try {
    parent = openParent(directory, member.destination, true);
  } catch (error) {
    return hold(
      `Destination ${member.destination} can't be written: ${errorMessage(error)}. Answer replan to choose another destination, or cancel.`,
      ["replan", "cancel"],
    );
  }
  const target = join(parent.anchor, parent.name);
  try {
    const existing = lstatSync(target, { throwIfNoEntry: false });
    if (existing) {
      const entry = /^(100644|100755) blob ([0-9a-f]+)\t/.exec(
        (
          await hostGit(
            directory,
            ["ls-tree", commit, "--", member.destination],
            { signal },
          )
        ).toString("utf8"),
      );
      const blob = entry
        ? await hostGit(directory, ["cat-file", "blob", entry[2]!], { signal })
        : undefined;
      const sameSource =
        existing.isFile() &&
        blob !== undefined &&
        !lfsPointer(blob) &&
        sha256(blob) === member.sha256 &&
        filtered.has(member.destination) &&
        Boolean(item.requiredLfsRoles?.includes(member.role)) &&
        (item.sourceAssets ?? []).some(
          (source) =>
            (source.kind ?? "repository") === "repository" &&
            source.path === member.destination,
        );
      if (!sameSource)
        return hold(
          `Destination ${member.destination} already exists in Work Item ${item.id}'s result; Factory writes selected media only to new paths (or converts a same-bytes repository source to LFS). Answer replan to choose another destination, or cancel.`,
          ["replan", "cancel"],
        );
      await unlink(target);
      await copyFile(member.file, target);
      if (entry![1] === "100755") await chmod(target, 0o755);
      return undefined;
    }
    await copyFile(member.file, target);
    return undefined;
  } finally {
    closeSync(parent.fd);
  }
}

/** The paths `git check-attr -z filter` reports as `filter=lfs`. */
function lfsFiltered(output: Buffer): Set<string> {
  const fields = output.toString("utf8").split("\0");
  const paths = new Set<string>();
  for (let index = 0; index + 2 < fields.length; index += 3)
    if (fields[index + 2] === "lfs") paths.add(fields[index]!);
  return paths;
}

// ── Validation ──────────────────────────────────────────────────────────

/**
 * The selected members a tree is expected to hold: those of the item and
 * its dependency closure (every item when `item` is undefined, for final
 * validation). `required` marks members whose role must be in LFS.
 */
export function validationMembers(
  plan: Plan,
  item: WorkItem | undefined,
  selection: (itemId: string) => Selection | undefined,
): SelectedMember[] {
  const byId = new Map(plan.items.map((entry) => [entry.id, entry]));
  const closure = new Set<string>();
  const visit = (id: string) => {
    if (closure.has(id)) return;
    closure.add(id);
    for (const dependency of byId.get(id)?.dependencies ?? [])
      visit(dependency);
  };
  if (item) visit(item.id);
  else for (const entry of plan.items) closure.add(entry.id);
  const members: SelectedMember[] = [];
  for (const id of closure) {
    const chosen = selection(id);
    if (!chosen) continue;
    const roles = byId.get(id)?.requiredLfsRoles ?? [];
    for (const member of chosen.set.members)
      members.push({
        item: id,
        set: chosen.set.id,
        role: member.role,
        destination: member.destination,
        sha256: member.sha256,
        bytes: member.bytes,
        required: roles.includes(member.role),
      });
  }
  return members;
}

/**
 * Restore the real bytes of selected LFS members in a validation checkout,
 * offline from the local LFS store, and check each one's sha256 and size.
 * A member whose exact pointer the tree holds is restored; a required one
 * without its pointer holds. Returns the restored destinations: they now
 * differ from their pointer blobs, so the caller leaves them out of its
 * clean-checkout and mutation checks.
 *
 * Each destination is written literally: Factory copies the store's object
 * over the pointer file itself, without following a link. `git lfs
 * checkout` can't do that: its arguments are gitignore-style patterns, so
 * a glob character or a bare file name restores other files too, and it
 * matches nothing for a `:(literal)` pathspec (checked with git-lfs 3.7.1).
 *
 * Validation: call in the fresh checkout after it is made and before any
 * command runs, with validationMembers(plan, item, …). done → run the
 * commands; hold → hold as the validate step's own. Its holds offer
 * `retry` (validate again), `replan` (a required member's pointer is gone:
 * the step's replan route) and `cancel`.
 */
export async function hydrateSelected(input: {
  directory: string;
  members: readonly SelectedMember[];
  signal: AbortSignal;
}): Promise<Extract<MediaOutcome<string[]>, { kind: "done" | "hold" }>> {
  const { directory, signal } = input;
  const restored: string[] = [];
  for (const member of input.members) {
    const blob = await hostGitExit(
      directory,
      ["cat-file", "blob", `HEAD:${member.destination}`],
      { signal },
    );
    const found = blob.code === 0 ? lfsPointer(blob.stdout) : undefined;
    if (found?.oid !== member.sha256 || found.size !== member.bytes) {
      if (member.required)
        return hold(
          `${member.destination}, ${member.item}'s selected ${member.role}, is not the Git LFS pointer of the selected bytes in this tree; someone may have changed it. Restore it on the default branch and answer retry, or replan or cancel.`,
          ["retry", "replan", "cancel"],
        );
      continue;
    }
    const held = await restoreObject(directory, member, signal);
    if (held?.sha256 !== member.sha256 || held.bytes !== member.bytes)
      return hold(
        `Factory could not restore ${member.destination} (sha256 ${member.sha256}, ${member.bytes} bytes) from the local Git LFS store. Run \`git lfs fetch\` in the target checkout and answer retry, or cancel.`,
      );
    restored.push(member.destination);
  }
  return { kind: "done", value: restored };
}

/**
 * The restored destinations whose bytes are no longer the selected ones
 * (or that are no longer regular files reached without links): what a
 * validation command rewrote. Call after the commands, with
 * hydrateSelected's members and its result.
 */
export async function rewrittenMedia(
  directory: string,
  members: readonly SelectedMember[],
  restored: ReadonlySet<string>,
): Promise<string[]> {
  const changed: string[] = [];
  for (const member of members) {
    if (!restored.has(member.destination)) continue;
    let parent: ReturnType<typeof openParent>;
    try {
      parent = openParent(directory, member.destination, false);
    } catch {
      // Gone, or now behind a link.
      changed.push(member.destination);
      continue;
    }
    let held: { sha256: string; bytes: number } | undefined;
    try {
      const target = `${parent.anchor}/${parent.name}`;
      if (lstatSync(target, { throwIfNoEntry: false })?.isFile())
        held = await digestFile(target);
    } finally {
      closeSync(parent.fd);
    }
    if (held?.sha256 !== member.sha256 || held.bytes !== member.bytes)
      changed.push(member.destination);
  }
  return changed;
}

/**
 * Copy the local store's object for `member` over its pointer file in
 * `directory`, reached without links. Undefined when the store lacks it or
 * either file isn't a regular file reached without links.
 */
async function restoreObject(
  directory: string,
  member: SelectedMember,
  signal: AbortSignal,
): Promise<{ sha256: string; bytes: number } | undefined> {
  const stored = await lfsObject(directory, member.sha256, signal);
  if (!stored) return undefined;
  let parent: ReturnType<typeof openParent>;
  try {
    parent = openParent(directory, member.destination, false);
  } catch {
    return undefined;
  }
  try {
    const target = `${parent.anchor}/${parent.name}`;
    if (!lstatSync(target, { throwIfNoEntry: false })?.isFile())
      return undefined;
    return await copyContained(
      stored.root,
      stored.relative,
      target,
      member.bytes,
      true,
    );
  } catch (error) {
    if (error instanceof ContainedError) return undefined;
    throw error;
  } finally {
    closeSync(parent.fd);
  }
}

// ── Publish ─────────────────────────────────────────────────────────────

/** The LFS pointers (oid, size, path) that `commit` adds or changes relative to `base`. */
async function addedPointers(
  checkout: string,
  base: string,
  commit: string,
  signal: AbortSignal,
): Promise<{ oid: string; size: number; path: string }[]> {
  const entries = (
    await hostGit(
      checkout,
      [
        "diff-tree",
        "-r",
        "-z",
        "--no-renames",
        "--diff-filter=d",
        base,
        commit,
      ],
      { signal },
    )
  )
    .toString("utf8")
    .split("\0");
  // Raw entries: ":<old mode> <new mode> <old oid> <new oid> <status>", then the path.
  const blobs: { oid: string; path: string }[] = [];
  for (let index = 0; index + 1 < entries.length; index += 2) {
    const [, mode, , oid] = entries[index]!.split(" ");
    if (mode?.startsWith("100") && oid)
      blobs.push({ oid, path: entries[index + 1]! });
  }
  if (!blobs.length) return [];
  const sizes = (
    await hostGit(checkout, ["cat-file", "--batch-check"], {
      input: `${blobs.map((b) => b.oid).join("\n")}\n`,
      signal,
    })
  )
    .toString("utf8")
    .split("\n");
  const small = blobs.filter((_, index) => {
    const [, type, size] = (sizes[index] ?? "").split(" ");
    return type === "blob" && Number(size) <= LFS_POINTER_MAX_BYTES;
  });
  if (!small.length) return [];
  const bodies = batchObjects(
    await hostGit(checkout, ["cat-file", "--batch"], {
      input: `${small.map((b) => b.oid).join("\n")}\n`,
      signal,
    }),
    small.length,
  );
  const pointers: { oid: string; size: number; path: string }[] = [];
  small.forEach((blob, index) => {
    const found = lfsPointer(bodies[index]!.body);
    if (found) pointers.push({ ...found, path: blob.path });
  });
  return pointers;
}

/**
 * Upload the LFS objects behind any pointer `commit` adds relative to
 * `base`, before its branch is pushed: Factory runs no hooks, so LFS's
 * pre-push hook never does it. The objects are pushed by id, since
 * `git lfs push origin <commit>` skips what origin's remote-tracking refs
 * already reach (a republish after the branch was pushed). Content-
 * addressed and idempotent, so it repeats safely on every publish attempt.
 * A pointer whose object Factory doesn't have is the result's fault.
 *
 * Delivery: `publish` (delivery.ts) calls it just before it pushes the
 * branch, with the item's base commit as `base`; steps don't call it. It
 * makes its own origin check. done → push; repair, retry and hold come back
 * as publish's own (repair → the item's delivery repair with the finding;
 * a hold's answers are `retry`, publish again, and `cancel`).
 */
export async function lfsPushIfPointers(input: {
  checkout: string;
  repository: string;
  base: string;
  commit: string;
  signal: AbortSignal;
}): Promise<MediaOutcome<{ pushed: boolean }>> {
  const pointers = await addedPointers(
    input.checkout,
    input.base,
    input.commit,
    input.signal,
  );
  if (!pointers.length) return { kind: "done", value: { pushed: false } };
  const missing: string[] = [];
  for (const found of pointers)
    if (!(await lfsObject(input.checkout, found.oid, input.signal)))
      missing.push(found.path);
  if (missing.length)
    return {
      kind: "repair",
      finding: `The result adds Git LFS pointers whose objects don't exist: ${missing.join(", ")}. Commit real files (Factory stores them in LFS) or leave those paths unchanged.`,
    };
  const pushed = await lfsPush({
    ...input,
    oids: [...new Set(pointers.map((found) => found.oid))],
  });
  return pushed ?? { kind: "done", value: { pushed: true } };
}

/**
 * `git lfs push --object-id origin <oid...>` from the local store, with
 * the operator's credentials, after the origin check.
 */
async function lfsPush(input: {
  checkout: string;
  repository: string;
  oids: readonly string[];
  signal: AbortSignal;
}): Promise<MediaOutcome<never> | undefined> {
  const problem = await originProblem(
    input.checkout,
    input.repository,
    input.signal,
  );
  if (problem)
    return hold(
      `${problem}. Factory uploads LFS objects to origin's default route. Fix origin, then answer retry; or cancel.`,
    );
  try {
    await operatorGit(
      input.checkout,
      [
        "-c",
        "protocol.file.allow=never",
        ...LFS,
        "lfs",
        "push",
        "--object-id",
        "origin",
        ...input.oids,
      ],
      { signal: input.signal, timeoutMs: 30 * MINUTE },
    );
  } catch (error) {
    input.signal.throwIfAborted();
    return {
      kind: "retry",
      reason: `git lfs push of ${input.oids.length} object(s): ${errorMessage(error)}`,
    };
  }
  return undefined;
}

// ── Final ───────────────────────────────────────────────────────────────

/**
 * Prove origin serves every selected member at the integrated commit:
 * each destination holds its member's pointer (or plain bytes), and a
 * `git lfs fetch` into an empty store downloads objects with the selected
 * sha256 and size. Missing objects are re-pushed by object id from the
 * local store once (retry with `repushed`), then hold. Returns a text
 * summary for final review.
 *
 * Step: in final, after validateTree passes, with validationMembers(plan,
 * undefined, …) and `repushed` from state.kept. done → keep the summary
 * in the final result; retry → retry, keeping `repushed: true` when set;
 * hold → hold, whose answers are `retry` (verify again) and `cancel`.
 */
export async function verifyOriginMedia(input: {
  checkout: string;
  repository: string;
  commit: string;
  members: readonly SelectedMember[];
  /** A private scratch directory for the empty LFS store; replaced, then removed. */
  scratch: string;
  repushed: boolean;
  signal: AbortSignal;
}): Promise<MediaOutcome<{ summary: string }>> {
  const { checkout, commit, signal } = input;
  if (!input.members.length) return { kind: "done", value: { summary: "" } };
  const lfs: SelectedMember[] = [];
  for (const member of input.members) {
    const blob = await hostGitExit(
      checkout,
      ["cat-file", "blob", `${commit}:${member.destination}`],
      { signal },
    );
    const found = blob.code === 0 ? lfsPointer(blob.stdout) : undefined;
    if (found?.oid === member.sha256 && found.size === member.bytes)
      lfs.push(member);
    else if (
      blob.code !== 0 ||
      member.required ||
      sha256(blob.stdout) !== member.sha256
    )
      return hold(
        `${member.destination} at ${commit.slice(0, 12)} is not ${member.item}'s selected ${member.role} (sha256 ${member.sha256}); someone may have changed it after the merge. Restore it on the default branch and answer retry, or cancel.`,
      );
  }
  const missing: SelectedMember[] = [];
  if (lfs.length) {
    const problem = await originProblem(checkout, input.repository, signal);
    if (problem)
      return hold(`${problem}. Fix origin, then answer retry; or cancel.`);
    await forceRemove(input.scratch);
    await mkdir(input.scratch, { recursive: true, mode: 0o700 });
    try {
      const plain = lfs.every((m) => !/[,*?[\]\\!]/.test(m.destination));
      const fetched = await operatorGit(
        checkout,
        [
          "-c",
          "protocol.file.allow=never",
          "-c",
          `lfs.storage=${input.scratch}`,
          ...LFS,
          "lfs",
          "fetch",
          "origin",
          commit,
          ...(plain
            ? ["--include", lfs.map((m) => m.destination).join(",")]
            : []),
        ],
        { signal, timeoutMs: 30 * MINUTE },
      ).then(
        () => undefined,
        (error: unknown) => errorMessage(error),
      );
      // A failed fetch of an origin Factory can't reach at all is the
      // network's; one it can reach is missing objects, checked below.
      if (fetched !== undefined && !(await reachable(checkout, signal)))
        return {
          kind: "retry",
          reason: `Fetching LFS objects from origin: ${fetched}`,
        };
      for (const member of lfs) {
        const object = join(
          input.scratch,
          "objects",
          member.sha256.slice(0, 2),
          member.sha256.slice(2, 4),
          member.sha256,
        );
        const held = await digestFile(object).catch(() => undefined);
        if (held?.sha256 !== member.sha256 || held.bytes !== member.bytes)
          missing.push(member);
      }
    } finally {
      await forceRemove(input.scratch);
    }
  }
  if (missing.length) {
    const paths = missing.map((m) => m.destination).join(", ");
    if (input.repushed)
      return hold(
        `Origin still does not serve the selected Git LFS objects for ${paths} after Factory pushed them again. Check the repository's LFS storage and quota, then answer retry; or cancel.`,
      );
    const unheld: string[] = [];
    for (const member of missing)
      if (!(await lfsObject(checkout, member.sha256, signal)))
        unheld.push(member.destination);
    if (unheld.length)
      return hold(
        `Origin does not serve the selected Git LFS objects for ${unheld.join(", ")}, and Factory's checkout no longer holds them to push again. Push them to origin's LFS storage, then answer retry; or cancel.`,
      );
    const pushed = await lfsPush({
      checkout,
      repository: input.repository,
      oids: [...new Set(missing.map((m) => m.sha256))],
      signal,
    });
    if (pushed) return pushed;
    return {
      kind: "retry",
      reason: `Origin did not serve LFS objects for ${paths}; Factory pushed them again.`,
      repushed: true,
    };
  }
  return {
    kind: "done",
    value: {
      summary: `Selected media verified on origin at ${commit.slice(0, 12)}:\n${input.members.map((m) => `- ${m.item} set ${m.set} ${m.role} → ${m.destination}: sha256 ${m.sha256}, ${m.bytes} bytes${lfs.includes(m) ? " (Git LFS)" : ""}`).join("\n")}`,
    },
  };
}

/** Whether origin answers at all. */
async function reachable(
  checkout: string,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    await operatorGit(
      checkout,
      ["-c", "protocol.file.allow=never", "ls-remote", "origin", "HEAD"],
      { signal },
    );
    return true;
  } catch {
    signal.throwIfAborted();
    return false;
  }
}

/**
 * Selected media as text for result and final review: per item, the set,
 * its provenance and each member's role, destination, type and digest.
 */
export function selectionSummary(
  selections: readonly { item: string; selection: Selection }[],
): string {
  return selections
    .map(
      ({ item, selection: { set, bound } }) =>
        `Work Item ${item} delivers selected set ${set.id} (source ${set.provenance.source}; rights ${set.provenance.rights}; visibility ${set.provenance.visibility}; lineage ${set.provenance.lineage.join(" > ") || "none"}${bound.length ? `; bound to ${bound.join(", ")}` : ""}):\n${set.members.map((m) => `- ${m.role} → ${m.destination} (${m.mediaType}, ${m.bytes} bytes, sha256 ${m.sha256})`).join("\n")}`,
    )
    .join("\n\n");
}

// ── Bytes ───────────────────────────────────────────────────────────────

/**
 * The local LFS store's file for `oid`, when the checkout has it: `relative`
 * under `root`, the checkout's common Git directory.
 */
async function lfsObject(
  checkout: string,
  oid: string,
  signal: AbortSignal,
): Promise<{ root: string; relative: string } | undefined> {
  const common = (
    await hostGit(
      checkout,
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { signal },
    )
  )
    .toString("utf8")
    .trim();
  const relative = `lfs/objects/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`;
  return lstatSync(join(common, relative), {
    throwIfNoEntry: false,
  })?.isFile()
    ? { root: common, relative }
    : undefined;
}

/**
 * Copy a local LFS object to `file`, reached without links, and check it
 * against the pointer it stands for.
 */
async function copyChecked(
  from: { root: string; relative: string },
  file: string,
  expected: { oid: string; size: number },
): Promise<Copied> {
  await mkdir(join(file, ".."), { recursive: true, mode: 0o700 });
  const held = await copyContained(
    from.root,
    from.relative,
    file,
    expected.size,
  ).catch((error: unknown) => {
    if (error instanceof ContainedError) return undefined;
    throw error;
  });
  if (held?.sha256 !== expected.oid || held.bytes !== expected.size) {
    await rm(file, { force: true });
    return hold(
      `The local Git LFS object ${expected.oid} is not a regular file holding the bytes its name says. Remove it from the checkout's .git/lfs/objects and answer retry, or cancel.`,
    );
  }
  return { kind: "done", value: held };
}

async function digestFile(
  path: string,
): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { sha256: hash.digest("hex"), bytes };
}
