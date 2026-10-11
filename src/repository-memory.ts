import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { LocalContentStore } from "./content/local.js";
import type { ContentRef } from "./contracts.js";
import { validOwnershipPath } from "./ownership.js";
import type { ContinuationState, WorkState } from "./state.js";

export type MemoryVisibility = "repository" | "private";
export type MemoryKind =
  | "observation"
  | "discovery"
  | "repository-map"
  | "hypothesis"
  | "decision"
  | "diagnosed-correction"
  | "failure"
  | "handoff"
  | "episode"
  | "lesson"
  | "reference";

/** Provenance authenticates origin; no memory confers new source or effect authority. */
export interface RepositoryMemoryRecord {
  schemaVersion: 1;
  repository: string;
  visibility: MemoryVisibility;
  kind: MemoryKind;
  producer: {
    objective?: number;
    runId?: string;
    identity?: string;
    itemId?: string;
    attemptId?: string;
    status: string;
  };
  createdAt: string;
  authority:
    | "observation"
    | "advisory"
    | "human-decision"
    | "acceptance-evidence";
  summary: string;
  bodies: {
    role: string;
    ref?: ContentRef;
    availability: "retained" | "missing-legacy";
  }[];
  sources: {
    identity: string;
    version?: string;
    apiVersion?: string;
    dependencyVersion?: string;
    retrievedAt?: string;
    complete: boolean;
    ref?: ContentRef;
  }[];
  bindings: {
    treeSha?: string;
    paths?: { path: string; digest: string }[];
    dependencies?: Record<string, string>;
    environment?: Record<string, string>;
  };
  validity: {
    state: "current" | "historical" | "superseded";
    conditions: string[];
    expiresAt?: string;
  };
  supersedes: string[];
}

export interface RepositoryMemoryBinding {
  id: string;
  manifestRef: ContentRef;
}
export interface MemoryAccess {
  repository: string;
  visibility: MemoryVisibility[];
}
export interface MemoryApplicability {
  treeSha?: string;
  paths?: Record<string, string>;
  dependencies?: Record<string, string>;
  environment?: Record<string, string>;
  conditions?: string[];
  sources?: Record<
    string,
    { version?: string; apiVersion?: string; dependencyVersion?: string }
  >;
}
export interface MemoryResult {
  binding: RepositoryMemoryBinding;
  record: RepositoryMemoryRecord;
  disposition:
    | "current"
    | "historical"
    | "stale"
    | "unavailable"
    | "incomplete";
  content: { role: string; ref: ContentRef; text: string }[];
  gaps: string[];
}
export interface MemoryLookup {
  access: MemoryAccess;
  scope?: { objective?: number; paths?: string[]; kinds?: MemoryKind[] };
  applicability?: MemoryApplicability;
  limit: number;
  maxBytes?: number;
}

const isHash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Memory value must be an object");
  return value as Record<string, unknown>;
}
function keys(value: unknown, permitted: string[]): Record<string, unknown> {
  const record = object(value);
  if (Object.keys(record).some((key) => !permitted.includes(key)))
    throw new Error("Memory value contains unsupported fields");
  return record;
}
function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || value.includes("\0"))
    throw new Error("Memory text must be nonempty and contain no NUL");
}
function date(value: unknown): void {
  text(value);
  if (!Number.isFinite(Date.parse(value)))
    throw new Error("Invalid memory date");
}
function ref(value: unknown): asserts value is ContentRef {
  const record = keys(value, ["digest", "bytes", "mediaType"]);
  if (
    !isHash(record.digest) ||
    !Number.isSafeInteger(record.bytes) ||
    Number(record.bytes) < 0
  )
    throw new Error("Invalid memory content reference");
  text(record.mediaType);
}
function strings(value: unknown): asserts value is string[] {
  if (!Array.isArray(value)) throw new Error("Memory strings must be an array");
  for (const entry of value) text(entry);
}
function versions(value: unknown): void {
  for (const [key, version] of Object.entries(object(value))) {
    text(key);
    text(version);
  }
}
/** One strict producer/reader contract, also used by operational snapshot validation. */
export function assertRepositoryMemoryRecord(
  value: unknown,
): asserts value is RepositoryMemoryRecord {
  const record = keys(value, [
    "schemaVersion",
    "repository",
    "visibility",
    "kind",
    "producer",
    "createdAt",
    "authority",
    "summary",
    "bodies",
    "sources",
    "bindings",
    "validity",
    "supersedes",
  ]);
  if (
    record.schemaVersion !== 1 ||
    typeof record.repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(record.repository) ||
    !["repository", "private"].includes(String(record.visibility)) ||
    ![
      "observation",
      "discovery",
      "repository-map",
      "hypothesis",
      "decision",
      "diagnosed-correction",
      "failure",
      "handoff",
      "episode",
      "lesson",
      "reference",
    ].includes(String(record.kind)) ||
    ![
      "observation",
      "advisory",
      "human-decision",
      "acceptance-evidence",
    ].includes(String(record.authority))
  )
    throw new Error("Invalid memory record scope or type");
  const producer = keys(record.producer, [
    "objective",
    "runId",
    "identity",
    "itemId",
    "attemptId",
    "status",
  ]);
  if (
    producer.objective !== undefined &&
    (!Number.isSafeInteger(producer.objective) ||
      Number(producer.objective) < 1)
  )
    throw new Error("Invalid memory Objective");
  text(producer.status);
  for (const name of ["runId", "identity", "itemId", "attemptId"])
    if (producer[name] !== undefined) text(producer[name]);
  if (producer.runId === undefined && producer.identity === undefined)
    throw new Error("Memory producer requires its original run or identity");
  date(record.createdAt);
  text(record.summary);
  if (!Array.isArray(record.bodies) || !Array.isArray(record.sources))
    throw new Error("Memory bodies and sources must be arrays");
  for (const value of record.bodies) {
    const body = keys(value, ["role", "ref", "availability"]);
    text(body.role);
    if (
      !["retained", "missing-legacy"].includes(String(body.availability)) ||
      (body.availability === "retained" && body.ref === undefined)
    )
      throw new Error("Memory body availability is invalid");
    if (body.ref !== undefined) ref(body.ref);
  }
  for (const value of record.sources) {
    const source = keys(value, [
      "identity",
      "version",
      "apiVersion",
      "dependencyVersion",
      "retrievedAt",
      "complete",
      "ref",
    ]);
    text(source.identity);
    for (const name of ["version", "apiVersion", "dependencyVersion"])
      if (source[name] !== undefined) text(source[name]);
    if (source.retrievedAt !== undefined) date(source.retrievedAt);
    if (typeof source.complete !== "boolean")
      throw new Error("Memory source completeness is invalid");
    if (source.ref !== undefined) ref(source.ref);
  }
  const bindings = keys(record.bindings, [
    "treeSha",
    "paths",
    "dependencies",
    "environment",
  ]);
  if (
    bindings.treeSha !== undefined &&
    (typeof bindings.treeSha !== "string" ||
      !/^[a-f0-9]{40,64}$/.test(bindings.treeSha))
  )
    throw new Error("Invalid memory tree binding");
  if (bindings.paths !== undefined) {
    if (!Array.isArray(bindings.paths))
      throw new Error("Memory path bindings must be an array");
    for (const value of bindings.paths) {
      const path = keys(value, ["path", "digest"]);
      if (
        typeof path.path !== "string" ||
        !validOwnershipPath(path.path) ||
        !isHash(path.digest)
      )
        throw new Error("Invalid memory path binding");
    }
  }
  for (const name of ["dependencies", "environment"])
    if (bindings[name] !== undefined) versions(bindings[name]);
  const validity = keys(record.validity, ["state", "conditions", "expiresAt"]);
  if (!["current", "historical", "superseded"].includes(String(validity.state)))
    throw new Error("Invalid memory validity");
  strings(validity.conditions);
  if (validity.expiresAt !== undefined) date(validity.expiresAt);
  strings(record.supersedes);
  if (!record.supersedes.every(isHash))
    throw new Error("Invalid superseded memory identity");
}

export function assertRepositoryMemoryBindings(
  value: unknown,
): asserts value is RepositoryMemoryBinding[] {
  if (!Array.isArray(value))
    throw new Error("Memory bindings must be an array");
  const seen = new Set<string>();
  for (const valueEntry of value) {
    const binding = keys(valueEntry, ["id", "manifestRef"]);
    ref(binding.manifestRef);
    if (
      !isHash(binding.id) ||
      binding.id !== binding.manifestRef.digest ||
      binding.manifestRef.mediaType !== "application/json" ||
      seen.has(binding.id)
    )
      throw new Error("Invalid or duplicate memory manifest binding");
    seen.add(binding.id);
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
class MemoryStorageDenied extends Error {}
function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    stat.mode & 0o077 ||
    realpathSync(path) !== resolve(path)
  )
    throw new MemoryStorageDenied(
      "Memory storage must be an owned private directory without links",
    );
}
function privateRead(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.mode & 0o077)
      throw new MemoryStorageDenied(
        "Memory manifest pointer must be an owned private file",
      );
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}
function append(path: string, bytes: string): void {
  if (existsSync(path)) {
    if (privateRead(path) !== bytes)
      throw new Error("Immutable memory identity has different retained bytes");
    return;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    try {
      linkSync(temporary, path);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "EEXIST" ||
        privateRead(path) !== bytes
      )
        throw error;
    }
    const directory = openSync(join(path, ".."), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Immutable manifests and supporting bodies outlive worktrees and native sessions.
 * No automatic forgetting or cleanup is permitted here. Catalog rows have no lifecycle authority.
 */
export class LocalRepositoryMemory {
  private readonly directory: string;
  private readonly records: string;
  private readonly store: LocalContentStore;
  catalogStatus: "ready" | "unavailable" = "unavailable";
  constructor(
    root: string,
    readonly repository: string,
    store?: LocalContentStore,
  ) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
      throw new Error("Invalid memory repository scope");
    privateDirectory(root);
    this.directory = join(root, "memory");
    this.records = join(this.directory, "records");
    privateDirectory(this.directory);
    privateDirectory(this.records);
    this.store = store ?? new LocalContentStore(join(root, "content"));
  }
  retain(record: RepositoryMemoryRecord): RepositoryMemoryBinding {
    assertRepositoryMemoryRecord(record);
    if (record.repository !== this.repository)
      throw new Error("Memory repository differs from the retained root");
    // Missing legacy references are retained as declared, never reconstructed.
    for (const body of record.bodies)
      if (body.availability === "retained") this.store.readBytes(body.ref!);
    for (const source of record.sources)
      if (source.ref !== undefined && source.complete)
        this.store.readBytes(source.ref);
    const meaningful = canonical({ ...record, createdAt: undefined });
    const existing = this.retained().entries.find(
      (entry) =>
        canonical({ ...entry.record, createdAt: undefined }) === meaningful,
    );
    if (existing) return existing.binding;
    const manifestRef = this.store.putBytes(Buffer.from(canonical(record)), {
      mediaType: "application/json",
    });
    const binding = { id: manifestRef.digest, manifestRef };
    append(join(this.records, `${binding.id}.json`), canonical(binding));
    // A failed derived index never prevents retention or changes continuation.
    try {
      this.index(binding, record);
    } catch (error) {
      this.catalogStatus = "unavailable";
      if (error instanceof MemoryStorageDenied) throw error;
    }
    return binding;
  }
  private accessible(
    access: MemoryAccess,
    record: RepositoryMemoryRecord,
  ): boolean {
    return (
      access.repository === this.repository &&
      record.repository === access.repository &&
      access.visibility.includes(record.visibility)
    );
  }
  private manifest(id: string): {
    binding: RepositoryMemoryBinding;
    record: RepositoryMemoryRecord;
  } {
    if (!isHash(id)) throw new Error("Invalid memory identity");
    const binding: RepositoryMemoryBinding = JSON.parse(
      privateRead(join(this.records, `${id}.json`)),
    );
    assertRepositoryMemoryBindings([binding]);
    if (binding.id !== id)
      throw new Error("Memory filename differs from manifest identity");
    const bytes = this.store.readBytes(binding.manifestRef);
    const record: RepositoryMemoryRecord = JSON.parse(bytes.toString("utf8"));
    assertRepositoryMemoryRecord(record);
    if (
      record.repository !== this.repository ||
      canonical(record) !== bytes.toString("utf8")
    )
      throw new Error(
        "Memory manifest differs from its retained scope or canonical bytes",
      );
    return { binding, record };
  }
  private retained(): {
    entries: ReturnType<LocalRepositoryMemory["manifest"]>[];
    unavailable: string[];
  } {
    const entries: ReturnType<LocalRepositoryMemory["manifest"]>[] = [];
    const unavailable: string[] = [];
    for (const name of readdirSync(this.records)
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .sort()) {
      try {
        entries.push(this.manifest(name.slice(0, -5)));
      } catch (error) {
        if (error instanceof MemoryStorageDenied) throw error;
        unavailable.push(name.slice(0, -5));
      }
    }
    return { entries, unavailable };
  }
  private database(): DatabaseSync {
    const path = join(this.directory, "catalog.sqlite");
    if (!existsSync(path)) {
      try {
        closeSync(openSync(path, "wx", 0o600));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      if (!existsSync(file)) continue;
      const stat = lstatSync(file);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.uid !== process.getuid?.() ||
        stat.mode & 0o077
      )
        throw new MemoryStorageDenied(
          "Memory catalog must be an owned private file without links",
        );
    }
    // Lazy loading leaves existing static Objectives usable on older Node 22.
    const sqlite = createRequire(import.meta.url)(
      "node:sqlite",
    ) as typeof import("node:sqlite");
    const db = new sqlite.DatabaseSync(path);
    try {
      db.exec(
        "PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS memory (id TEXT PRIMARY KEY, repository TEXT NOT NULL, visibility TEXT NOT NULL, created TEXT NOT NULL); CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(id UNINDEXED, text);",
      );
      this.catalogStatus = "ready";
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }
  private searchable(record: RepositoryMemoryRecord): string {
    const bodies: string[] = [];
    for (const body of record.bodies) {
      if (
        body.availability !== "retained" ||
        !body.ref ||
        body.ref.bytes > 4 * 1024 * 1024
      )
        continue;
      try {
        bodies.push(this.store.readBytes(body.ref).toString("utf8"));
      } catch {
        /* Retained missing bodies remain visible at read time. */
      }
    }
    return [
      record.summary,
      record.kind,
      canonical(record.bindings),
      canonical(record.sources),
      ...bodies,
    ].join("\n");
  }
  private insert(
    db: DatabaseSync,
    binding: RepositoryMemoryBinding,
    record: RepositoryMemoryRecord,
  ): void {
    db.prepare("INSERT OR IGNORE INTO memory VALUES (?, ?, ?, ?)").run(
      binding.id,
      record.repository,
      record.visibility,
      record.createdAt,
    );
    db.prepare("DELETE FROM memory_fts WHERE id = ?").run(binding.id);
    db.prepare("INSERT INTO memory_fts (id, text) VALUES (?, ?)").run(
      binding.id,
      this.searchable(record),
    );
  }
  private index(
    binding: RepositoryMemoryBinding,
    record: RepositoryMemoryRecord,
  ): void {
    const db = this.database();
    try {
      db.exec("BEGIN IMMEDIATE");
      this.insert(db, binding, record);
      db.exec("COMMIT");
    } finally {
      db.close();
    }
  }
  rebuild(): { records: number; unavailable: string[] } {
    const retained = this.retained();
    let db: DatabaseSync | undefined;
    try {
      db = this.database();
      db.exec("BEGIN IMMEDIATE; DELETE FROM memory; DELETE FROM memory_fts;");
      for (const entry of retained.entries)
        this.insert(db, entry.binding, entry.record);
      db.exec("COMMIT");
    } catch (error) {
      this.catalogStatus = "unavailable";
      if (error instanceof MemoryStorageDenied) throw error;
    } finally {
      db?.close();
    }
    return {
      records: retained.entries.length,
      unavailable: retained.unavailable,
    };
  }
  private result(
    entry: ReturnType<LocalRepositoryMemory["manifest"]>,
    applicability: MemoryApplicability | undefined,
    budget: { bytes: number },
    superseded = false,
  ): MemoryResult {
    const { binding, record } = entry;
    const gaps: string[] = [];
    let disposition: MemoryResult["disposition"] =
      record.validity.state === "current" && !superseded
        ? "current"
        : "historical";
    const check = (
      label: string,
      expected: string,
      actual: string | undefined,
    ) => {
      if (actual === expected) return;
      gaps.push(
        `${label}: ${actual === undefined ? "not verified" : "binding mismatch"}`,
      );
      if (disposition === "unavailable" || disposition === "incomplete") return;
      disposition =
        actual === undefined
          ? disposition === "stale"
            ? "stale"
            : "historical"
          : "stale";
    };
    for (const condition of record.validity.conditions)
      if (!applicability?.conditions?.includes(condition)) {
        gaps.push(`validity condition not verified: ${condition}`);
        if (disposition === "current") disposition = "historical";
      }
    if (record.bindings.treeSha)
      check("source tree", record.bindings.treeSha, applicability?.treeSha);
    for (const path of record.bindings.paths ?? [])
      check(
        `path ${path.path}`,
        path.digest,
        applicability?.paths?.[path.path],
      );
    for (const kind of ["dependencies", "environment"] as const)
      for (const [key, expected] of Object.entries(record.bindings[kind] ?? {}))
        check(`${kind} ${key}`, expected, applicability?.[kind]?.[key]);
    if (
      record.validity.expiresAt &&
      Date.parse(record.validity.expiresAt) <= Date.now()
    ) {
      disposition = "stale";
      gaps.push("validity expired");
    }
    if (superseded || record.validity.state === "superseded")
      gaps.push("superseded historical lead");
    const content: MemoryResult["content"] = [];
    for (const body of record.bodies) {
      if (body.availability === "missing-legacy" || !body.ref) {
        gaps.push(`${body.role}: missing legacy body`);
        disposition = "unavailable";
        continue;
      }
      try {
        const bytes = this.store.readBytes(body.ref);
        if (bytes.length > budget.bytes) {
          gaps.push(
            `${body.role}: complete body exceeds remaining byte allowance`,
          );
          if (disposition !== "unavailable") disposition = "incomplete";
          continue;
        }
        budget.bytes -= bytes.length;
        content.push({
          role: body.role,
          ref: body.ref,
          text: bytes.toString("utf8"),
        });
      } catch {
        gaps.push(`${body.role}: referenced bytes unavailable or corrupt`);
        disposition = "unavailable";
      }
    }
    for (const source of record.sources) {
      for (const kind of [
        "version",
        "apiVersion",
        "dependencyVersion",
      ] as const)
        if (source[kind])
          check(
            `source ${source.identity} ${kind}`,
            source[kind],
            applicability?.sources?.[source.identity]?.[kind],
          );
      if (!source.complete || !source.ref) {
        gaps.push(
          `source ${source.identity}: incomplete or unavailable source content`,
        );
        if (disposition !== "unavailable") disposition = "incomplete";
      } else {
        try {
          this.store.readBytes(source.ref);
        } catch {
          gaps.push(
            `source ${source.identity}: referenced bytes unavailable or corrupt`,
          );
          disposition = "unavailable";
        }
      }
    }
    return { binding, record, disposition, content, gaps };
  }
  private eligible(
    lookup: MemoryLookup,
  ): ReturnType<LocalRepositoryMemory["retained"]> {
    if (
      !Number.isSafeInteger(lookup.limit) ||
      lookup.limit < 0 ||
      lookup.limit > 256 ||
      (lookup.maxBytes !== undefined &&
        (!Number.isSafeInteger(lookup.maxBytes) || lookup.maxBytes < 0))
    )
      throw new Error("Invalid memory lookup bound");
    if (lookup.access.repository !== this.repository)
      return { entries: [], unavailable: [] };
    if (
      !Array.isArray(lookup.access.visibility) ||
      lookup.access.visibility.some(
        (scope) => !["repository", "private"].includes(scope),
      )
    )
      throw new Error("Invalid memory visibility access");
    const retained = this.retained();
    retained.entries = retained.entries.filter(
      (entry) =>
        this.accessible(lookup.access, entry.record) &&
        this.inScope(entry.record, lookup),
    );
    return retained;
  }
  private inScope(
    record: RepositoryMemoryRecord,
    lookup: MemoryLookup,
  ): boolean {
    const scope = lookup.scope;
    if (!scope) return true;
    if (scope.kinds && !scope.kinds.includes(record.kind)) return false;
    if (
      scope.objective !== undefined &&
      scope.objective === record.producer.objective
    )
      return true;
    if (
      (record.bindings.paths ?? []).some(({ path }) =>
        (scope.paths ?? []).some(
          (selector) =>
            path === selector ||
            path.startsWith(`${selector.replace(/\/$/, "")}/`),
        ),
      )
    )
      return true;
    if (scope.objective === undefined && scope.paths === undefined) return true;
    if (
      ![
        "decision",
        "repository-map",
        "reference",
        "diagnosed-correction",
      ].includes(record.kind) ||
      record.validity.state !== "current" ||
      (record.validity.expiresAt &&
        Date.parse(record.validity.expiresAt) <= Date.now())
    )
      return false;
    const expected = record.bindings;
    const supplied = lookup.applicability;
    if (!expected.treeSha || expected.treeSha !== supplied?.treeSha)
      return false;
    if (
      (record.validity.conditions ?? []).some(
        (condition) => !supplied?.conditions?.includes(condition),
      )
    )
      return false;
    if (
      (expected.paths ?? []).some(
        ({ path, digest }) => supplied?.paths?.[path] !== digest,
      )
    )
      return false;
    for (const kind of ["dependencies", "environment"] as const)
      for (const [name, version] of Object.entries(expected[kind] ?? {}))
        if (supplied?.[kind]?.[name] !== version) return false;
    for (const source of record.sources)
      for (const kind of [
        "version",
        "apiVersion",
        "dependencyVersion",
      ] as const)
        if (
          source[kind] &&
          source[kind] !== supplied?.sources?.[source.identity]?.[kind]
        )
          return false;
    return true;
  }
  /** Eligible manifest metadata only; no supporting body is opened for relevance selection. */
  metadata(lookup: MemoryLookup): {
    entries: {
      binding: RepositoryMemoryBinding;
      record: RepositoryMemoryRecord;
    }[];
    complete: boolean;
    unavailable: string[];
  } {
    const retained = this.eligible(lookup);
    return {
      entries: retained.entries
        .sort((left, right) =>
          right.record.createdAt.localeCompare(left.record.createdAt),
        )
        .slice(0, lookup.limit),
      complete:
        retained.entries.length <= lookup.limit && !retained.unavailable.length,
      unavailable: retained.unavailable.length
        ? ["retained manifest integrity or availability gap"]
        : [],
    };
  }
  catalog(lookup: MemoryLookup): {
    results: MemoryResult[];
    complete: boolean;
    unavailable: string[];
  } {
    const retained = this.eligible(lookup);
    const superseded = new Set(
      retained.entries.flatMap((entry) => entry.record.supersedes),
    );
    const budget = { bytes: lookup.maxBytes ?? 262_144 };
    const entries = retained.entries
      .sort((left, right) =>
        right.record.createdAt.localeCompare(left.record.createdAt),
      )
      .slice(0, lookup.limit);
    return {
      results: entries.map((entry) =>
        this.result(
          entry,
          lookup.applicability,
          budget,
          superseded.has(entry.binding.id),
        ),
      ),
      complete:
        retained.entries.length <= lookup.limit && !retained.unavailable.length,
      unavailable: retained.unavailable.length
        ? ["retained manifest integrity or availability gap"]
        : [],
    };
  }
  search(lookup: MemoryLookup & { query: string }): MemoryResult[] {
    const retained = this.eligible(lookup);
    const words = lookup.query.match(/[\p{L}\p{N}_-]+/gu)?.slice(0, 32) ?? [];
    if (!words.length || !retained.entries.length || !lookup.limit) return [];
    const eligible = new Map(
      retained.entries.map((entry) => [entry.binding.id, entry]),
    );
    let selected: typeof retained.entries;
    let db: DatabaseSync | undefined;
    try {
      db = this.database();
      db.exec(
        "BEGIN IMMEDIATE; CREATE TEMP TABLE selected_scope (id TEXT PRIMARY KEY);",
      );
      for (const entry of retained.entries) {
        this.insert(db, entry.binding, entry.record);
        db.prepare("INSERT INTO selected_scope VALUES (?)").run(
          entry.binding.id,
        );
      }
      db.exec("COMMIT");
      // Eligible scope is filtered before full-text ranking. No titles from denied roots.
      const visibility = [...new Set(lookup.access.visibility)];
      if (!visibility.length) return [];
      const ids = db
        .prepare(
          `SELECT memory.id FROM memory JOIN selected_scope ON memory.id = selected_scope.id JOIN memory_fts ON memory.id = memory_fts.id WHERE memory.repository = ? AND memory.visibility IN (${visibility.map(() => "?").join(",")}) AND memory_fts MATCH ? ORDER BY bm25(memory_fts), memory.created DESC LIMIT ?`,
        )
        .all(
          this.repository,
          ...visibility,
          words.map((word) => `"${word}"`).join(" OR "),
          lookup.limit,
        );
      selected = ids.flatMap((row) =>
        eligible.has(String(row.id)) ? [eligible.get(String(row.id))!] : [],
      );
    } catch (error) {
      if (error instanceof MemoryStorageDenied) throw error;
      this.catalogStatus = "unavailable";
      selected = retained.entries
        .filter((entry) =>
          words.some((word) =>
            this.searchable(entry.record)
              .toLowerCase()
              .includes(word.toLowerCase()),
          ),
        )
        .slice(0, lookup.limit);
    } finally {
      db?.close();
    }
    const superseded = new Set(
      retained.entries.flatMap((entry) => entry.record.supersedes),
    );
    const budget = { bytes: lookup.maxBytes ?? 262_144 };
    return selected.map((entry) =>
      this.result(
        entry,
        lookup.applicability,
        budget,
        superseded.has(entry.binding.id),
      ),
    );
  }
  read(
    lookup: Omit<MemoryLookup, "limit"> & { id: string },
  ): MemoryResult | undefined {
    const retained = this.eligible({ ...lookup, limit: 1 });
    const entry = retained.entries.find(
      (entry) => entry.binding.id === lookup.id,
    );
    if (!entry) return undefined;
    return this.result(
      entry,
      lookup.applicability,
      { bytes: lookup.maxBytes ?? 262_144 },
      retained.entries.some((peer) =>
        peer.record.supersedes.includes(entry.binding.id),
      ),
    );
  }
}

/** Observe real retained attempts at the snapshot seam; no model calls or inferred success.
 * Only content-bearing/started attempts are retained. The returned bindings belong in that
 * same atomic continuation snapshot. On failure the caller preserves its original outcome.
 */
export function retainStateMemory(
  state: ContinuationState,
  root: string,
): RepositoryMemoryBinding[] {
  const store = new LocalContentStore(join(root, "content"));
  const memory = new LocalRepositoryMemory(root, state.repository, store);
  const bindings: RepositoryMemoryBinding[] = [];
  const retain = (record: RepositoryMemoryRecord) => {
    const binding = memory.retain(record);
    if (!bindings.some((entry) => entry.id === binding.id))
      bindings.push(binding);
  };
  const body = (
    role: string,
    value: unknown,
  ): RepositoryMemoryRecord["bodies"][number] => ({
    role,
    ref: store.putBytes(Buffer.from(canonical(value)), {
      mediaType: "application/json",
    }),
    availability: "retained",
  });
  const retained = (
    role: string,
    contentRef: ContentRef,
  ): RepositoryMemoryRecord["bodies"][number] => {
    try {
      store.readBytes(contentRef);
      return { role, ref: contentRef, availability: "retained" };
    } catch {
      return { role, ref: contentRef, availability: "missing-legacy" };
    }
  };
  const now = new Date().toISOString();
  const base = (
    itemId: string | undefined,
    work: WorkState | undefined,
  ): RepositoryMemoryRecord => ({
    schemaVersion: 1,
    repository: state.repository,
    visibility: "private",
    kind: "observation",
    producer: {
      objective: state.objective,
      runId: state.runId,
      ...(itemId ? { itemId } : {}),
      ...(work?.attempt ? { attemptId: work.attempt } : {}),
      status:
        work?.status ??
        (state.cancelledAt
          ? "cancelled"
          : state.schemaVersion === 7 && state.finalAcceptance
            ? "accepted"
            : "working"),
    },
    createdAt: now,
    authority: "observation",
    summary: itemId
      ? `Work Item ${itemId}: ${work?.status ?? "unknown"}`
      : `Objective ${state.objective}: retained working observation`,
    bodies: [],
    sources: [],
    bindings: {
      ...(work?.treeSha ? { treeSha: work.treeSha } : {}),
      environment: { configDigest: state.configDigest },
    },
    validity: { state: "historical", conditions: [] },
    supersedes: [],
  });
  const observeWork = (itemId: string, work: WorkState) => {
    if (
      !work.attempt &&
      !work.error &&
      !work.knowledge &&
      !work.failedValidation
    )
      return;
    const observation = base(itemId, work);
    observation.kind =
      work.status === "failed" || work.error ? "failure" : "observation";
    observation.bodies = [
      body("attempt-observation", {
        status: work.status,
        step: work.step,
        attempt: work.attempt,
        executionBaseSha: work.executionBaseSha,
        changeRef: work.changeRef,
        treeSha: work.treeSha,
        error: work.error,
        failedValidation: work.failedValidation,
        validation: work.validation,
        acceptancePending: work.acceptancePending,
        acceptanceDecisions: work.acceptanceDecisions,
        assets: work.assets,
        recovery: work.recovery
          ? {
              failure: work.recovery.failure,
              correction: work.recovery.correction,
            }
          : undefined,
      }),
    ];
    retain(observation);
    if (work.knowledge) {
      const knowledge = work.knowledge;
      const handoff = base(itemId, work);
      handoff.kind = "handoff";
      handoff.authority = "advisory";
      handoff.summary =
        knowledge.notes
          .map((note) => `${note.kind}: ${note.summary}`)
          .join("\n") || "Retained Objective handoff";
      handoff.bodies = [
        retained("handoff", knowledge.recordRef),
        ...knowledge.sources.map((source) =>
          retained(`source:${source.path}`, source.ref),
        ),
      ];
      handoff.sources = knowledge.sources.map((source) => ({
        identity: `repository:${source.path}`,
        complete:
          handoff.bodies.find((body) => body.role === `source:${source.path}`)
            ?.availability === "retained",
        ref: source.ref,
      }));
      handoff.bindings = {
        treeSha: knowledge.treeSha,
        paths: knowledge.sources.map((source) => ({
          path: source.path,
          digest: source.ref.digest,
        })),
        environment: { configDigest: knowledge.configDigest },
      };
      handoff.validity = { state: "current", conditions: [] };
      retain(handoff);
    }
    if (work.recovery?.correction) {
      const correction = base(itemId, work);
      correction.kind = "diagnosed-correction";
      correction.authority = "advisory";
      correction.summary = `${work.recovery.correction.diagnosis}\n${work.recovery.correction.correction}`;
      correction.bodies = [
        body("diagnosed-correction", {
          failure: work.recovery.failure,
          correction: work.recovery.correction,
        }),
      ];
      correction.validity = { state: "current", conditions: [] };
      retain(correction);
    }
    for (const previous of work.recovery?.history ?? [])
      observeWork(itemId, previous.work);
  };
  if (state.schemaVersion === 7)
    for (const [itemId, work] of Object.entries(state.work))
      observeWork(itemId, work);
  if (
    state.error ||
    state.cancelledAt ||
    state.planningRecovery ||
    (state.schemaVersion === 7 && state.finalAcceptance)
  ) {
    const observation = base(undefined, undefined);
    observation.kind = state.error ? "failure" : "observation";
    observation.bodies = [
      body("objective-observation", {
        error: state.error,
        cancelledAt: state.cancelledAt,
        planningRecovery: state.planningRecovery,
        acceptance:
          state.schemaVersion === 7 ? state.finalAcceptance : undefined,
      }),
    ];
    retain(observation);
  }
  return bindings;
}
