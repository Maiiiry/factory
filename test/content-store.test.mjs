import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { LocalContentStore } from "../dist/content/local.js";
import { LocalRepositoryMemory } from "../dist/repository-memory.js";

test("disk content survives storage and materialization, and corruption is refused", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-content-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source.bin");
  const bytes = Buffer.alloc(8 * 1024 * 1024, 0x5a);
  writeFileSync(source, bytes);
  const store = new LocalContentStore(join(root, "objects"));
  const ref = await store.put(Readable.toWeb(createReadStream(source)), {
    mediaType: "application/octet-stream",
  });
  await store.verify(ref);
  const copy = join(root, "copy.bin");
  await store.materialize(ref, copy);
  assert.equal(ref.bytes, bytes.length);
  assert.deepEqual(readFileSync(copy), bytes);
  writeFileSync(
    join(root, "objects", ref.digest.slice(0, 2), ref.digest),
    "corrupted",
  );
  await assert.rejects(store.verify(ref), /digest verification/);
});

test("repository memory verifies complete retained bodies and rebuilds scoped SQLite search after workspace disposal", (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-memory-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout");
  const state = join(root, "state");
  mkdirSync(checkout);
  const git = (...args) =>
    execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  writeFileSync(
    join(checkout, "api.md"),
    "Complete reference for the orchard API.\n",
  );
  git("add", "api.md");
  git("commit", "-m", "Document the API");
  const treeSha = git("rev-parse", "HEAD^{tree}");
  const store = new LocalContentStore(join(state, "content"));
  const source = readFileSync(join(checkout, "api.md"));
  const sourceRef = store.putBytes(source, { mediaType: "text/markdown" });
  const memory = new LocalRepositoryMemory(state, "fixture/memory", store);
  const record = {
    schemaVersion: 1,
    repository: "fixture/memory",
    visibility: "repository",
    kind: "reference",
    producer: {
      objective: 1,
      runId: git("rev-parse", "HEAD"),
      status: "observed",
    },
    createdAt: new Date().toISOString(),
    authority: "observation",
    summary: "Complete orchard API reference",
    bodies: [
      { role: "api-documentation", ref: sourceRef, availability: "retained" },
    ],
    sources: [
      {
        identity: "repository:api.md",
        version: treeSha,
        apiVersion: "1",
        dependencyVersion: "1.2",
        retrievedAt: new Date().toISOString(),
        complete: true,
        ref: sourceRef,
      },
    ],
    bindings: {
      treeSha,
      paths: [
        {
          path: "api.md",
          digest: createHash("sha256").update(source).digest("hex"),
        },
      ],
      environment: { runtime: process.version },
    },
    validity: { state: "current", conditions: ["orchard API 1"] },
    supersedes: [],
  };
  const binding = memory.retain(record);
  assert.equal(memory.catalogStatus, "ready");
  assert.equal(existsSync(join(state, "memory", "catalog.sqlite")), true);
  assert.deepEqual(
    memory.retain({ ...record, createdAt: "2000-01-01T00:00:00.000Z" }),
    binding,
  );
  const second = memory.retain({
    ...record,
    sources: [
      { ...record.sources[0], identity: "authorized-document:orchard-api" },
    ],
  });
  assert.notEqual(second.id, binding.id);
  assert.equal(second.manifestRef.bytes > 0, true);
  assert.equal(
    memory.metadata({
      access: {
        repository: "different/repository",
        visibility: ["repository", "private"],
      },
      limit: 10,
    }).entries.length,
    0,
  );

  const secretRef = store.putBytes(
    Buffer.from("Private unrelated orchard debugging notes"),
    { mediaType: "text/plain" },
  );
  const denied = memory.retain({
    ...record,
    visibility: "private",
    producer: { ...record.producer, objective: 2 },
    kind: "hypothesis",
    summary: "Private unrelated debugging notes",
    bodies: [
      { role: "private-history", ref: secretRef, availability: "retained" },
    ],
    sources: [],
    bindings: {},
  });
  const access = { repository: "fixture/memory", visibility: ["repository"] };
  const applicability = {
    treeSha,
    paths: { "api.md": sourceRef.digest },
    environment: { runtime: process.version },
    conditions: ["orchard API 1"],
    sources: {
      "repository:api.md": {
        version: treeSha,
        apiVersion: "1",
        dependencyVersion: "1.2",
      },
      "authorized-document:orchard-api": {
        version: treeSha,
        apiVersion: "1",
        dependencyVersion: "1.2",
      },
    },
  };
  assert.equal(memory.read({ access, id: denied.id }), undefined);
  const current = memory.read({ access, id: binding.id, applicability });
  assert.equal(current.disposition, "current");
  assert.equal(current.content[0].text, source.toString("utf8"));
  assert.equal(
    memory.read({ access, id: binding.id }).disposition,
    "historical",
  );
  assert.equal(
    memory.read({
      access,
      id: binding.id,
      applicability: { ...applicability, treeSha: "f".repeat(40) },
    }).disposition,
    "stale",
  );
  assert.equal(
    memory.read({
      access,
      id: binding.id,
      applicability: {
        ...applicability,
        sources: {
          "repository:api.md": {
            version: treeSha,
            apiVersion: "2",
            dependencyVersion: "1.2",
          },
        },
      },
    }).disposition,
    "stale",
  );
  const bounded = memory.read({
    access,
    id: binding.id,
    applicability,
    maxBytes: source.length - 1,
  });
  assert.equal(bounded.disposition, "incomplete");
  assert.equal(bounded.content.length, 0);
  assert.match(bounded.gaps.join("\n"), /complete body exceeds/);
  const missing = memory.retain({
    ...record,
    kind: "episode",
    bodies: [{ role: "legacy-source", availability: "missing-legacy" }],
    sources: [{ identity: "legacy-native-session", complete: false }],
  });
  assert.equal(
    memory.read({ access, id: missing.id, applicability }).disposition,
    "unavailable",
  );
  const superseding = memory.retain({
    ...record,
    summary: "Updated complete orchard API reference",
    supersedes: [binding.id],
  });
  assert.equal(
    memory.read({ access, id: binding.id, applicability }).disposition,
    "historical",
  );
  assert.equal(
    memory.read({ access, id: superseding.id, applicability }).disposition,
    "current",
  );

  const metadata = memory.metadata({
    access: {
      repository: "fixture/memory",
      visibility: ["repository", "private"],
    },
    scope: { objective: 1, paths: ["api.md"] },
    limit: 20,
    applicability,
  });
  assert.equal(metadata.complete, true);
  assert.equal(
    metadata.entries.some((entry) => entry.binding.id === denied.id),
    false,
  );
  writeFileSync(
    join(state, "content", secretRef.digest.slice(0, 2), secretRef.digest),
    "corrupt excluded history",
  );
  const results = memory.search({
    access: {
      repository: "fixture/memory",
      visibility: ["repository", "private"],
    },
    scope: { objective: 1, paths: ["api.md"] },
    query: "orchard",
    limit: 1,
    applicability,
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].record.producer.objective, 1);
  assert.equal(results[0].disposition, "current");
  rmSync(checkout, { recursive: true });
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(join(state, "memory", `catalog.sqlite${suffix}`), { force: true });
  const restarted = new LocalRepositoryMemory(state, "fixture/memory");
  assert.equal(restarted.rebuild().records, 5);
  assert.equal(restarted.catalogStatus, "ready");
  assert.equal(
    restarted.read({ access, id: second.id, applicability }).content[0].text,
    source.toString("utf8"),
  );
  writeFileSync(
    join(state, "content", sourceRef.digest.slice(0, 2), sourceRef.digest),
    "corrupt API reference",
  );
  assert.equal(
    restarted.read({ access, id: second.id, applicability }).disposition,
    "unavailable",
  );
  chmodSync(join(state, "memory", "catalog.sqlite"), 0o644);
  assert.throws(
    () => restarted.search({ access, query: "orchard", limit: 1 }),
    /owned private file/,
  );
});
