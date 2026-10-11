import { createHash } from "node:crypto";
import type { ContentRef, ContentStore } from "./contracts.js";
import { ownsPath, validOwnershipPath } from "./ownership.js";
import { pinnedGit, pinnedGitRaw } from "./process.js";

/** Discovery is information, never QA proof, source ownership or delivery authority. */
export interface DiscoverySpecification {
  mode: "inventory" | "semantic";
  selectors: string[];
  schema: "factory.repository-inventory/v1";
  role: string;
  completeness: "complete";
  allowance: { maxEntries: number; maxBytes: number; maxAttempts: number };
}

export type DiscoveryStatus =
  | "complete"
  | "partial"
  | "unreadable"
  | "truncated"
  | "failed";

export interface DiscoveryProducer {
  objective: number;
  runId: string;
  itemId: string;
  attemptId: string;
}

export interface DiscoveryEntry {
  path: string;
  mode: "100644" | "100755" | "120000";
  blobSha: string;
  content: ContentRef;
  /** Advisory semantics; an authenticated blob does not authenticate this judgment. */
  classification?: string;
}

export interface DiscoveryBody {
  schema: "factory.repository-inventory/v1";
  entries: DiscoveryEntry[];
  failures: {
    path: string;
    status: Exclude<DiscoveryStatus, "complete">;
    detail: string;
  }[];
  semantic?: { status: "complete" | "partial" | "failed"; detail: string };
}

export interface DiscoveryOutputManifest {
  schemaVersion: 1;
  producer: DiscoveryProducer;
  role: string;
  schema: "factory.repository-inventory/v1";
  specificationDigest: string;
  source: { commitSha: string; treeSha: string; selectors: string[] };
  status: DiscoveryStatus;
  selectedEntries: number;
  body: ContentRef;
  disposition: "observation" | "advisory";
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function keys(
  value: Record<string, unknown>,
  expected: string[],
  label: string,
): void {
  if (Object.keys(value).some((key) => !expected.includes(key)))
    throw new Error(`${label} has an unsupported field`);
}

export function assertDiscoverySpecification(
  value: unknown,
): asserts value is DiscoverySpecification {
  const spec = object(value, "Discovery specification");
  keys(
    spec,
    ["mode", "selectors", "schema", "role", "completeness", "allowance"],
    "Discovery specification",
  );
  if (
    (spec.mode !== "inventory" && spec.mode !== "semantic") ||
    spec.schema !== "factory.repository-inventory/v1" ||
    spec.completeness !== "complete" ||
    typeof spec.role !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(spec.role) ||
    !Array.isArray(spec.selectors) ||
    !spec.selectors.length ||
    spec.selectors.some(
      (path) => typeof path !== "string" || !validOwnershipPath(path),
    ) ||
    new Set(spec.selectors).size !== spec.selectors.length
  )
    throw new Error(
      "Discovery requires literal read selectors, a supported schema, role and complete output",
    );
  const allowance = object(spec.allowance, "Discovery allowance");
  keys(
    allowance,
    ["maxEntries", "maxBytes", "maxAttempts"],
    "Discovery allowance",
  );
  if (
    [allowance.maxEntries, allowance.maxBytes, allowance.maxAttempts].some(
      (limit) =>
        typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0,
    )
  )
    throw new Error("Discovery requires finite positive allowances");
}

export function discoverySpecificationDigest(
  spec: DiscoverySpecification,
): string {
  assertDiscoverySpecification(spec);
  return createHash("sha256").update(JSON.stringify(spec)).digest("hex");
}

interface TreeEntry {
  path: string;
  mode: string;
  kind: string;
  oid: string;
}

function selectedTree(
  checkout: string,
  treeSha: string,
  selectors: string[],
): TreeEntry[] {
  const raw = pinnedGitRaw(checkout, "ls-tree", "-r", "-z", treeSha);
  const result: TreeEntry[] = [];
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  for (const record of decoded
    .slice(0, decoded.length ? decoded.length - 1 : 0)
    .split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    const [mode, kind, oid] = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    if (tab < 0 || !mode || !kind || !oid || !/^[0-9a-f]{40,64}$/.test(oid))
      throw new Error("Discovery tree enumeration is malformed");
    if (ownsPath(path, selectors)) result.push({ path, mode, kind, oid });
  }
  return result;
}

async function put(
  store: ContentStore,
  bytes: Uint8Array,
  mediaType: string,
): Promise<ContentRef> {
  return store.put(
    new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    { mediaType },
  );
}

export async function readDiscoveryBody(
  store: ContentStore,
  ref: ContentRef,
): Promise<DiscoveryBody> {
  await store.verify(ref);
  const bytes = await new Response(await store.open(ref)).arrayBuffer();
  const body = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  const value = object(body, "Discovery body");
  keys(value, ["schema", "entries", "failures", "semantic"], "Discovery body");
  if (
    value.schema !== "factory.repository-inventory/v1" ||
    !Array.isArray(value.entries) ||
    !Array.isArray(value.failures)
  )
    throw new Error("Discovery body has an unsupported schema");
  return body as DiscoveryBody;
}

/** Reads immutable Git objects only; complete bodies remain outside target Git. */
export async function discoverRepository(args: {
  checkout: string;
  baseSha: string;
  specification: DiscoverySpecification;
  producer: DiscoveryProducer;
  store: ContentStore;
  cancelled?: () => boolean;
}): Promise<DiscoveryOutputManifest> {
  const spec = args.specification;
  assertDiscoverySpecification(spec);
  if (
    !/^[0-9a-f]{40,64}$/.test(args.baseSha) ||
    pinnedGit(
      args.checkout,
      "rev-parse",
      "--verify",
      `${args.baseSha}^{commit}`,
    ) !== args.baseSha
  )
    throw new Error("Discovery source commit does not resolve exactly");
  const treeSha = pinnedGit(
    args.checkout,
    "rev-parse",
    `${args.baseSha}^{tree}`,
  );
  const selected = selectedTree(args.checkout, treeSha, spec.selectors);
  const body: DiscoveryBody = {
    schema: spec.schema,
    entries: [],
    failures: [],
  };
  let remaining = spec.allowance.maxBytes;
  for (const entry of selected) {
    if (args.cancelled?.()) throw new Error("Discovery cancelled");
    if (body.entries.length + body.failures.length >= spec.allowance.maxEntries)
      break;
    if (
      entry.kind !== "blob" ||
      !["100644", "100755", "120000"].includes(entry.mode)
    ) {
      body.failures.push({
        path: entry.path,
        status: "unreadable",
        detail: "Selected entry is not a repository blob",
      });
      continue;
    }
    try {
      const size = Number(
        pinnedGit(args.checkout, "cat-file", "-s", entry.oid),
      );
      if (!Number.isSafeInteger(size) || size < 0)
        throw new Error("Invalid Git blob size");
      if (size > remaining) {
        body.failures.push({
          path: entry.path,
          status: "truncated",
          detail: "Declared source byte allowance exhausted",
        });
        continue;
      }
      const bytes = pinnedGitRaw(args.checkout, "cat-file", "blob", entry.oid);
      if (bytes.length !== size) throw new Error("Git blob read is incomplete");
      const content = await put(args.store, bytes, "application/octet-stream");
      remaining -= bytes.length;
      body.entries.push({
        path: entry.path,
        mode: entry.mode as DiscoveryEntry["mode"],
        blobSha: entry.oid,
        content,
      });
    } catch (error) {
      body.failures.push({
        path: entry.path,
        status: "unreadable",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const status =
    body.entries.length + body.failures.length < selected.length ||
    body.failures.some((failure) => failure.status === "truncated")
      ? "truncated"
      : body.failures.length
        ? "unreadable"
        : "complete";
  return {
    schemaVersion: 1,
    producer: structuredClone(args.producer),
    role: spec.role,
    schema: spec.schema,
    specificationDigest: discoverySpecificationDigest(spec),
    source: {
      commitSha: args.baseSha,
      treeSha,
      selectors: [...spec.selectors],
    },
    status,
    selectedEntries: selected.length,
    body: await put(
      args.store,
      Buffer.from(JSON.stringify(body)),
      "application/json",
    ),
    disposition: "observation",
  };
}

/** Reconstruct completeness from the tree and exact bytes; never trust model paths. */
export async function authenticateDiscoveryOutput(args: {
  checkout: string;
  specification: DiscoverySpecification;
  manifest: DiscoveryOutputManifest;
  store: ContentStore;
}): Promise<DiscoveryBody> {
  const { manifest, specification: spec } = args;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.schema !== spec.schema ||
    manifest.role !== spec.role ||
    manifest.specificationDigest !== discoverySpecificationDigest(spec) ||
    JSON.stringify(manifest.source.selectors) !==
      JSON.stringify(spec.selectors) ||
    pinnedGit(
      args.checkout,
      "rev-parse",
      `${manifest.source.commitSha}^{tree}`,
    ) !== manifest.source.treeSha
  )
    throw new Error("Discovery manifest source or schema binding differs");
  const tree = selectedTree(
    args.checkout,
    manifest.source.treeSha,
    spec.selectors,
  );
  const body = await readDiscoveryBody(args.store, manifest.body);
  const observed = new Set<string>();
  let bytes = 0;
  for (const entry of body.entries) {
    const fields = object(entry, "Discovery entry");
    keys(
      fields,
      ["path", "mode", "blobSha", "content", "classification"],
      "Discovery entry",
    );
    const source = tree.find((source) => source.path === entry.path);
    if (
      !source ||
      source.kind !== "blob" ||
      source.mode !== entry.mode ||
      source.oid !== entry.blobSha ||
      observed.has(entry.path) ||
      (entry.classification !== undefined &&
        (typeof entry.classification !== "string" ||
          !entry.classification.trim()))
    )
      throw new Error("Discovery entry is duplicate, unobserved or mismatched");
    const actual = pinnedGitRaw(args.checkout, "cat-file", "blob", source.oid);
    if (
      entry.content.bytes !== actual.length ||
      entry.content.digest !== createHash("sha256").update(actual).digest("hex")
    )
      throw new Error("Discovery source body differs from its bound blob");
    await args.store.verify(entry.content);
    observed.add(entry.path);
    bytes += actual.length;
  }
  for (const failure of body.failures) {
    keys(
      object(failure, "Discovery failure"),
      ["path", "status", "detail"],
      "Discovery failure",
    );
    if (
      !tree.some((source) => source.path === failure.path) ||
      observed.has(failure.path) ||
      !["partial", "unreadable", "truncated", "failed"].includes(
        failure.status,
      ) ||
      typeof failure.detail !== "string" ||
      !failure.detail
    )
      throw new Error("Discovery failure has invalid provenance");
    observed.add(failure.path);
  }
  if (body.semantic) {
    keys(
      object(body.semantic, "Semantic discovery"),
      ["status", "detail"],
      "Semantic discovery",
    );
    if (
      !["complete", "partial", "failed"].includes(body.semantic.status) ||
      typeof body.semantic.detail !== "string" ||
      manifest.disposition !== "advisory" ||
      spec.mode !== "semantic" ||
      (body.semantic.status === "complete" &&
        body.entries.some((entry) => !entry.classification))
    )
      throw new Error("Semantic discovery has invalid completeness");
  } else if (manifest.disposition !== "observation")
    throw new Error("Discovery disposition is invalid");
  const expectedStatus =
    body.semantic?.status === "failed"
      ? "failed"
      : observed.size < tree.length ||
          body.failures.some((failure) => failure.status === "truncated")
        ? "truncated"
        : body.failures.length
          ? "unreadable"
          : body.semantic?.status === "partial"
            ? "partial"
            : "complete";
  if (
    manifest.selectedEntries !== tree.length ||
    manifest.status !== expectedStatus ||
    body.entries.length > spec.allowance.maxEntries ||
    bytes > spec.allowance.maxBytes ||
    (manifest.status === "complete" && observed.size !== tree.length)
  )
    throw new Error("Discovery completeness or allowance is invalid");
  return body;
}

export const DISCOVERY_CLASSIFICATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "entries", "detail"],
  properties: {
    status: { type: "string", enum: ["complete", "partial", "failed"] },
    detail: { type: "string" },
    entries: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "classification"],
        properties: {
          path: { type: "string" },
          classification: { type: "string" },
        },
      },
    },
  },
};

/** Semantic responses can annotate observed paths; they cannot fabricate source identities. */
export async function classifyDiscoveryOutput(args: {
  checkout: string;
  specification: DiscoverySpecification;
  manifest: DiscoveryOutputManifest;
  store: ContentStore;
  response: string;
}): Promise<DiscoveryOutputManifest> {
  const body = await authenticateDiscoveryOutput(args);
  if (
    args.specification.mode !== "semantic" ||
    args.manifest.status !== "complete"
  )
    throw new Error(
      "Semantic discovery requires a complete bound source inventory",
    );
  if (Buffer.byteLength(args.response) > args.specification.allowance.maxBytes)
    throw new Error(
      "Semantic discovery response exceeds its declared byte allowance",
    );
  const parsed = object(JSON.parse(args.response), "Semantic response");
  keys(parsed, ["status", "entries", "detail"], "Semantic response");
  if (
    !["complete", "partial", "failed"].includes(String(parsed.status)) ||
    typeof parsed.detail !== "string" ||
    !Array.isArray(parsed.entries)
  )
    throw new Error("Semantic discovery response is malformed");
  const seen = new Set<string>();
  for (const value of parsed.entries) {
    const entry = object(value, "Semantic classification");
    keys(entry, ["path", "classification"], "Semantic classification");
    const observed = body.entries.find((source) => source.path === entry.path);
    if (
      !observed ||
      seen.has(observed.path) ||
      typeof entry.classification !== "string" ||
      !entry.classification.trim()
    )
      throw new Error(
        "Semantic discovery cites an unobserved, duplicate or invalid path",
      );
    seen.add(observed.path);
    observed.classification = entry.classification;
  }
  if (parsed.status === "complete" && seen.size !== body.entries.length)
    throw new Error(
      "Semantic discovery claims completeness while omitting observed paths",
    );
  body.semantic = {
    status: parsed.status as "complete" | "partial" | "failed",
    detail: parsed.detail,
  };
  const manifest: DiscoveryOutputManifest = {
    ...structuredClone(args.manifest),
    status: body.semantic.status,
    disposition: "advisory",
    body: await put(
      args.store,
      Buffer.from(JSON.stringify(body)),
      "application/json",
    ),
  };
  await authenticateDiscoveryOutput({ ...args, manifest });
  return manifest;
}
