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
import {
  LocalRepositoryMemory,
  retainPlanningSourceMemory,
} from "../dist/repository-memory.js";
import { createPlanningContextResolver } from "../dist/compiler/context-runtime.js";
import { initializeContextLookup } from "../dist/compiler/context.js";
import { resolveAutonomy } from "../dist/repair-policy.js";
import { parseFactoryState } from "../dist/state.js";
import { saveState } from "../dist/state-store.js";
import {
  authenticateWorkRouting,
  assertWorkRoutingState,
  settleWorkRouting,
} from "../dist/runner/routing.js";
import { objectiveReviewEvidence } from "../dist/result-evidence.js";
import { objectiveCandidate } from "../dist/qa.js";
import { stateRoot } from "../dist/config.js";
import {
  authenticateDiscoveryOutput,
  discoverRepository,
} from "../dist/discovery.js";
import { selectedDiscoveryInputs } from "../dist/runner/discovery.js";
import { linearDeliveryUnits } from "../dist/delivery/plan.js";
import { materializeGraphExpansion } from "../dist/graph-expansion.js";
import { graphDigest } from "../dist/graph-amendments.js";
import {
  authenticateAdaptiveContextPacket,
  buildAdaptiveContext,
} from "../dist/adaptive-context.js";
import {
  pendingItemBlocker,
  rankPending,
  readyItems,
  schedulingObservations,
  validateAndOrderGraph,
} from "../dist/scheduler.js";
import {
  aggregateAcceptance,
  assertCompletedCoverage,
  assertExpansionCoverage,
  coverageObligations,
} from "../dist/qa.js";

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

test("selector-bound discovery retains exact bytes, distinguishes incomplete output, and transfers declared fields without delivery", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-discovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout");
  mkdirSync(join(checkout, "src"), { recursive: true });
  const git = (...args) =>
    execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  const bytes = Buffer.from("export const observed = 7;\n");
  writeFileSync(join(checkout, "src", "api.ts"), bytes);
  writeFileSync(
    join(checkout, "src", "helper.ts"),
    "export const helper = 8;\n",
  );
  mkdirSync(join(checkout, "src", "ui"));
  writeFileSync(
    join(checkout, "src", "ui", "view.ts"),
    "export const view = 9;\n",
  );
  writeFileSync(join(checkout, "private.txt"), "Outside selector\n");
  writeFileSync(join(checkout, "notes.txt"), "Shared migration notes\n");
  git("add", ".");
  git("commit", "-m", "Discovery source");
  const baseSha = git("rev-parse", "HEAD");
  const refsBefore = git("show-ref");
  const store = new LocalContentStore(join(root, "content"));
  const specification = {
    mode: "inventory",
    selectors: ["src/"],
    schema: "factory.repository-inventory/v1",
    role: "implementation-inventory",
    completeness: "complete",
    allowance: { maxEntries: 4, maxBytes: 1024, maxAttempts: 1 },
  };
  const producer = {
    objective: 12,
    runId: "inventory-run",
    itemId: "inventory",
    attemptId: "attempt-1",
  };
  const manifest = await discoverRepository({
    checkout,
    baseSha,
    specification,
    producer,
    store,
  });
  const body = await authenticateDiscoveryOutput({
    checkout,
    specification,
    manifest,
    store,
  });
  assert.equal(manifest.status, "complete");
  assert.deepEqual(
    body.entries.map((entry) => entry.path),
    ["src/api.ts", "src/helper.ts", "src/ui/view.ts"],
  );
  assert.equal(
    body.entries[0].content.digest,
    createHash("sha256").update(bytes).digest("hex"),
  );
  // Authentication and transfer use retained immutable Git bytes, even after the working copy changes.
  writeFileSync(join(checkout, "src", "api.ts"), "Changed working copy\n");
  const inventory = {
    id: "inventory",
    kind: "discovery",
    dependencies: [],
    discovery: specification,
  };
  const consumer = {
    id: "consumer",
    dependencies: ["inventory"],
    discoveryInputs: [
      {
        producerItemId: "inventory",
        role: specification.role,
        fields: ["path", "contentRef"],
      },
    ],
  };
  const state = {
    graph: { items: [inventory, consumer] },
    work: {
      inventory: { status: "done", discoveryOutput: manifest },
      consumer: { status: "pending" },
    },
  };
  const selected = await selectedDiscoveryInputs({
    state,
    item: consumer,
    checkout,
    store,
  });
  assert.deepEqual(selected[0].fields, ["path", "contentRef"]);
  assert.deepEqual(Object.keys(selected[0].entries[0]), [
    "path",
    "contentRef",
    "contentBody",
  ]);
  assert.deepEqual(
    Buffer.from(selected[0].entries[0].contentBody.bytes, "base64"),
    bytes,
  );
  assert.equal(selected[0].source.commitSha, baseSha);
  assert.deepEqual(
    linearDeliveryUnits(state.graph).map((unit) =>
      unit.items.map((item) => item.id),
    ),
    [["inventory"], ["consumer"]],
  );
  // The reviewed graph retains its original integration proof while a complete
  // real inventory materializes related files into bounded, literal batches.
  const criterion =
    "The migration preserves behavior for all affected source modules.";
  const common = {
    title: "Migrate observed modules",
    goal: criterion,
    acceptance: [criterion],
    nonGoals: ["No work outside the approved selectors"],
    citations: [{ path: "OBJECTIVE" }],
    dependencies: [],
    ownedPaths: [],
    validation: [],
    brief: "Apply the approved migration while retaining module behavior.",
  };
  const envelope = {
    schemaVersion: 1,
    id: "migrate-modules",
    input: {
      producerItemId: inventory.id,
      role: specification.role,
      schema: specification.schema,
    },
    selectors: specification.selectors,
    workShape: "migration",
    selection: { kind: "all-regular-files" },
    batching: { maxFilesPerChild: 2 },
    limits: { maxChildren: 2, maxIterations: 1 },
    resources: [],
    eligibleProfileIds: [],
    dependencies: [],
    integrationBarrierItemIds: ["join", "integration"],
    empty: "settle-without-children",
    template: {
      ...common,
      id: "migration-template",
      ownedPaths: specification.selectors,
    },
  };
  const graph = {
    objective: producer.objective,
    baseSha,
    expansions: [envelope],
    items: [
      { ...common, ...inventory },
      { ...common, id: "independent", ownedPaths: ["private.txt"] },
      {
        ...common,
        id: "join",
        ownedPaths: ["notes.txt"],
        dependencies: ["independent"],
      },
      {
        ...common,
        id: "integration",
        kind: "qa",
        dependencies: [inventory.id, "join"],
      },
      {
        ...common,
        id: "summary",
        kind: "aggregate",
        dependencies: ["integration"],
        children: ["integration"],
        acceptance: aggregateAcceptance({ id: "summary" }),
      },
    ],
    coverage: [
      {
        ...coverageObligations(criterion, [criterion])[0],
        itemId: "integration",
        proof: { kind: "integrated-semantic", acceptanceIndex: 0 },
        environment: {
          kind: "local",
          readiness: "available",
          probe: "",
          preparedBy: "",
        },
      },
    ],
  };
  validateAndOrderGraph(
    graph,
    producer.objective,
    baseSha,
    new Set(["OBJECTIVE"]),
  );
  const waiting = Object.fromEntries(
    graph.items.map((item) => [
      item.id,
      { status: item.id === inventory.id ? "done" : "pending" },
    ]),
  );
  assert.deepEqual(
    readyItems(graph, waiting, new Set(), 4).map((item) => item.id),
    ["independent"],
  );
  waiting.independent.status = "done";
  assert.deepEqual(readyItems(graph, waiting, new Set(), 4), []);
  assert.equal(
    linearDeliveryUnits(graph).find((unit) =>
      unit.items.some((item) => item.id === "join"),
    ).items.length,
    1,
  );
  waiting.join.status = "done";
  waiting.integration.status = "done";
  assert.deepEqual(readyItems(graph, waiting, new Set(), 4), []);
  waiting.join.status = "pending";
  waiting.integration.status = "pending";
  const materialized = materializeGraphExpansion({
    graph,
    envelopeId: envelope.id,
    manifest,
    body,
    runId: producer.runId,
    iteration: 1,
  });
  const children = materialized.childIds.map((id) =>
    materialized.graph.items.find((item) => item.id === id),
  );
  const scheduled = structuredClone(materialized.graph);
  const schedulingWork = {
    ...waiting,
    ...Object.fromEntries(
      children.map((item) => [item.id, { status: "pending" }]),
    ),
  };
  const unknownTiming = schedulingObservations(scheduled, schedulingWork);
  assert.equal(
    unknownTiming.get(children[0].id).rankingBasis,
    "remaining-stages",
  );
  assert.equal(unknownTiming.get(children[0].id).estimatedCriticalPathMs, null);
  assert.equal(unknownTiming.get(children[0].id).queueMs, null);
  for (const item of scheduled.items)
    item.scheduling = {
      estimatedDurationMs: item.id === children[0].id ? 20 : 10,
      reason: "The first literal batch contains two modules rather than one.",
    };
  const ranked = rankPending(scheduled, schedulingWork);
  assert.ok(
    ranked.indexOf(scheduled.items.find((item) => item.id === "integration")) <
      ranked.indexOf(
        scheduled.items.find((item) => item.id === children[0].id),
      ),
  );
  assert.deepEqual(
    ranked
      .filter((item) => materialized.childIds.includes(item.id))
      .map((item) => item.id),
    materialized.childIds,
  );
  assert.equal(
    schedulingObservations(scheduled, schedulingWork).get(children[0].id)
      .rankingBasis,
    "declared-duration",
  );
  const scheduledChildren = scheduled.items.filter((item) =>
    materialized.childIds.includes(item.id),
  );
  for (const item of scheduledChildren) item.resources = ["migration-check"];
  assert.equal(
    pendingItemBlocker(
      scheduled,
      schedulingWork,
      scheduledChildren[1],
      new Set([scheduledChildren[0].id]),
      new Set([envelope.id]),
    ).kind,
    "resource",
  );
  assert.deepEqual(
    children.map((item) => item.ownedPaths),
    [["src/api.ts", "src/helper.ts"], ["src/ui/view.ts"]],
  );
  assert.equal(
    new Set(children.flatMap((item) => item.ownedPaths)).size,
    body.entries.length,
  );
  assertExpansionCoverage(graph, materialized.graph);
  assert.deepEqual(
    materialized.graph.items.find((item) => item.id === "integration")
      .dependencies,
    [inventory.id, "join", ...materialized.childIds],
  );
  assert.deepEqual(
    materialized.graph.items.find((item) => item.id === "join").dependencies,
    ["independent", inventory.id, ...materialized.childIds],
  );
  for (const child of children) {
    assert.deepEqual(child.dependencies, [inventory.id]);
    assert.deepEqual(child.discoveryInputs[0].fields, [
      "path",
      "mode",
      "blobSha",
      "contentRef",
    ]);
    waiting[child.id] = { status: "done" };
  }
  assert.deepEqual(readyItems(materialized.graph, waiting, new Set(), 4), []);
  assert.deepEqual(
    readyItems(
      materialized.graph,
      waiting,
      new Set(),
      4,
      new Set([envelope.id]),
    ).map((item) => item.id),
    ["join"],
  );
  waiting.join.status = "done";
  assert.deepEqual(
    readyItems(
      materialized.graph,
      waiting,
      new Set(),
      4,
      new Set([envelope.id]),
    ).map((item) => item.id),
    ["integration"],
  );
  assert.equal(
    linearDeliveryUnits(materialized.graph).find((unit) =>
      unit.items.some((item) => item.id === "integration"),
    ).items.length,
    1,
  );
  const packetRef = store.putBytes(
    Buffer.from(JSON.stringify(materialized.inputPacket)),
    { mediaType: "application/json" },
  );
  // Expansion receipt scope reduces each worker's input to its complete batch,
  // while the original ordinary consumer still receives the full inventory.
  const expandedState = {
    repository: "fixture/adaptive-discovery",
    objective: producer.objective,
    runId: producer.runId,
    configDigest: "a".repeat(64),
    baseSha,
    planGraphDigest: graphDigest(graph),
    graph: materialized.graph,
    work: { ...state.work, ...waiting },
    expansionHistory: [
      {
        schemaVersion: 1,
        id: `${envelope.id}-${materialized.digest}`,
        envelopeId: envelope.id,
        parentGraphDigest: graphDigest(graph),
        graphDigest: graphDigest(materialized.graph),
        envelopeDigest: materialized.envelopeDigest,
        materializationDigest: materialized.digest,
        inputPacketRef: packetRef,
        childIds: materialized.childIds,
        acceptedAt: new Date().toISOString(),
      },
    ],
  };
  expandedState.work.inventory = state.work.inventory;
  for (const child of children) {
    const input = await selectedDiscoveryInputs({
      state: expandedState,
      item: child,
      checkout,
      store,
    });
    assert.deepEqual(
      input[0].entries.map((entry) => entry.path),
      child.ownedPaths,
    );
    assert.deepEqual(input[0].selectionScope.paths, child.ownedPaths);
    assert.equal(input[0].selectionScope.complete, true);
    for (const entry of input[0].entries)
      assert.deepEqual(
        Buffer.from(entry.contentBody.bytes, "base64"),
        execFileSync("git", [
          "-C",
          checkout,
          "show",
          `${baseSha}:${entry.path}`,
        ]),
      );
  }
  const sources = ["src/api.ts", "notes.txt"].map((path) => ({
    path,
    content: execFileSync(
      "git",
      ["-C", checkout, "show", `${baseSha}:${path}`],
      { encoding: "utf8" },
    ),
  }));
  retainPlanningSourceMemory({
    repository: expandedState.repository,
    objective: producer.objective,
    runId: producer.runId,
    baseSha,
    treeSha: git("rev-parse", "HEAD^{tree}"),
    configDigest: expandedState.configDigest,
    sources,
  });
  expandedState.planningRecovery = {
    contextLookup: {
      packet: {
        schemaVersion: 1,
        binding: "b".repeat(64),
        bounds: {
          maxRounds: 1,
          maxRequestsPerRound: 1,
          maxResults: 8,
          maxBytes: 1,
          maxElapsedMs: 30000,
          maxProviderCalls: 1,
        },
        catalog: ["repository", "memory"].map((id) => ({
          id,
          selectors: ["src/", "notes.txt"],
          operations: ["read"],
          freshness: "Pinned source",
          completeness: "complete",
        })),
        automatic: [],
        batches: [],
      },
    },
  };
  const selectedBatch = await selectedDiscoveryInputs({
    state: expandedState,
    item: children[0],
    checkout,
    store,
  });
  const interfaceRef = store.putBytes(Buffer.from(sources[1].content), {
    mediaType: "text/plain",
  });
  const required = {
    discoveryInputs: selectedBatch,
    sharedInterface: { path: "notes.txt", content: sources[1].content },
  };
  const contextInput = {
    state: expandedState,
    role: "dispatch",
    item: children[0],
    baseSha,
    checkout,
    store,
    sources,
    required,
    requiredSelections: [
      {
        id: "migration-inventory",
        kind: "discovery",
        disposition: "current",
        required: true,
        refs: body.entries
          .filter((entry) => children[0].ownedPaths.includes(entry.path))
          .map((entry) => entry.content),
      },
      {
        id: "migration-interface",
        kind: "interface",
        disposition: "current",
        required: true,
        refs: [interfaceRef],
      },
    ],
    save: () => undefined,
  };
  const context = await buildAdaptiveContext(contextInput);
  assert.deepEqual(context.payload.required, required);
  assert.ok(Buffer.byteLength(JSON.stringify(required)) > 1);
  assert.equal(
    context.packet.selections.filter(
      (selection) => selection.kind === "supplied",
    ).length,
    sources.length,
  );
  // Already supplied source bodies are excluded before optional byte accounting.
  assert.deepEqual(context.payload.memory, []);
  assert.deepEqual(context.packet.unavailable, []);
  const restartedStore = new LocalContentStore(join(root, "content"));
  const restartedContext = await buildAdaptiveContext({
    ...contextInput,
    state: JSON.parse(JSON.stringify(expandedState)),
    store: restartedStore,
    save: () => assert.fail("Exact retained context should be reused"),
  });
  assert.equal(restartedContext.packet.id, context.packet.id);
  assert.deepEqual(
    await authenticateAdaptiveContextPacket(
      restartedStore,
      restartedContext.packet,
    ),
    context.payload,
  );
  const contextPath = join(
    root,
    "content",
    context.packet.contentRef.digest.slice(0, 2),
    context.packet.contentRef.digest,
  );
  const contextBytes = readFileSync(contextPath);
  rmSync(contextPath);
  await assert.rejects(
    authenticateAdaptiveContextPacket(restartedStore, context.packet),
    /ENOENT|unavailable|missing/,
  );
  writeFileSync(contextPath, "corrupt role context");
  await assert.rejects(
    authenticateAdaptiveContextPacket(restartedStore, context.packet),
    /digest verification/,
  );
  writeFileSync(contextPath, contextBytes);
  // Two attributable observations retain one actual Git source body. Optional
  // accounting includes their summaries, provenance and selection descriptors.
  const memoryStore = new LocalContentStore(
    join(stateRoot(expandedState.repository), "content"),
  );
  const memory = new LocalRepositoryMemory(
    stateRoot(expandedState.repository),
    expandedState.repository,
    memoryStore,
  );
  const observedRef = memoryStore.putBytes(Buffer.from(sources[1].content), {
    mediaType: "text/plain",
  });
  const observations = ["first-source-read", "second-source-read"].map(
    (identity) =>
      memory.retain({
        schemaVersion: 1,
        repository: expandedState.repository,
        visibility: "repository",
        kind: "observation",
        producer: {
          objective: producer.objective,
          runId: producer.runId,
          identity,
          itemId: "join",
          status: "observed",
        },
        createdAt: new Date().toISOString(),
        authority: "observation",
        summary: "Shared migration notes observed from the pinned source.",
        bodies: [
          {
            role: "migration-notes",
            ref: observedRef,
            availability: "retained",
          },
        ],
        sources: [
          {
            identity: "repository:notes.txt",
            path: "notes.txt",
            commitSha: baseSha,
            treeSha: git("rev-parse", "HEAD^{tree}"),
            complete: true,
            ref: observedRef,
          },
        ],
        bindings: {
          treeSha: git("rev-parse", "HEAD^{tree}"),
          environment: { configDigest: expandedState.configDigest },
        },
        validity: { state: "current", conditions: [] },
        supersedes: [],
      }),
  );
  assert.notEqual(observations[0].id, observations[1].id);
  const advisoryState = structuredClone(expandedState);
  const allowance = 65536;
  advisoryState.planningRecovery.contextLookup.packet.bounds.maxBytes =
    allowance;
  const advisoryInput = {
    ...contextInput,
    state: advisoryState,
    role: "diagnosis",
    item: materialized.graph.items.find((item) => item.id === "join"),
    sources: [],
    required: {},
    requiredSelections: [],
  };
  const advisory = await buildAdaptiveContext(advisoryInput);
  const observationMatches = advisory.payload.memory.filter((match) =>
    observations.some((binding) => binding.id === match.binding.id),
  );
  assert.equal(observationMatches.length, 2);
  assert.ok(
    observationMatches.every((match) => match.disposition === "current"),
  );
  const observedBodies = advisory.payload.memory
    .flatMap((match) => match.content)
    .filter((body) => body.ref.digest === observedRef.digest);
  assert.deepEqual(
    observedBodies
      .filter((body) => body.text !== undefined)
      .map((body) => body.text),
    [sources[1].content],
  );
  assert.match(observationMatches[1].content[0].reuse, /^memory:/);
  const serializedCost = advisory.payload.memory.reduce(
    (total, match) =>
      total +
      Buffer.byteLength(
        JSON.stringify({
          match,
          selection: advisory.packet.selections.find(
            (selection) => selection.id === `memory:${match.binding.id}`,
          ),
        }),
      ),
    0,
  );
  assert.ok(serializedCost <= allowance);
  assert.ok(serializedCost > observedRef.bytes);
  const boundedState = structuredClone(expandedState);
  boundedState.planningRecovery.contextLookup.packet.bounds.maxBytes =
    observedRef.bytes + 1;
  const bounded = await buildAdaptiveContext({
    ...advisoryInput,
    state: boundedState,
    role: "expansion",
  });
  assert.deepEqual(bounded.payload.memory, []);
  for (const observation of observations) {
    assert.ok(
      bounded.packet.unavailable.includes(
        `Optional memory ${observation.id} deferred by serialized byte allowance`,
      ),
    );
    const selection = bounded.packet.selections.find(
      (selection) => selection.id === `memory:${observation.id}`,
    );
    assert.equal(selection.disposition, "incomplete");
    assert.deepEqual(selection.refs, []);
  }
  writeFileSync(
    join(checkout, "src", "helper.ts"),
    "Working copy changed after materialization\n",
  );
  const retainedPacket = JSON.parse(
    store.readBytes(packetRef).toString("utf8"),
  );
  const reloaded = materializeGraphExpansion({
    graph: JSON.parse(JSON.stringify(graph)),
    envelopeId: retainedPacket.envelope.id,
    manifest: retainedPacket.manifest,
    body: retainedPacket.body,
    runId: retainedPacket.runId,
    iteration: retainedPacket.iteration,
  });
  assert.deepEqual(reloaded, materialized);
  assert.throws(
    () =>
      materializeGraphExpansion({
        graph,
        envelopeId: envelope.id,
        manifest,
        body,
        runId: producer.runId,
        iteration: 1,
        immutableItemIds: ["integration"],
      }),
    /started or completed integration barrier/,
  );
  const emptySpec = { ...specification, selectors: ["missing/"] };
  const empty = await discoverRepository({
    checkout,
    baseSha,
    specification: emptySpec,
    producer,
    store,
  });
  assert.equal(empty.status, "complete");
  assert.equal(empty.selectedEntries, 0);
  assert.deepEqual(
    (
      await authenticateDiscoveryOutput({
        checkout,
        specification: emptySpec,
        manifest: empty,
        store,
      })
    ).entries,
    [],
  );
  const emptyGraph = structuredClone(graph);
  emptyGraph.items.find((item) => item.id === inventory.id).discovery =
    emptySpec;
  emptyGraph.expansions[0].selectors = emptySpec.selectors;
  emptyGraph.expansions[0].template.ownedPaths = emptySpec.selectors;
  const emptyBody = await authenticateDiscoveryOutput({
    checkout,
    specification: emptySpec,
    manifest: empty,
    store,
  });
  const emptyExpansion = materializeGraphExpansion({
    graph: emptyGraph,
    envelopeId: envelope.id,
    manifest: empty,
    body: emptyBody,
    runId: producer.runId,
    iteration: 1,
  });
  assert.deepEqual(emptyExpansion.childIds, []);
  assertExpansionCoverage(emptyGraph, emptyExpansion.graph);
  assert.deepEqual(
    readyItems(
      emptyExpansion.graph,
      waiting,
      new Set(),
      4,
      new Set([envelope.id]),
    ).map((item) => item.id),
    ["integration"],
  );
  assert.throws(
    () =>
      assertCompletedCoverage({ graph: emptyExpansion.graph, work: waiting }),
    /completed exact-tree proof/,
  );
  // Declared conditions use this exact real Git inventory and ordinary atomic state.
  // The opposite branch settles without a worker; the unconditional original proof remains pending.
  const routingConfig = {
    schemaVersion: 1,
    repository: "fixture/conditions",
    checkout,
    planning: {
      kind: "codex-sdk",
      planner: { model: "unused-local-check", reasoningEffort: "low" },
      reviewer: { model: "unused-local-check", reasoningEffort: "low" },
    },
    execution: {
      kind: "local",
      concurrency: 1,
      harness: {
        kind: "codex-sdk",
        model: "unused-local-check",
        reasoningEffort: "low",
      },
    },
    delivery: { kind: "regular" },
    policy: { network: "off", allowedSecretNames: [] },
    planningContext: {
      enabled: true,
      memory: false,
      selectors: ["src/", ...emptySpec.selectors],
      bounds: {
        maxRounds: 1,
        maxRequestsPerRound: 1,
        maxResults: 4,
        maxBytes: 2048,
        maxElapsedMs: 5000,
        maxProviderCalls: 1,
      },
    },
  };
  const lookup = await initializeContextLookup(
    createPlanningContextResolver({
      config: routingConfig,
      objective: producer.objective,
      runId: producer.runId,
      baseSha,
      sources: [],
      objectiveBody: "## Adaptive workflow\nenabled\n",
      contentStore: store,
    }),
  );
  const routeDefaults = {
    ...common,
    resources: [],
    sourceAssets: [],
    expectedOutputRoles: [],
    requiredLfsRoles: [],
    minimumAssetSets: 0,
  };
  const condition = {
    schemaVersion: 1,
    id: "empty-inventory",
    input: {
      producerItemId: inventory.id,
      role: specification.role,
      schema: specification.schema,
    },
    predicate: { kind: "inventory-empty" },
  };
  const routeGraph = {
    objective: producer.objective,
    baseSha,
    conditions: [condition],
    items: [
      { ...routeDefaults, ...inventory },
      {
        ...routeDefaults,
        id: "has-files",
        ownedPaths: ["src/"],
        dependencies: [inventory.id],
        condition: { conditionId: condition.id, when: false },
      },
      {
        ...routeDefaults,
        id: "no-files",
        ownedPaths: ["notes.txt"],
        dependencies: [inventory.id],
        condition: { conditionId: condition.id, when: true },
      },
      {
        ...routeDefaults,
        id: "integration",
        kind: "qa",
        dependencies: [inventory.id, "has-files", "no-files"],
      },
    ],
    coverage: structuredClone(graph.coverage),
  };
  validateAndOrderGraph(
    routeGraph,
    producer.objective,
    baseSha,
    new Set(["OBJECTIVE"]),
  );
  const routeState = {
    schemaVersion: 13,
    repository: routingConfig.repository,
    objective: producer.objective,
    runId: producer.runId,
    configDigest: "a".repeat(64),
    baseSha,
    graph: routeGraph,
    planGraphDigest: graphDigest(routeGraph),
    capacity: { concurrency: 1 },
    autonomy: resolveAutonomy(),
    coordinator: {
      mode: "running",
      phase: "execution",
      phaseStartedAt: new Date().toISOString(),
    },
    planningRecovery: { phase: "ready", history: [], contextLookup: lookup },
    issueByItemId: {
      inventory: 41,
      "has-files": 42,
      "no-files": 43,
      integration: 44,
    },
    work: {
      inventory: {
        status: "done",
        attempt: producer.attemptId,
        baseSha,
        discoveryOutput: manifest,
      },
      "has-files": { status: "pending" },
      "no-files": { status: "pending" },
      integration: { status: "pending" },
    },
  };
  const snapshot = join(root, "routing-state.json");
  const routeArgs = {
    config: routingConfig,
    state: routeState,
    store,
    save: () => saveState(snapshot, routeState),
    cancelled: () => false,
  };
  await settleWorkRouting(routeArgs);
  assert.equal(routeState.work["has-files"].routing.disposition, "selected");
  assert.equal(routeState.work["no-files"].status, "skipped");
  assert.equal(routeState.work["no-files"].attempt, undefined);
  assert.equal(routeState.work["no-files"].validation, undefined);
  assert.equal(routeState.work["no-files"].pullRequest, undefined);
  assert.deepEqual(
    readyItems(routeGraph, routeState.work, new Set(), 2).map(
      (item) => item.id,
    ),
    ["has-files"],
  );
  assert.throws(
    () => assertCompletedCoverage(routeState),
    /completed exact-tree proof/,
  );
  assert.deepEqual(routeState.graph.coverage, graph.coverage);
  const restored = parseFactoryState(
    JSON.parse(readFileSync(snapshot, "utf8")),
    routingConfig.repository,
    producer.objective,
  );
  await authenticateWorkRouting({
    config: routingConfig,
    state: restored,
    store: new LocalContentStore(join(root, "content")),
  });
  await settleWorkRouting({
    ...routeArgs,
    state: restored,
    save: () =>
      assert.fail("An unchanged routing receipt must not be rewritten"),
  });
  const changedBinding = structuredClone(restored);
  changedBinding.graph.items.find(
    (item) => item.id === "no-files",
  ).condition.when = false;
  assert.throws(
    () => assertWorkRoutingState(changedBinding),
    /admitted branch binding/,
  );
  const fabricatedAttempt = structuredClone(restored);
  fabricatedAttempt.work["no-files"].attempt = "fabricated";
  assert.throws(
    () => assertWorkRoutingState(fabricatedAttempt),
    /owned attempt/,
  );
  const receipt = routeState.conditionFacts[condition.id];
  const receiptPath = join(
    root,
    "content",
    receipt.inputPacketRef.digest.slice(0, 2),
    receipt.inputPacketRef.digest,
  );
  const receiptBytes = readFileSync(receiptPath);
  rmSync(receiptPath);
  await assert.rejects(
    authenticateWorkRouting({ config: routingConfig, state: restored, store }),
    /Retained condition facts are unavailable/,
  );
  writeFileSync(receiptPath, receiptBytes);
  // A genuinely empty complete inventory skips the sole implementation branch; QA still owes its proof on the pinned baseline.
  const emptyRoute = structuredClone(routeState);
  delete emptyRoute.conditionFacts;
  emptyRoute.graph.items = emptyRoute.graph.items.filter(
    (item) => item.id !== "no-files",
  );
  emptyRoute.graph.items.find((item) => item.id === "inventory").discovery =
    emptySpec;
  emptyRoute.graph.items.find(
    (item) => item.id === "integration",
  ).dependencies = [inventory.id, "has-files"];
  emptyRoute.planGraphDigest = graphDigest(emptyRoute.graph);
  delete emptyRoute.issueByItemId["no-files"];
  delete emptyRoute.work["no-files"];
  emptyRoute.work["has-files"] = { status: "pending" };
  emptyRoute.work.inventory.discoveryOutput = empty;
  await settleWorkRouting({
    ...routeArgs,
    state: emptyRoute,
    save: () => saveState(snapshot, emptyRoute),
  });
  assert.equal(emptyRoute.work["has-files"].status, "skipped");
  assert.deepEqual(objectiveCandidate(emptyRoute), {
    basis: "pinned-baseline",
    commitSha: baseSha,
  });
  assert.deepEqual(
    readyItems(emptyRoute.graph, emptyRoute.work, new Set(), 2).map(
      (item) => item.id,
    ),
    ["integration"],
  );
  assert.throws(
    () => assertCompletedCoverage(emptyRoute),
    /completed exact-tree proof/,
  );
  // Even after local closure checkpoints settle, observations and skips supply no QA acceptance.
  const reviewReadiness = structuredClone(emptyRoute);
  reviewReadiness.work.inventory.githubClosure = "complete";
  reviewReadiness.work["has-files"].githubClosure = "complete";
  parseFactoryState(
    reviewReadiness,
    routingConfig.repository,
    producer.objective,
  );
  assert.throws(
    () =>
      objectiveReviewEvidence({
        state: reviewReadiness,
        checkout,
        candidateCommitSha: baseSha,
        candidateTreeSha: git("rev-parse", `${baseSha}^{tree}`),
      }),
    /Work Item integration lacks complete final-review identity/,
  );
  // Missing producer output never routes as false, and a held operator decision keeps its owner pending.
  const unknownRoute = structuredClone(routeState);
  delete unknownRoute.conditionFacts;
  unknownRoute.work.inventory = { status: "pending" };
  unknownRoute.work["has-files"] = { status: "pending" };
  unknownRoute.work["no-files"] = { status: "pending" };
  await settleWorkRouting({
    ...routeArgs,
    state: unknownRoute,
    save: () => saveState(snapshot, unknownRoute),
  });
  assert.equal(unknownRoute.work["has-files"].routing.disposition, "held");
  assert.equal(unknownRoute.work["no-files"].routing.disposition, "held");
  assert.deepEqual(
    readyItems(unknownRoute.graph, unknownRoute.work, new Set(), 2).map(
      (item) => item.id,
    ),
    ["inventory"],
  );
  const operatorRoute = structuredClone(routeState);
  delete operatorRoute.conditionFacts;
  operatorRoute.work["has-files"] = { status: "pending" };
  operatorRoute.work["no-files"] = {
    status: "pending",
    wait: {
      kind: "decision",
      detail: "Retained operator choice",
      step: "item/no-files/execute",
    },
  };
  await settleWorkRouting({
    ...routeArgs,
    state: operatorRoute,
    save: () => saveState(snapshot, operatorRoute),
  });
  assert.equal(operatorRoute.work["no-files"].status, "pending");
  assert.equal(operatorRoute.work["no-files"].routing, undefined);
  assert.equal(
    operatorRoute.work["no-files"].wait.detail,
    "Retained operator choice",
  );
  const boundedSpec = {
    ...specification,
    allowance: { ...specification.allowance, maxBytes: 1 },
  };
  const truncated = await discoverRepository({
    checkout,
    baseSha,
    specification: boundedSpec,
    producer,
    store,
  });
  assert.equal(truncated.status, "truncated");
  assert.throws(
    () =>
      materializeGraphExpansion({
        graph,
        envelopeId: envelope.id,
        manifest: truncated,
        body,
        runId: producer.runId,
        iteration: 1,
      }),
    /complete exact producer-bound/,
  );
  await authenticateDiscoveryOutput({
    checkout,
    specification: boundedSpec,
    manifest: truncated,
    store,
  });
  state.work.inventory.discoveryOutput = truncated;
  await assert.rejects(
    selectedDiscoveryInputs({ state, item: consumer, checkout, store }),
    /incomplete/,
  );
  await assert.rejects(
    authenticateDiscoveryOutput({
      checkout,
      specification,
      manifest: {
        ...manifest,
        source: { ...manifest.source, selectors: ["private.txt"] },
      },
      store,
    }),
    /binding differs/,
  );
  assert.equal(git("rev-parse", "HEAD"), baseSha);
  assert.equal(git("show-ref"), refsBefore);
  writeFileSync(
    join(
      root,
      "content",
      body.entries[0].content.digest.slice(0, 2),
      body.entries[0].content.digest,
    ),
    "corrupt retained source",
  );
  state.work.inventory.discoveryOutput = manifest;
  await assert.rejects(
    selectedDiscoveryInputs({ state, item: consumer, checkout, store }),
    /digest verification/,
  );
});

test("memory source admission precedes same-Objective relevance and binary bodies stay exact", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-memory-admission-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout");
  mkdirSync(join(checkout, "src"), { recursive: true });
  mkdirSync(join(checkout, "secret"));
  writeFileSync(
    join(checkout, "src", "main.txt"),
    "Authorized orchard source\n",
  );
  writeFileSync(
    join(checkout, "secret", "detail.txt"),
    "Private unrelated orchard source\n",
  );
  const opaque = Buffer.from([0xff, 0x00, 0x80, 0x50]);
  writeFileSync(join(checkout, "src", "opaque.bin"), opaque);
  const git = (...args) =>
    execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  git("add", ".");
  git("commit", "-m", "Retain observed sources");
  const treeSha = git("rev-parse", "HEAD^{tree}");
  const state = join(root, "state");
  const store = new LocalContentStore(join(state, "content"));
  const memory = new LocalRepositoryMemory(state, "fixture/admission", store);
  const source = (path) => ({
    path,
    ref: store.putBytes(readFileSync(join(checkout, path)), {
      mediaType: "application/octet-stream",
    }),
  });
  const allowed = source("src/main.txt");
  const denied = source("secret/detail.txt");
  const record = (sources) => ({
    schemaVersion: 1,
    repository: "fixture/admission",
    visibility: "private",
    kind: "handoff",
    producer: {
      objective: 1,
      runId: git("rev-parse", "HEAD"),
      status: "working",
    },
    createdAt: new Date().toISOString(),
    authority: "advisory",
    summary: "Retained orchard handoff",
    bodies: sources.map(({ path, ref }) => ({
      role: `source:${path}`,
      ref,
      availability: "retained",
    })),
    sources: sources.map(({ path, ref }) => ({
      identity: `repository:${path}`,
      ref,
      complete: true,
    })),
    bindings: {
      treeSha,
      paths: sources.map(({ path, ref }) => ({ path, digest: ref.digest })),
    },
    validity: { state: "current", conditions: [] },
    supersedes: [],
  });
  const mixed = memory.retain(record([allowed, denied]));
  const permitted = memory.retain(record([allowed]));
  const lookup = {
    access: { repository: "fixture/admission", visibility: ["private"] },
    scope: { objective: 1, paths: ["src/"] },
    applicability: { treeSha, paths: { "src/main.txt": allowed.ref.digest } },
    limit: 10,
  };
  assert.deepEqual(
    memory.metadata(lookup).entries.map((entry) => entry.binding.id),
    [permitted.id],
  );
  assert.equal(memory.read({ ...lookup, id: mixed.id }), undefined);
  assert.equal(
    memory.metadata({ ...lookup, excludeIds: [permitted.id] }).entries.length,
    0,
  );
  assert.equal(
    memory.read({ ...lookup, excludeIds: [permitted.id], id: permitted.id }),
    undefined,
  );
  assert.equal(
    memory.search({ ...lookup, excludeIds: [permitted.id], query: "orchard" })
      .length,
    0,
  );
  assert.deepEqual(
    memory
      .search({ ...lookup, query: "orchard" })
      .map((result) => result.binding.id),
    [permitted.id],
  );
  assert.equal(
    memory.read({
      ...lookup,
      scope: { objective: 1, paths: [] },
      id: permitted.id,
    }),
    undefined,
  );
  assert.equal(
    memory.read({
      ...lookup,
      scope: { objective: 1, paths: ["src"] },
      id: permitted.id,
    }),
    undefined,
  );
  assert.equal(
    memory.read({
      ...lookup,
      scope: { objective: 1, paths: ["src/main.txt"] },
      id: permitted.id,
    }).content[0].text,
    "Authorized orchard source\n",
  );
  const opaqueSource = source("src/opaque.bin");
  const binary = memory.retain(record([opaqueSource]));
  const result = memory.read({
    ...lookup,
    id: binary.id,
    applicability: {
      treeSha,
      paths: { "src/opaque.bin": opaqueSource.ref.digest },
    },
  });
  assert.equal(result.disposition, "unavailable");
  assert.equal(result.content.length, 0);
  assert.match(
    result.gaps.join("\n"),
    /exact binary bytes retained; text lookup unavailable/,
  );
  assert.deepEqual(store.readBytes(result.record.bodies[0].ref), opaque);
  const supplied = readFileSync(join(checkout, "src", "main.txt"), "utf8");
  const baseSha = git("rev-parse", "HEAD");
  rmSync(checkout, { recursive: true });
  const references = retainPlanningSourceMemory({
    repository: "fixture/supplied-reference",
    objective: 1,
    runId: baseSha,
    baseSha,
    treeSha,
    configDigest: "a".repeat(64),
    sources: [
      { path: "OBJECTIVE", content: "Omit the Objective body" },
      { path: "src/main.txt", content: supplied },
    ],
  });
  assert.equal(references.length, 1);
  const referenceMemory = new LocalRepositoryMemory(
    stateRoot("fixture/supplied-reference"),
    "fixture/supplied-reference",
  );
  const reference = referenceMemory.read({
    access: {
      repository: "fixture/supplied-reference",
      visibility: ["private"],
    },
    scope: { objective: 1, paths: ["src/main.txt"] },
    id: references[0].id,
    applicability: {
      treeSha,
      paths: { "src/main.txt": allowed.ref.digest },
      environment: { configDigest: "a".repeat(64) },
      sources: { "src/main.txt#": { version: allowed.ref.digest } },
    },
  });
  assert.equal(reference.disposition, "current");
  assert.equal(reference.content[0].text, supplied);
  assert.equal(reference.record.sources[0].commitSha, baseSha);
  assert.equal(reference.record.sources[0].treeSha, treeSha);
  const referenceLookup = {
    access: {
      repository: "fixture/supplied-reference",
      visibility: ["private"],
    },
    scope: { objective: 1, paths: ["src/main.txt"] },
    suppliedSources: [{ path: "src/main.txt", digest: allowed.ref.digest }],
    limit: 0,
  };
  assert.equal(referenceMemory.metadata(referenceLookup).complete, true);
  assert.equal(
    referenceMemory.read({ ...referenceLookup, id: references[0].id }),
    undefined,
  );
  assert.equal(
    referenceMemory.search({ ...referenceLookup, limit: 10, query: "orchard" })
      .length,
    0,
  );
  assert.equal(
    referenceMemory.metadata({
      ...referenceLookup,
      limit: 10,
      suppliedSources: [
        {
          path: "src/main.txt",
          heading: "Other selection",
          digest: allowed.ref.digest,
        },
      ],
    }).entries.length,
    1,
  );
  assert.equal(
    referenceMemory.metadata({
      ...referenceLookup,
      limit: 10,
      suppliedSources: [{ path: "src/main.txt", digest: "b".repeat(64) }],
    }).entries.length,
    1,
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(
    retainPlanningSourceMemory({
      repository: "fixture/supplied-reference",
      objective: 1,
      runId: baseSha,
      baseSha,
      treeSha,
      configDigest: "a".repeat(64),
      sources: [{ path: "src/main.txt", content: supplied }],
    }),
    references,
  );
  assert.equal(
    referenceMemory.read({
      ...referenceLookup,
      suppliedSources: [],
      id: references[0].id,
    }).record.sources[0].retrievedAt,
    reference.record.sources[0].retrievedAt,
  );
});
