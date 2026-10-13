import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, readlinkSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  factoryAuthorityDigest,
  factoryConfigDigest,
  stateRoot,
  validateConfig,
} from "../dist/config.js";
import { LocalContentStore } from "../dist/content/local.js";
import { diagnosticPath } from "../dist/diagnostics.js";
import { RegularDelivery } from "../dist/delivery/regular.js";
import { CodexPlanningModel } from "../dist/compiler/model.js";
import { sealFinalAcceptance } from "../dist/completion.js";
import { LocalExecutionDriver, CodexHarness } from "../dist/execution/local.js";
import { graphDigest } from "../dist/graph-amendments.js";
import {
  enqueueIntake,
  intakeControl,
  runIntake,
  watchIntake,
} from "../dist/intake.js";
import { LocalRepositoryMemory } from "../dist/repository-memory.js";
import { resolveAutonomy } from "../dist/repair-policy.js";
import { requestControl } from "../dist/coordinator-control.js";
import { validateWorkItem } from "../dist/validation.js";
import {
  createProjectQueuePlannedEffect,
  resolveProjectQueuePlannedEffect,
} from "../dist/github-project-queue.js";
import { UPDATE } from "../dist/github-project-queue-wire.js";
import {
  ownIdentity,
  subprocessAsync,
  withCheckpointPublication,
  withProcessCancellation,
  withRegistryFiles,
} from "../dist/process.js";
import {
  admitQueueCommand,
  assertQueueCommandHistory,
  assertProjectQueueClaimAdmission,
  assertQueueOperationReferenceBodies,
  authenticateQueueOwnerReferences,
  completeQueueCommand,
  createQueueCommand,
  createQueueOperation,
  nextProjectQueueOrder,
  parseQueueRecord,
  performQueueCommandEffect,
  readQueueHistory,
  queueObservationTargets,
  verifyQueueObservation,
  retainedQueueEntry,
  retireUnknownProjectAdmission,
  settleFailedProjectQueueReservation,
} from "../dist/project-queue-state.js";
import {
  awaitCheckpointAdmission,
  gitPersistenceStatus,
  markCheckpointDirty,
  readVerifiedRecoveryCheckpoint,
  withRecoveryCheckpointControllerVerification,
  withRecoveryCheckpointScope,
} from "../dist/recovery-checkpoint.js";
import { buildRecoveryCheckpointClosure } from "../dist/recovery-checkpoint-closure.js";
import {
  projectQueueReadOnGitHub,
  withProjectQueueObservationOnGitHub,
} from "../dist/github-project-queue.js";
import {
  FIELD_BINDING,
  ITEMS,
  INSPECT,
} from "../dist/github-project-queue-wire.js";
import { controlObjective } from "../dist/runner.js";
import {
  acquireInstallationLock,
  acquireObjectiveLock,
  installationLockPath,
  objectiveLockPath,
  readControllerOwner,
  readState,
  releaseControllerLock,
  statePath,
  saveState,
} from "../dist/state-store.js";

const processUrl = new URL("../dist/process.js", import.meta.url).href;

test("a terminal background watcher holds checkpoint failure while real control and explicit recovery remain usable", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "factory-watcher-checkpoint-"),
  );
  const repository = `fixture/watcher-${randomUUID()}`;
  t.after(() => rm(directory, { recursive: true, force: true }));
  t.after(() => rm(stateRoot(repository), { recursive: true, force: true }));
  const checkout = join(directory, "target"),
    remote = join(directory, "archive.git");
  await mkdir(checkout);
  const git = (...args) =>
    execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
  git("init", "-b", "main");
  git("remote", "add", "origin", `https://github.com/${repository}.git`);
  await writeFile(join(checkout, "README.md"), "# Unchanged public fixture\n");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-m",
    "baseline",
  );
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  const selection = { model: "unused-local-check", reasoningEffort: "low" };
  const config = {
    schemaVersion: 1,
    repository,
    checkout,
    planning: { kind: "codex-sdk", planner: selection, reviewer: selection },
    execution: {
      kind: "local",
      concurrency: 1,
      harness: { kind: "codex-sdk", ...selection },
    },
    delivery: { kind: "regular" },
    policy: { network: "off", allowedSecretNames: [] },
    queue: {
      pollSeconds: 1,
      project: {
        repository,
        projectId: "PVT_fixture",
        metadataFieldId: "PVTF_metadata",
        orderFieldId: "PVTF_order",
        controlItemId: "PVTI_control",
        factoryManagedFields: true,
      },
    },
    gitPersistence: {
      remote,
      ref: "refs/heads/factory-history",
      visibility: "private",
      scope: "private-history",
      maxBytes: 16 * 1024 * 1024,
      maxFiles: 4096,
      timeoutMs: 1000,
      coalesceMs: 0,
    },
  };
  validateConfig(config);
  const binding = config.queue.project;
  const body =
    "## Outcome\nVerify the unchanged fixture.\n\n## Acceptance\n- git diff is clean.\n\n## Validation\ngit diff --exit-code\n";
  let controlMetadata = null;
  const card = {
    itemId: "PVTI_issue",
    issueNodeId: "I_fixture",
    objective: 1,
    repository,
    title: "Verify fixture",
    body,
    state: "open",
    archived: false,
    metadata: null,
    order: null,
  };
  let reads = 0,
    writes = 0;
  let indexReads = 0;
  let membershipVisible = true;
  let changeControlDuringRead = false;
  const fields = (metadata, order) => [
    ...(metadata === null
      ? []
      : [
          {
            __typename: "ProjectV2ItemFieldTextValue",
            text: metadata,
            field: { id: binding.metadataFieldId },
          },
        ]),
    ...(order === null
      ? []
      : [
          {
            __typename: "ProjectV2ItemFieldNumberValue",
            number: order,
            field: { id: binding.orderFieldId },
          },
        ]),
  ];
  const wireCard = (control = false) => ({
    __typename: "ProjectV2Item",
    id: control ? binding.controlItemId : card.itemId,
    isArchived: control ? false : card.archived,
    project: { id: binding.projectId },
    content: control
      ? { __typename: "DraftIssue", id: "D_control" }
      : {
          __typename: "Issue",
          id: card.issueNodeId,
          number: card.objective,
          repository: { nameWithOwner: repository },
        },
    fieldValues: {
      nodes: fields(
        control ? controlMetadata : card.metadata,
        control ? null : card.order,
      ),
      pageInfo: { hasNextPage: false, endCursor: null },
    },
    metadataValue:
      (control ? controlMetadata : card.metadata) === null
        ? null
        : fields(control ? controlMetadata : card.metadata, null)[0],
    orderValue:
      control || card.order === null ? null : fields(null, card.order)[0],
  });
  const wireAccess = () => ({
    viewer: { databaseId: 1 },
    project: {
      __typename: "ProjectV2",
      id: binding.projectId,
      closed: false,
      viewerCanUpdate: true,
      owner: { __typename: "Organization", login: "fixture" },
      fields: {
        nodes: [
          {
            __typename: "ProjectV2Field",
            id: binding.metadataFieldId,
            name: "Factory Admission",
          },
          {
            __typename: "ProjectV2Field",
            id: binding.orderFieldId,
            name: "Factory Order",
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
    metadata: {
      __typename: "ProjectV2Field",
      id: binding.metadataFieldId,
      name: "Factory Admission",
      dataType: "TEXT",
      project: { id: binding.projectId },
    },
    order: {
      __typename: "ProjectV2Field",
      id: binding.orderFieldId,
      name: "Factory Order",
      dataType: "NUMBER",
      project: { id: binding.projectId },
    },
  });
  // Literal current wire shapes reproduce the observed index/membership disagreement.
  // The actual decoder, receipt production, Git archive and watcher stay real.
  const graphql = async (query, variables, readOnly) => {
    assert.equal(readOnly, true);
    if (query === FIELD_BINDING) return wireAccess();
    if (query === ITEMS) {
      indexReads++;
      return {
        node: {
          __typename: "ProjectV2",
          id: binding.projectId,
          items: {
            nodes: [wireCard(true)],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      };
    }
    if (query === INSPECT) {
      if (changeControlDuringRead) {
        changeControlDuringRead = false;
        controlMetadata += " ";
      }
      return {
        ...wireAccess(),
        control: wireCard(true),
        ...(variables.includeItem ? { target: wireCard(false) } : {}),
        repository: {
          nameWithOwner: repository,
          ...(variables.includeIssue
            ? {
                issue: {
                  __typename: "Issue",
                  id: card.issueNodeId,
                  number: card.objective,
                  title: card.title,
                  body: card.body,
                  state: card.state === "open" ? "OPEN" : "CLOSED",
                  repository: { nameWithOwner: repository },
                  projectItems: {
                    nodes:
                      card.metadata === null || !membershipVisible
                        ? []
                        : [
                            {
                              id: card.itemId,
                              isArchived: card.archived,
                              project: { id: binding.projectId },
                            },
                          ],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              }
            : {}),
        },
      };
    }
    throw new Error("Unexpected Project read query in wire workflow");
  };
  // Only the remote Project contract is a fixture; actual receipt production,
  // durable Git publication, runner completion and local control remain real.
  const github = {
    effectAdmission: "controller-checkpoint-v1",
    projectionMutationAdmission: "controller-checkpoint-v1",
    async projectQueueRead(_binding, knownTargets) {
      reads++;
      return projectQueueReadOnGitHub(
        repository,
        binding,
        graphql,
        knownTargets,
      );
    },
    async projectQueueInspect(_binding, request) {
      return {
        scope: "target",
        binding,
        actorId: 1,
        owner: "fixture",
        observedAt: new Date().toISOString(),
        control: { itemId: binding.controlItemId, metadata: controlMetadata },
        ...(request?.itemId ? { target: structuredClone(card) } : {}),
        ...(request?.objective
          ? {
              issue: structuredClone(card),
              membership: card.metadata
                ? [{ itemId: card.itemId, archived: false }]
                : [],
            }
          : {}),
      };
    },
    async projectQueueWrite(request) {
      const resolved = resolveProjectQueuePlannedEffect(
        binding,
        request.plannedEffect,
        request.dependencyReceipts ?? [],
      );
      const intent = {
        ...resolved.action,
        binding,
        requestId: request.requestId,
        actorId: 1,
        observedAt: new Date().toISOString(),
        request: resolved.request,
        ...(resolved.action.action === "set-metadata"
          ? { fieldId: binding.metadataFieldId }
          : {}),
      };
      await request.beforeWrite(intent);
      writes++;
      const control = resolved.action.itemId === binding.controlItemId;
      if (control) controlMetadata = resolved.action.metadata;
      else {
        if ("metadata" in resolved.action)
          card.metadata = resolved.action.metadata;
        if ("order" in resolved.action) card.order = resolved.action.order;
      }
      const target = {
        id: control ? binding.controlItemId : card.itemId,
        isArchived: false,
        project: { id: binding.projectId },
        content: control
          ? { __typename: "DraftIssue", id: "D_control" }
          : {
              __typename: "Issue",
              id: card.issueNodeId,
              number: 1,
              repository: { nameWithOwner: repository },
            },
        fieldValues: {
          nodes: [
            ...((control ? controlMetadata : card.metadata)
              ? [
                  {
                    __typename: "ProjectV2ItemFieldTextValue",
                    field: { id: binding.metadataFieldId },
                    text: control ? controlMetadata : card.metadata,
                  },
                ]
              : []),
            ...(card.order !== null && !control
              ? [
                  {
                    __typename: "ProjectV2ItemFieldNumberValue",
                    field: { id: binding.orderFieldId },
                    number: card.order,
                  },
                ]
              : []),
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      };
      const response = (clientMutationId) => ({
        clientMutationId,
        projectV2Item: structuredClone(target),
      });
      const original =
        intent.action === "ensure-card"
          ? {
              addProjectV2ItemById: {
                clientMutationId: intent.requestId,
                item: target,
              },
            }
          : intent.action === "set-admission-fields"
            ? {
                order: response(`${intent.requestId}:order`),
                admission: response(`${intent.requestId}:metadata`),
              }
            : { updateProjectV2ItemFieldValue: response(intent.requestId) };
      return {
        intent,
        itemId: target.id,
        observedAt: new Date().toISOString(),
        kind: "response",
        original,
      };
    },
    async objective() {
      return structuredClone(card);
    },
    async closeIssue() {
      card.state = "closed";
    },
  };
  await watchIntake(config, github);
  await enqueueIntake(config, github, [1]);
  // Authenticated real Git originals are stable identity hints, not a cached queue.
  const history = await readQueueHistory(config),
    hints = queueObservationTargets(history);
  assert.deepEqual(hints, [
    { objective: 1, issueNodeId: card.issueNodeId, itemId: card.itemId },
  ]);
  const beforeIndexReads = indexReads;
  await withProjectQueueObservationOnGitHub(
    repository,
    binding,
    graphql,
    async () => {
      assert.equal(
        (await projectQueueReadOnGitHub(repository, binding, graphql)).cards
          .length,
        0,
      );
      const current = await projectQueueReadOnGitHub(
        repository,
        binding,
        graphql,
        hints,
      );
      assert.equal(current.cards[0].body, body);
      assert.equal(
        verifyQueueObservation(config, current, history).entries[0].state,
        "queued",
      );
    },
  );
  assert.equal(
    indexReads - beforeIndexReads,
    2,
    "new mappings cannot reuse the index-only observation",
  );
  card.archived = true;
  const archived = await projectQueueReadOnGitHub(
    repository,
    binding,
    graphql,
    hints,
  );
  assert.equal(archived.cards[0].archived, true);
  assert.equal(
    verifyQueueObservation(config, archived, history).entries.length,
    0,
  );
  card.archived = false;
  membershipVisible = false;
  assert.equal(
    (await projectQueueReadOnGitHub(repository, binding, graphql, hints)).cards
      .length,
    0,
  );
  membershipVisible = true;
  card.order++;
  const reordered = await projectQueueReadOnGitHub(
    repository,
    binding,
    graphql,
    hints,
  );
  assert.equal(reordered.cards[0].order, card.order);
  assert.throws(
    () => verifyQueueObservation(config, reordered, history),
    /differs from original admission/,
  );
  card.order--;
  card.body += "Current changed contents.\n";
  const changed = await projectQueueReadOnGitHub(
    repository,
    binding,
    graphql,
    hints,
  );
  assert.equal(changed.cards[0].body, card.body);
  assert.notEqual(
    createHash("sha256").update(changed.cards[0].body).digest("hex"),
    verifyQueueObservation(config, changed, history).entries[0].bodyDigest,
  );
  card.body = body;
  const originalIssueId = card.issueNodeId;
  card.issueNodeId = "I_foreign";
  await assert.rejects(
    () => projectQueueReadOnGitHub(repository, binding, graphql, hints),
    /differs from current full observation/,
  );
  card.issueNodeId = originalIssueId;
  const originalControl = controlMetadata;
  changeControlDuringRead = true;
  await assert.rejects(
    () => projectQueueReadOnGitHub(repository, binding, graphql, hints),
    /differs from current full observation/,
  );
  controlMetadata = originalControl;

  const commit = git("rev-parse", "HEAD"),
    treeSha = git("rev-parse", "HEAD^{tree}");
  const item = {
    id: "qa",
    kind: "qa",
    title: "Verify unchanged fixture",
    goal: "Verify clean Git state",
    brief: "Verify only",
    acceptance: ["git diff is clean."],
    nonGoals: [],
    citations: [{ path: "OBJECTIVE" }],
    dependencies: [],
    ownedPaths: [],
    resources: [],
    expectedOutputRoles: [],
    sourceAssets: [],
    minimumAssetSets: 0,
    requiredLfsRoles: [],
    validation: [
      {
        command: "git diff --exit-code",
        provenance: "source-declared",
        source: "OBJECTIVE",
      },
    ],
  };
  const graph = {
    objective: 1,
    baseSha: commit,
    items: [item],
    coverage: [
      {
        criterionId: createHash("sha256")
          .update("git diff is clean.")
          .digest("hex"),
        itemId: item.id,
        source: {
          path: "OBJECTIVE",
          digest: createHash("sha256").update(body).digest("hex"),
          text: "git diff is clean.",
        },
        proof: { kind: "integrated-command", validationIndex: 0 },
        environment: {
          kind: "local",
          readiness: "available",
          probe: "",
          preparedBy: "",
        },
      },
    ],
  };
  const validation = await validateWorkItem(
    checkout,
    join(directory, "validation"),
    item,
    commit,
    treeSha,
    commit,
  );
  const state = {
    schemaVersion: 7,
    repository,
    objective: 1,
    runId: randomUUID(),
    configDigest: factoryConfigDigest(config),
    baseSha: commit,
    objectiveBodyDigest: createHash("sha256").update(body).digest("hex"),
    objectiveCommands: ["git diff --exit-code"],
    graph,
    planGraphDigest: graphDigest(graph),
    issueByItemId: { qa: 2 },
    work: {
      qa: {
        status: "done",
        changeRef: commit,
        treeSha,
        githubClosure: "complete",
        validation,
      },
    },
    finalValidation: { ...validation, passed: true },
    autonomy: resolveAutonomy({ allowances: { implementationRepairs: 0 } }),
    capacity: { concurrency: 1 },
    coordinator: {
      mode: "running",
      phase: "idle",
      phaseStartedAt: new Date().toISOString(),
      processes: [],
    },
  };
  // Historical command-only acceptance is sealed from real clean-checkout
  // receipts; this is no model response or claim of provider qualification.
  sealFinalAcceptance(state);
  saveState(statePath(repository, 1), state);
  const sealed = JSON.stringify(state.finalAcceptance);
  const contentStore = new LocalContentStore(
    join(stateRoot(repository), "content"),
  );
  const memory = new LocalRepositoryMemory(
    stateRoot(repository),
    repository,
    contentStore,
  );
  const source = contentStore.putBytes(
    Buffer.from("Actual new public fixture observation\n"),
    { mediaType: "text/plain" },
  );
  const originalReferences = LocalContentStore.prototype.checkpointReferences;
  let injected = false;
  let lateMemory;
  let previousAck;
  LocalContentStore.prototype.checkpointReferences = function (description) {
    if (
      !injected &&
      card.state === "closed" &&
      JSON.parse(description)[0] === "memory-learning-producer"
    ) {
      injected = true;
      previousAck = gitPersistenceStatus(config).lastAcknowledged;
      lateMemory = memory.retain({
        schemaVersion: 1,
        repository,
        visibility: "repository",
        kind: "reference",
        producer: { objective: 1, runId: state.runId, status: "observed" },
        createdAt: new Date().toISOString(),
        authority: "observation",
        summary: "A real late source original",
        bodies: [{ role: "notes", ref: source, availability: "retained" }],
        sources: [
          { identity: "fixture:late-source", complete: true, ref: source },
        ],
        bindings: {},
        validity: { state: "current", conditions: [] },
        supersedes: [],
      });
    }
    return Reflect.apply(originalReferences, this, [description]);
  };
  const services = {
    github,
    contentStore,
    planningModel: new CodexPlanningModel(checkout, selection, selection),
    driver: new LocalExecutionDriver(
      checkout,
      join(directory, "worktrees"),
      new CodexHarness(join(directory, "credentials"), "off", selection),
      1,
      contentStore,
      "codex",
    ),
    delivery: new RegularDelivery(checkout, github),
  };
  let running;
  try {
    running = runIntake(config, services, {
      backgroundConfigurationPath: join(directory, "config.json"),
    });
    const deadline = Date.now() + 15_000;
    let status;
    do {
      await new Promise((resolve) => setTimeout(resolve, 20));
      status = await requestControl(repository, {
        objective: 0,
        action: "status",
      }).catch((error) => {
        if (error.code === "ENOENT") return { handled: false };
        throw error;
      });
    } while (
      (!status.handled || !status.result.observation?.error) &&
      Date.now() < deadline
    );
    assert.equal(status.handled, true);
    assert.match(status.result.observation.error, /memory \(memory\/records\)/);
    assert.equal(status.result.localMode, "paused");
    assert.equal(status.result.activeObjective, null);
    assert.equal(injected, true);
    assert.equal(readState(repository, 1).objectiveClosure, "complete");
    assert.equal(
      JSON.stringify(readState(repository, 1).finalAcceptance),
      sealed,
    );
    const held = gitPersistenceStatus(config),
      heldReads = reads,
      heldWrites = writes;
    assert.equal(held.pendingChanges, true);
    assert.equal(held.protectedContinuation, false);
    assert.equal(held.status, "failed");
    assert.match(held.error, /memory \(memory\/records\)/);
    assert.deepEqual(held.lastAcknowledged, previousAck);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(reads, heldReads);
    assert.equal(writes, heldWrites);
    assert.deepEqual(gitPersistenceStatus(config), held);
    await intakeControl(config, "resume", undefined, github);
    const recovered = gitPersistenceStatus(config);
    assert.equal(recovered.protectedContinuation, true);
    const archive = await readVerifiedRecoveryCheckpoint(config);
    assert.equal(archive.commitSha, recovered.lastAcknowledged.commitSha);
    assert(
      archive.manifest.contentRefs.some(
        (ref) => ref.digest === lateMemory.manifestRef.digest,
      ),
    );
    assert.deepEqual(
      Buffer.from(await archive.readVerifiedBlob(lateMemory.manifestRef)),
      contentStore.readBytes(lateMemory.manifestRef),
    );
    const resumed = await requestControl(repository, {
      objective: 0,
      action: "status",
    });
    assert.equal(resumed.result.localMode, undefined);
    assert.equal(resumed.result.observation?.error, undefined);
    assert.equal(
      JSON.stringify(readState(repository, 1).finalAcceptance),
      sealed,
    );
    await intakeControl(config, "drain", undefined, github);
    await running;
    assert.equal(
      readControllerOwner(installationLockPath(repository)),
      undefined,
    );
  } finally {
    LocalContentStore.prototype.checkpointReferences = originalReferences;
    if (running) {
      process.emit("SIGTERM");
      await running.catch(() => undefined);
    }
  }
});

/** Another controller process: holds the lock in `mode` until told to let go. */
async function holder(key, mode, publication = false) {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { withRegistryFiles, withCheckpointPublication, takeGuard, releaseGuard } from ${JSON.stringify(processUrl)};
       const body = async () => {
         process.stdout.write("held\\n");
         await new Promise((resolve) => process.stdin.once("data", resolve));
       };
       ${publication === "legacy" ? `takeGuard(${JSON.stringify(key)}); try { await body(); } finally { releaseGuard(${JSON.stringify(key)}); }` : `await ${publication ? `withCheckpointPublication(${JSON.stringify(key)}, body)` : `withRegistryFiles(${JSON.stringify(key)}, ${JSON.stringify(mode)}, undefined, body)`};`}
       process.exit(0);`,
    ],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  child.stdout.setEncoding("utf8");
  let output = "";
  const seen = (line) =>
    new Promise((resolve) => {
      const check = () => output.includes(line) && resolve();
      child.stdout.on("data", (part) => {
        output += part;
        check();
      });
      check();
    });
  await seen("held");
  return {
    release: async () => {
      child.stdin.write("go\n");
      await once(child, "exit");
    },
    kill: async () => {
      child.kill("SIGKILL");
      await once(child, "exit");
    },
  };
}

/** Whether this process's command ran within `ms` while the other held the lock. */
async function ranWithin(key, mode, ms) {
  let ran = false;
  const command = withRegistryFiles(key, mode, undefined, async () => {
    ran = true;
  });
  await new Promise((resolve) => setTimeout(resolve, ms));
  return { ran, command };
}

test("the worktree registry lock holds across processes: exclusive excludes the other, shared readers share", async () => {
  const key = `/registry-${process.pid}-${Date.now()}`;

  // Another process changes the registry: this process neither reads nor changes it.
  let other = await holder(key, "exclusive");
  const reader = await ranWithin(key, "shared", 200);
  const changer = await ranWithin(key, "exclusive", 200);
  assert.equal(reader.ran, false);
  assert.equal(changer.ran, false);
  await other.release();
  await Promise.all([reader.command, changer.command]);

  // Another process reads the registry: this process reads too, but does not change it.
  other = await holder(key, "shared");
  assert.equal((await ranWithin(key, "shared", 200)).ran, true);
  const writer = await ranWithin(key, "exclusive", 200);
  assert.equal(writer.ran, false);
  await other.release();
  await writer.command;

  // A holder that crashed leaves a stale file, which no longer excludes anyone.
  other = await holder(key, "exclusive");
  await other.kill();
  await withRegistryFiles(key, "exclusive", undefined, async () => undefined);
});

test("the actual creating lease settles only a fresh failed reservation and archives exact originals without a canonical run", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "factory-reservation-failure-"),
  );
  const repository = `fixture/reservation-${randomUUID()}`;
  const checkout = join(directory, "target"),
    remote = join(directory, "archive.git");
  await mkdir(checkout);
  const git = (...args) =>
    execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
  git("init", "-b", "main");
  git("remote", "add", "origin", `https://github.com/${repository}.git`);
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "--allow-empty",
    "-m",
    "public fixture baseline",
  );
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  const selection = { model: "unused-local-check", reasoningEffort: "low" };
  const config = {
    schemaVersion: 1,
    repository,
    checkout,
    planning: { kind: "codex-sdk", planner: selection, reviewer: selection },
    execution: {
      kind: "local",
      concurrency: 1,
      harness: { kind: "codex-sdk", ...selection },
    },
    delivery: { kind: "regular" },
    policy: { network: "off", allowedSecretNames: [] },
    queue: {
      pollSeconds: 1,
      project: {
        repository,
        projectId: "PVT_storage",
        metadataFieldId: "PVTF_metadata",
        orderFieldId: "PVTF_order",
        controlItemId: "PVTI_control",
        factoryManagedFields: true,
      },
    },
    gitPersistence: {
      remote,
      ref: "refs/heads/factory-history",
      visibility: "private",
      scope: "private-history",
      maxBytes: 16 * 1024 * 1024,
      maxFiles: 4096,
      timeoutMs: 1000,
      coalesceMs: 0,
    },
  };
  validateConfig(config);
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const lock = acquireObjectiveLock(repository, 1);
  let lockReleased = false;
  try {
    // This is an original reservation/storage test, not a fabricated remote
    // admission or a claim that any provider or GitHub write ran.
    const claim = {
      schemaVersion: 1,
      kind: "project-queue-owner",
      id: randomUUID(),
      repository,
      authorityDigest: factoryAuthorityDigest(config),
      admissionId: randomUUID(),
      receiptId: randomUUID(),
      objective: 1,
      bodyDigest: hash("original approved body"),
      ownerTokenDigest: hash(lock.token),
      ownerProcess: {
        ...ownIdentity(),
        namespace: readlinkSync("/proc/self/ns/pid"),
      },
      at: new Date().toISOString(),
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const history = join(stateRoot(repository), "project-queue-history");
    await mkdir(history, { mode: 0o700 });
    const path = join(history, `${claim.id}.json`),
      original = Buffer.from(`${JSON.stringify(claim)}\n`);
    await writeFile(path, original, { mode: 0o600 });
    const error = new Error("original before-effect failure");
    const maintenanceBuildOwners = [];
    let observingMaintenance = false;
    const buildClosure = () => {
      if (observingMaintenance)
        maintenanceBuildOwners.push(
          readControllerOwner(installationLockPath(repository)),
        );
      return buildRecoveryCheckpointClosure({
        config,
        scope: "private-history",
      });
    };
    await withRecoveryCheckpointScope({ config, buildClosure }, async () => {
      const historical = structuredClone(claim);
      delete historical.ownerProcess;
      await assert.rejects(
        settleFailedProjectQueueReservation(
          config,
          historical,
          lock.token,
          error,
        ),
        /historical or started work/,
      );
      await assert.rejects(
        settleFailedProjectQueueReservation(
          config,
          claim,
          "foreign-token",
          error,
        ),
        /creating controller lease/,
      );
      const foreign = structuredClone(claim);
      foreign.ownerProcess.startTime = "1";
      await assert.rejects(
        settleFailedProjectQueueReservation(config, foreign, lock.token, error),
        /same creating owner/,
      );
      await writeFile(
        statePath(repository, 1),
        '{"schemaVersion":18,"kind":"preparing"}\n',
        { mode: 0o600 },
      );
      await assert.rejects(
        settleFailedProjectQueueReservation(config, claim, lock.token, error),
      );
      await rm(statePath(repository, 1));
      assert.deepEqual(await readFile(path), original);
      await settleFailedProjectQueueReservation(
        config,
        claim,
        lock.token,
        error,
      );
    });
    assert.equal(claim.settled.runId, undefined);
    assert.equal(claim.runBinding, undefined);
    assert.equal(claim.settled.disposition, "quiescent");
    const store = new LocalContentStore(join(stateRoot(repository), "content"));
    const proof = claim.settled.reservationFailure;
    assert.deepEqual(
      Buffer.from(store.readBytes(proof.originalClaim)),
      original,
    );
    assert.equal(
      JSON.parse(Buffer.from(store.readBytes(proof.failure)).toString()),
      error.stack,
    );
    await authenticateQueueOwnerReferences(claim, async (ref) =>
      store.readBytes(ref),
    );
    await withRecoveryCheckpointControllerVerification(
      { config, buildClosure },
      async () => {
        const verified = await buildClosure();
        assert.deepEqual(await buildClosure(), verified);
        const failurePath = join(
          stateRoot(repository),
          "content",
          proof.failure.digest.slice(0, 2),
          proof.failure.digest,
        );
        const failureBytes = await readFile(failurePath);
        try {
          await writeFile(
            failurePath,
            Buffer.concat([failureBytes, Buffer.from("x")]),
          );
          await assert.rejects(buildClosure(), /size|digest|exact|reference/i);
        } finally {
          await writeFile(failurePath, failureBytes);
        }
        assert.deepEqual(await buildClosure(), verified);
      },
    );
    const forged = structuredClone(claim);
    forged.deadlineAt = new Date(Date.now() + 120_000).toISOString();
    await assert.rejects(
      authenticateQueueOwnerReferences(forged, async (ref) =>
        store.readBytes(ref),
      ),
      /exact original claim/,
    );
    const archive = await readVerifiedRecoveryCheckpoint(config);
    assert.equal(archive.manifest.gaps.length, 0);
    assert.equal(
      archive.manifest.files.some(
        (file) => file.path === "objectives/1/state.json",
      ),
      false,
    );
    for (const ref of [proof.originalClaim, proof.failure])
      assert.deepEqual(
        Buffer.from(await archive.readVerifiedBlob(ref)),
        Buffer.from(store.readBytes(ref)),
      );
    // A retained intent is not a remote outcome. Archive a genuine local original
    // through Git, then prove a later authority cannot ignore its unknown effect.
    // No gateway, submitted mutation, response or operator retirement is fabricated.
    const operationId = randomUUID(),
      requestId = randomUUID();
    const metadata = JSON.stringify({
      schemaVersion: 1,
      kind: "admission",
      admissionId: claim.admissionId,
      receiptId: operationId,
      state: "withdrawn",
    });
    const binding = config.queue.project;
    const unknown = {
      schemaVersion: 1,
      kind: "project-queue-operation",
      id: operationId,
      repository,
      binding,
      authorityDigest: "1".repeat(64),
      at: new Date().toISOString(),
      action: "withdraw",
      approval: { kind: "queue-command" },
      scope: "I_storage",
      previousReceiptId: claim.receiptId,
      objective: 1,
      issueNodeId: "I_storage",
      bodyDigest: claim.bodyDigest,
      order: 1,
      metadata,
      effects: [
        {
          intent: {
            binding,
            requestId,
            actorId: 1,
            observedAt: new Date().toISOString(),
            action: "set-metadata",
            itemId: "PVTI_storage",
            metadata,
            fieldId: binding.metadataFieldId,
            request: {
              query: UPDATE,
              variables: {
                input: {
                  clientMutationId: requestId,
                  projectId: binding.projectId,
                  itemId: "PVTI_storage",
                  fieldId: binding.metadataFieldId,
                  value: { text: metadata },
                },
              },
            },
          },
        },
      ],
    };
    const unknownBytes = Buffer.from(`${JSON.stringify(unknown)}\n`);
    await withRecoveryCheckpointScope({ config, buildClosure }, async () => {
      await writeFile(join(history, `${operationId}.json`), unknownBytes, {
        mode: 0o600,
      });
      markCheckpointDirty(repository, {
        path: `project-queue-history/${operationId}.json`,
        kind: "historical",
      });
      await awaitCheckpointAdmission(repository, "explicit");
    });
    const restoredHistory = await readQueueHistory(config);
    assert.deepEqual(
      restoredHistory.find((row) => row.id === operationId),
      unknown,
    );
    const independent = await readQueueHistory(config);
    independent.find((row) => row.id === operationId).completed =
      new Date().toISOString();
    assert.deepEqual(
      (await readQueueHistory(config)).find((row) => row.id === operationId),
      unknown,
    );
    assert.throws(
      () => retainedQueueEntry(config, restoredHistory, 1),
      /partial or unknown/,
    );
    const restoredArchive = await readVerifiedRecoveryCheckpoint(config);
    const originalFile = restoredArchive.manifest.files.find(
      (file) => file.path === `project-queue-history/${operationId}.json`,
    );
    assert.deepEqual(
      Buffer.from(await restoredArchive.readVerifiedBlob(originalFile.ref)),
      unknownBytes,
    );
    assert.equal(
      restoredHistory.find((row) => row.id === operationId).completed,
      undefined,
    );
    assert.equal(
      restoredHistory.find((row) => row.id === operationId).beforeEffectFailure,
      undefined,
    );
    assert.equal(
      restoredHistory.find((row) => row.id === operationId).retiredWithdrawal,
      undefined,
    );

    // One exact-ref fetch observes the current tip, while a selected older
    // checkpoint must still be its authenticated ancestor. Neither a previous
    // FETCH_HEAD nor the publisher's local objects supply read authority.
    await withRecoveryCheckpointControllerVerification(
      { config, buildClosure },
      async () => {
        const offset = (await readFile(diagnosticPath(repository, 0))).length;
        const selected = await readVerifiedRecoveryCheckpoint(
          config,
          archive.commitSha,
        );
        assert.notEqual(archive.commitSha, restoredArchive.commitSha);
        assert.equal(selected.commitSha, archive.commitSha);
        assert.equal(selected.remoteTip, restoredArchive.commitSha);
        const events = (await readFile(diagnosticPath(repository, 0)))
          .subarray(offset)
          .toString("utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
          .filter((event) => event.operation === "recovery-checkpoint-archive");
        assert.equal(
          events.filter(
            (event) =>
              event.metadata.phase === "fetch" && event.outcome === "started",
          ).length,
          1,
        );
        assert.equal(
          events.some((event) => event.metadata.phase === "remote-tip"),
          false,
        );
        const recovery = join(stateRoot(repository), "recovery");
        const verifier = async () => {
          const names = (await readdir(recovery)).filter(
            (name) => name.startsWith("verify-") && name.endsWith(".git"),
          );
          assert.equal(names.length, 1);
          return join(recovery, names[0]);
        };
        const staleHead = await readFile(join(await verifier(), "FETCH_HEAD"));
        assert(staleHead.toString().startsWith(restoredArchive.commitSha));
        execFileSync("git", [
          `--git-dir=${remote}`,
          "update-ref",
          "-d",
          config.gitPersistence.ref,
          restoredArchive.commitSha,
        ]);
        const missingOffset = (await readFile(diagnosticPath(repository, 0)))
          .length;
        try {
          await assert.rejects(
            readVerifiedRecoveryCheckpoint(config),
            /Bounded Git archive transport command failed/,
          );
          const missingEvents = (await readFile(diagnosticPath(repository, 0)))
            .subarray(missingOffset)
            .toString("utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
            .filter(
              (event) => event.operation === "recovery-checkpoint-archive",
            );
          assert(
            missingEvents.some(
              (event) =>
                event.metadata.phase === "fetch" && event.outcome === "failed",
            ),
          );
          assert.equal(
            missingEvents.some(
              (event) => event.metadata.phase === "fetched-material",
            ),
            false,
            "a failed fetch cannot inspect or accept its stale FETCH_HEAD",
          );
        } finally {
          execFileSync("git", [
            `--git-dir=${remote}`,
            "update-ref",
            config.gitPersistence.ref,
            restoredArchive.commitSha,
          ]);
        }
        assert.equal(
          (await readVerifiedRecoveryCheckpoint(config)).commitSha,
          restoredArchive.commitSha,
        );
        await assert.rejects(
          readVerifiedRecoveryCheckpoint(config, git("rev-parse", "HEAD")),
          /merge-base|bad object|Not a valid|unknown revision/i,
        );
        const changedBinding = structuredClone(config);
        changedBinding.gitPersistence.ref = "refs/heads/another-history";
        await assert.rejects(
          readVerifiedRecoveryCheckpoint(changedBinding),
          /different admitted binding|admitted binding changed/,
        );

        await readVerifiedRecoveryCheckpoint(config);
        const objectRoot = join(await verifier(), "objects");
        const objects = await readdir(objectRoot, {
          recursive: true,
          withFileTypes: true,
        });
        const object = objects.find(
          (entry) => entry.isFile() && !entry.parentPath.endsWith("/info"),
        );
        assert(object);
        const objectPath = join(object.parentPath, object.name);
        const bytes = await readFile(objectPath);
        const mode = (await stat(objectPath)).mode & 0o777;
        await chmod(objectPath, 0o600);
        await writeFile(objectPath, Buffer.concat([bytes, Buffer.from("x")]));
        await chmod(objectPath, mode);
        await assert.rejects(
          readVerifiedRecoveryCheckpoint(config),
          /altered or missing object material/,
        );
        assert.equal(
          (await readVerifiedRecoveryCheckpoint(config)).commitSha,
          restoredArchive.commitSha,
          "a failed owned verifier is discarded before a fresh strict read",
        );
      },
    );

    // Freeze a whole multi-target removal as real local records, then archive it
    // through the real Git checkpoint. No remote response or completion is invented.
    await withRecoveryCheckpointScope({ config, buildClosure }, async () => {
      const removals = [2, 3].map((objective) => {
        const operation = createQueueOperation(config, {
          action: "withdraw",
          scope: `I_${objective}`,
          previousReceiptId: randomUUID(),
          approval: { kind: "queue-command" },
          objective,
          issueNodeId: `I_${objective}`,
          bodyDigest: hash(`body ${objective}`),
          order: objective,
        });
        operation.metadata = JSON.stringify({
          schemaVersion: 1,
          kind: "admission",
          admissionId: randomUUID(),
          receiptId: operation.id,
          state: "withdrawn",
        });
        return operation;
      });
      const removalEffects = removals.map((operation) =>
        createProjectQueuePlannedEffect(binding, {
          operationId: operation.id,
          requestId: randomUUID(),
          actorId: 1,
          action: "set-metadata",
          target: { itemId: `PVTI_${operation.objective}` },
          fieldId: binding.metadataFieldId,
          metadata: operation.metadata,
          prior: {
            target: { itemId: `PVTI_${operation.objective}`, metadata: null },
          },
          control: { metadata: null },
        }),
      );
      let command;
      await withRecoveryCheckpointScope({ config, buildClosure }, async () => {
        command = createQueueCommand(config, {
          operations: removals,
          effects: removalEffects,
          deadlineAt: null,
        });
        await admitQueueCommand(config, command);
        await assert.rejects(
          completeQueueCommand(config, command),
          /every declared fulfilled original/,
        );
        await assert.rejects(
          admitQueueCommand(config, structuredClone(command)),
          /Original creating command/,
        );
        await assert.rejects(
          performQueueCommandEffect(config, {}, command, 1),
          /Only the next/,
        );
        await assert.rejects(
          admitQueueCommand(config, command),
          /cannot replay/,
        );
      });
      const commandArchive = await readVerifiedRecoveryCheckpoint(config);
      for (const operation of removals) {
        const file = commandArchive.manifest.files.find(
          (entry) =>
            entry.path === `project-queue-history/${operation.id}.json`,
        );
        assert.ok(file);
        assert.deepEqual(
          Buffer.from(await commandArchive.readVerifiedBlob(file.ref)),
          await readFile(join(history, `${operation.id}.json`)),
        );
        assert.equal(operation.completed, undefined);
        assert.deepEqual(operation.effects, []);
      }
      const records = structuredClone(removals);
      assert.doesNotThrow(() =>
        assertQueueCommandHistory(records, () =>
          assert.fail("intent-only command has no response originals"),
        ),
      );
      const refuses = (change, pattern) => {
        const changed = structuredClone(records);
        change(changed);
        assert.throws(
          () =>
            assertQueueCommandHistory(changed, () =>
              assert.fail("no response original should be requested"),
            ),
          pattern,
        );
      };
      refuses((rows) => {
        rows[1].bodyDigest = hash("changed approved body");
      }, /frozen original header/);
      refuses((rows) => {
        rows[1].commandId = randomUUID();
      }, /frozen original header/);
      refuses((rows) => {
        rows[0].commandRecipe.effects.pop();
      }, /every admission effect/);
      refuses((rows) => {
        rows[0].completed = true;
      }, /every declared original response/);
      refuses((rows) => {
        rows[0].commandRecipe.effects[1].requestId =
          rows[0].commandRecipe.effects[0].requestId;
        rows[0].commandRecipe.effects[1].request.variables.input.clientMutationId =
          rows[0].commandRecipe.effects[0].requestId;
      }, /identity.*differs/);
      refuses((rows) => {
        rows[0].commandRecipe.effects[1].actorId = 2;
      }, /actor differs/);

      // Test the admission and roadmap schemas with pure public wire contracts;
      // these declarations make no claim that a GitHub effect has occurred.
      const admission = createQueueOperation(config, {
        action: "admit",
        scope: "I_new",
        previousReceiptId: null,
        approval: { kind: "queue-command" },
        objective: 4,
        issueNodeId: "I_new",
        bodyDigest: hash("new approved body"),
        order: 9,
      });
      admission.metadata = JSON.stringify({
        schemaVersion: 1,
        kind: "admission",
        admissionId: randomUUID(),
        receiptId: admission.id,
        state: "queued",
      });
      const common = {
        operationId: admission.id,
        actorId: 1,
        expectedIssue: {
          issueNodeId: admission.issueNodeId,
          objective: admission.objective,
          bodyDigest: admission.bodyDigest,
        },
        control: { metadata: null },
      };
      const ensured = createProjectQueuePlannedEffect(binding, {
        ...common,
        requestId: randomUUID(),
        action: "ensure-card",
        issueNodeId: admission.issueNodeId,
        prior: { target: null },
      });
      const ordered = createProjectQueuePlannedEffect(binding, {
        ...common,
        requestId: randomUUID(),
        action: "set-order",
        target: { resultOf: ensured.requestId },
        fieldId: binding.orderFieldId,
        order: 9,
        prior: { resultOf: ensured.requestId },
      });
      const final = createProjectQueuePlannedEffect(binding, {
        ...common,
        requestId: randomUUID(),
        action: "set-metadata",
        target: { resultOf: ensured.requestId },
        fieldId: binding.metadataFieldId,
        metadata: admission.metadata,
        prior: { resultOf: ordered.requestId },
      });
      const admissionPlan = {
        operations: [admission],
        effects: [ensured, ordered, final],
        deadlineAt: null,
      };
      assert.throws(
        () =>
          createQueueCommand(config, {
            ...admissionPlan,
            effects: [ordered, ensured, final],
          }),
        /dependency must precede/,
      );
      assert.throws(
        () =>
          createQueueCommand(config, {
            ...admissionPlan,
            effects: [ensured, final],
          }),
        /dependency must precede/,
      );
      assert.throws(
        () =>
          createQueueCommand(config, {
            ...admissionPlan,
            deadlineAt: new Date().toISOString(),
          }),
        /original armed deadline/,
      );
      const wrongBody = structuredClone(admissionPlan);
      wrongBody.effects[0].expectedIssue.bodyDigest = hash("changed body");
      assert.throws(
        () => createQueueCommand(config, wrongBody),
        /exact approved Issue body/,
      );
      const wrongPrior = structuredClone(admissionPlan);
      wrongPrior.effects[2].prior.resultOf = ensured.requestId;
      assert.throws(
        () => createQueueCommand(config, wrongPrior),
        /immediately preceding/,
      );
      await withRecoveryCheckpointScope({ config, buildClosure }, async () => {
        const planned = createQueueCommand(config, admissionPlan);
        assert.equal(nextProjectQueueOrder([admission]), 10);
        await admitQueueCommand(config, planned);
        await assert.rejects(
          completeQueueCommand(config, planned),
          /every declared fulfilled original/,
        );
      });
      // Preserve the three-action legacy declaration above, and archive the new
      // compound declaration as real local intent only: no remote result exists.
      const compoundAdmission = createQueueOperation(config, {
        action: "admit",
        scope: "I_compound",
        previousReceiptId: null,
        approval: { kind: "queue-command" },
        objective: 6,
        issueNodeId: "I_compound",
        bodyDigest: hash("compound approved body"),
        order: 17,
      });
      compoundAdmission.metadata = JSON.stringify({
        schemaVersion: 1,
        kind: "admission",
        admissionId: randomUUID(),
        receiptId: compoundAdmission.id,
        state: "queued",
      });
      const compoundCommon = {
        operationId: compoundAdmission.id,
        actorId: 1,
        expectedIssue: {
          issueNodeId: compoundAdmission.issueNodeId,
          objective: compoundAdmission.objective,
          bodyDigest: compoundAdmission.bodyDigest,
        },
        control: { metadata: null },
      };
      const compoundEnsure = createProjectQueuePlannedEffect(binding, {
        ...compoundCommon,
        requestId: randomUUID(),
        action: "ensure-card",
        issueNodeId: compoundAdmission.issueNodeId,
        prior: { target: null },
      });
      const compoundFields = createProjectQueuePlannedEffect(binding, {
        ...compoundCommon,
        requestId: randomUUID(),
        action: "set-admission-fields",
        target: { resultOf: compoundEnsure.requestId },
        orderFieldId: binding.orderFieldId,
        metadataFieldId: binding.metadataFieldId,
        order: compoundAdmission.order,
        metadata: compoundAdmission.metadata,
        prior: { resultOf: compoundEnsure.requestId },
      });
      const compoundPlan = {
        operations: [compoundAdmission],
        effects: [compoundEnsure, compoundFields],
        deadlineAt: null,
      };
      for (const change of [
        (value) => {
          value.orderFieldId = binding.metadataFieldId;
        },
        (value) => {
          value.metadataFieldId = binding.orderFieldId;
        },
        (value) => {
          value.target.resultOf = randomUUID();
        },
        (value) => {
          value.expectedIssue = undefined;
        },
      ]) {
        const changed = structuredClone(compoundFields);
        change(changed);
        assert.throws(() => createProjectQueuePlannedEffect(binding, changed));
      }
      for (const change of [
        (plan) => {
          plan.effects.pop();
        },
        (plan) => {
          plan.effects.reverse();
        },
        (plan) => {
          plan.effects[1].order++;
        },
        (plan) => {
          plan.effects[1].metadata = admission.metadata;
        },
        (plan) => {
          plan.effects[1].expectedIssue.bodyDigest = hash("other body");
        },
        (plan) => {
          plan.effects[1].prior.resultOf = randomUUID();
        },
        (plan) => {
          plan.effects.push(structuredClone(plan.effects[1]));
        },
      ]) {
        const changed = structuredClone(compoundPlan);
        change(changed);
        assert.throws(() => createQueueCommand(config, changed));
      }
      const compoundCommand = createQueueCommand(config, compoundPlan);
      assert.deepEqual(
        compoundAdmission.commandRecipe.effects.map((v) => v.action),
        ["ensure-card", "set-admission-fields"],
      );
      assert.equal(nextProjectQueueOrder([compoundAdmission]), 18);
      await admitQueueCommand(config, compoundCommand);
      await assert.rejects(
        completeQueueCommand(config, compoundCommand),
        /every declared fulfilled original/,
      );
      await assert.rejects(
        performQueueCommandEffect(config, {}, compoundCommand, 1),
        /Only the next/,
      );
      await assert.rejects(
        admitQueueCommand(config, compoundCommand),
        /cannot replay/,
      );
      const interrupted = structuredClone(compoundAdmission);
      interrupted.completed = true;
      assert.throws(
        () =>
          assertQueueCommandHistory([interrupted], () =>
            assert.fail("an interrupted declaration has no originals"),
          ),
        /every declared original response/,
      );
      // Pure decoder coverage below uses explicit synthetic API originals only
      // in memory. They are never archived or called installed qualification.
      const originals = new Map();
      const originalRef = (value) => {
        const bytes = Buffer.from(JSON.stringify(value));
        const ref = {
          digest: hash(bytes),
          bytes: bytes.length,
          mediaType: "application/json",
        };
        originals.set(ref.digest, bytes);
        return ref;
      };
      const readOriginal = (ref) => originals.get(ref.digest);
      const card = (order = null, metadata = null) => ({
        id: "PVTI_compound",
        isArchived: false,
        project: { id: binding.projectId },
        content: {
          __typename: "Issue",
          id: compoundAdmission.issueNodeId,
          number: compoundAdmission.objective,
          repository: { nameWithOwner: repository },
        },
        fieldValues: {
          nodes: [
            ...(order === null
              ? []
              : [
                  {
                    __typename: "ProjectV2ItemFieldNumberValue",
                    field: { id: binding.orderFieldId },
                    number: order,
                  },
                ]),
            ...(metadata === null
              ? []
              : [
                  {
                    __typename: "ProjectV2ItemFieldTextValue",
                    field: { id: binding.metadataFieldId },
                    text: metadata,
                  },
                ]),
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      });
      const concreteIntent = (step, receipts) => {
        const resolved = resolveProjectQueuePlannedEffect(
          binding,
          step,
          receipts,
        );
        return {
          ...resolved.action,
          binding,
          actorId: step.actorId,
          requestId: step.requestId,
          observedAt: new Date().toISOString(),
          request: resolved.request,
        };
      };
      const ensureIntent = concreteIntent(compoundEnsure, []);
      const ensureOriginal = {
        addProjectV2ItemById: {
          clientMutationId: ensureIntent.requestId,
          item: card(),
        },
      };
      const ensureReceipt = {
        intent: ensureIntent,
        itemId: "PVTI_compound",
        observedAt: ensureIntent.observedAt,
        kind: "response",
        original: ensureOriginal,
      };
      const fieldsIntent = concreteIntent(compoundFields, [ensureReceipt]);
      assert.deepEqual(fieldsIntent.request.variables, {
        orderInput: {
          clientMutationId: `${fieldsIntent.requestId}:order`,
          projectId: binding.projectId,
          itemId: "PVTI_compound",
          fieldId: binding.orderFieldId,
          value: { number: 17 },
        },
        metadataInput: {
          clientMutationId: `${fieldsIntent.requestId}:metadata`,
          projectId: binding.projectId,
          itemId: "PVTI_compound",
          fieldId: binding.metadataFieldId,
          value: { text: compoundAdmission.metadata },
        },
      });
      assert(
        fieldsIntent.request.query.indexOf(
          "order: updateProjectV2ItemFieldValue",
        ) <
          fieldsIntent.request.query.indexOf(
            "admission: updateProjectV2ItemFieldValue",
          ),
      );
      const fieldsOriginal = {
        order: {
          clientMutationId: `${fieldsIntent.requestId}:order`,
          projectV2Item: card(compoundAdmission.order),
        },
        admission: {
          clientMutationId: `${fieldsIntent.requestId}:metadata`,
          projectV2Item: card(
            compoundAdmission.order,
            compoundAdmission.metadata,
          ),
        },
      };
      const synthetic = structuredClone(compoundAdmission);
      synthetic.effects = [
        {
          intent: ensureIntent,
          receipt: {
            intent: ensureIntent,
            itemId: "PVTI_compound",
            observedAt: ensureIntent.observedAt,
            kind: "response",
          },
          original: originalRef(ensureOriginal),
        },
        {
          intent: fieldsIntent,
          receipt: {
            intent: fieldsIntent,
            itemId: "PVTI_compound",
            observedAt: fieldsIntent.observedAt,
            kind: "response",
          },
          original: originalRef(fieldsOriginal),
        },
      ];
      synthetic.completed = true;
      assert.doesNotThrow(() =>
        assertQueueCommandHistory([synthetic], readOriginal),
      );
      const stripped = structuredClone(synthetic);
      delete stripped.commandId;
      delete stripped.commandRecipe;
      assert.throws(
        () =>
          parseQueueRecord(
            Buffer.from(JSON.stringify(stripped)),
            repository,
            stripped.id,
          ),
        /declared command membership/,
      );
      assert.throws(
        () => assertQueueCommandHistory([stripped], readOriginal),
        /declared command membership/,
      );
      assert.throws(
        () => retainedQueueEntry(config, [stripped], 6),
        /exact authenticated explicit producer receipt/,
      );
      assert.equal(retainedQueueEntry(config, [synthetic], 6).order, 17);
      // Exercise the exact shared stopped/cancelled settlement admission boundary.
      // Originals above are narrow schema fixtures; this does not claim remote effects.
      const settlementClaim = {
        ...claim,
        objective: synthetic.objective,
        bodyDigest: synthetic.bodyDigest,
        authorityDigest: synthetic.authorityDigest,
        receiptId: synthetic.id,
        admissionId: JSON.parse(synthetic.metadata).admissionId,
      };
      const settlementState = {
        objective: synthetic.objective,
        objectiveBodyDigest: synthetic.bodyDigest,
      };
      assert.doesNotThrow(() =>
        assertProjectQueueClaimAdmission(
          config,
          [synthetic],
          settlementClaim,
          settlementState,
        ),
      );
      for (const change of [
        (record) => {
          delete record.completed;
        },
        (record) => {
          delete record.effects[1].original;
        },
        (record) => {
          record.effects[1].intent.order++;
        },
        (record) => {
          record.bodyDigest = hash("changed original body");
        },
      ]) {
        const changed = structuredClone(synthetic);
        change(changed);
        assert.throws(() =>
          assertProjectQueueClaimAdmission(
            config,
            [changed],
            settlementClaim,
            settlementState,
          ),
        );
      }
      assert.throws(() =>
        assertProjectQueueClaimAdmission(
          config,
          [synthetic],
          { ...settlementClaim, admissionId: randomUUID() },
          settlementState,
        ),
      );

      for (const change of [
        (value) => {
          delete value.admission;
        },
        (value) => {
          value.order.clientMutationId = fieldsIntent.requestId;
        },
        (value) => {
          value.admission.projectV2Item.id = "PVTI_other";
        },
        (value) => {
          value.order.projectV2Item.isArchived = true;
        },
        (value) => {
          value.admission.projectV2Item.fieldValues.pageInfo.hasNextPage = true;
        },
        (value) => {
          value.admission.projectV2Item.fieldValues.nodes.pop();
        },
        (value) => {
          value.admission.projectV2Item.fieldValues.nodes[0].number++;
        },
        (value) => {
          value.order.projectV2Item.content.number++;
          value.admission.projectV2Item.content.number++;
        },
        (value) => {
          value.errors = [{ message: "second write failed" }];
        },
      ]) {
        const changedOriginal = structuredClone(fieldsOriginal);
        change(changedOriginal);
        const changed = structuredClone(synthetic);
        changed.effects[1].original = originalRef(changedOriginal);
        assert.throws(() => assertQueueCommandHistory([changed], readOriginal));
      }
      const partial = structuredClone(synthetic);
      delete partial.completed;
      delete partial.effects[1].receipt;
      delete partial.effects[1].original;
      partial.effects[1].rejectedOriginal = originalRef({
        data: { order: fieldsOriginal.order },
        errors: [{ message: "metadata write failed" }],
      });
      assert.doesNotThrow(() =>
        assertQueueCommandHistory([partial], readOriginal),
      );
      assert.equal(nextProjectQueueOrder([partial]), 18);
      assert.throws(
        () => retainedQueueEntry(config, [partial], 6),
        /partial or unknown/,
      );
      partial.completed = true;
      assert.throws(
        () => assertQueueCommandHistory([partial], readOriginal),
        /every declared original response/,
      );
      // The old operator disposition accepts only its original three-action
      // legacy shape; a partial compound record cannot acquire that authority.
      const refusedRetirement = structuredClone(partial);
      delete refusedRetirement.completed;
      refusedRetirement.retiredAdmission = {
        originalOperation: originalRef(refusedRetirement),
      };
      assert.throws(
        () =>
          assertQueueOperationReferenceBodies(refusedRetirement, readOriginal),
        /two genuine ordered responses/,
      );
      assert.equal(
        originals.get(partial.effects[1].rejectedOriginal.digest).toString(),
        JSON.stringify({
          data: { order: fieldsOriginal.order },
          errors: [{ message: "metadata write failed" }],
        }),
      );
      const compoundArchive = await readVerifiedRecoveryCheckpoint(config);
      const compoundFile = compoundArchive.manifest.files.find(
        (file) =>
          file.path === `project-queue-history/${compoundAdmission.id}.json`,
      );
      assert.ok(compoundFile);
      assert.deepEqual(
        Buffer.from(await compoundArchive.readVerifiedBlob(compoundFile.ref)),
        await readFile(join(history, `${compoundAdmission.id}.json`)),
      );
      assert.equal(compoundAdmission.completed, undefined);
      assert.equal(compoundAdmission.retiredAdmission, undefined);
      assert.deepEqual(compoundAdmission.effects, []);
      const controlOperation = createQueueOperation(config, {
        action: "control",
        scope: "control",
        previousReceiptId: null,
        approval: { kind: "background-setup" },
      });
      controlOperation.metadata = JSON.stringify({
        schemaVersion: 1,
        kind: "control",
        receiptId: controlOperation.id,
        mode: "paused",
        watch: true,
      });
      const controlStep = createProjectQueuePlannedEffect(binding, {
        operationId: controlOperation.id,
        requestId: randomUUID(),
        actorId: 1,
        action: "set-metadata",
        target: { itemId: binding.controlItemId },
        fieldId: binding.metadataFieldId,
        metadata: controlOperation.metadata,
        prior: { target: { itemId: binding.controlItemId, metadata: null } },
        control: { metadata: null },
      });
      const roadmap = createQueueOperation(config, {
        action: "roadmap",
        scope: "roadmap:I_roadmap",
        previousReceiptId: null,
        approval: { kind: "queue-command" },
        objective: 5,
        issueNodeId: "I_roadmap",
        bodyDigest: hash("roadmap body"),
      });
      const roadmapStep = createProjectQueuePlannedEffect(binding, {
        operationId: roadmap.id,
        requestId: randomUUID(),
        actorId: 1,
        action: "ensure-card",
        issueNodeId: roadmap.issueNodeId,
        expectedIssue: {
          issueNodeId: roadmap.issueNodeId,
          objective: roadmap.objective,
          bodyDigest: roadmap.bodyDigest,
        },
        prior: { target: null },
        control: { resultOf: controlStep.requestId },
      });
      const controlPlan = {
        operations: [controlOperation, roadmap],
        effects: [controlStep, roadmapStep],
        deadlineAt: null,
      };
      assert.throws(
        () =>
          createQueueCommand(config, {
            ...controlPlan,
            effects: [roadmapStep, controlStep],
          }),
        /declared earlier control original/,
      );
      const controlCommand = createQueueCommand(config, controlPlan);
      await admitQueueCommand(config, controlCommand);
      await assert.rejects(
        completeQueueCommand(config, controlCommand),
        /every declared fulfilled original/,
      );
      const groupedHistory = await readQueueHistory(config);
      assert.equal(nextProjectQueueOrder(groupedHistory), 18);
      assert.equal(
        groupedHistory.find((row) => row.id === admission.id).retiredAdmission,
        undefined,
      );
      // Unknown legacy effects and grouped recipes cannot be silently reclassified
      // as the narrowly authorized, two-response legacy admission disposition.
      assert.throws(
        () => acquireInstallationLock(repository, 4),
        /already owns Objective #1/,
      );
      releaseControllerLock(objectiveLockPath(repository, 1), lock);
      lockReleased = true;
      const maintenanceLock = acquireInstallationLock(repository, 4);
      try {
        await assert.rejects(
          retireUnknownProjectAdmission(
            config,
            {},
            4,
            {},
            "Fixture",
            maintenanceLock,
          ),
          /Explicit unknown.*evidence/,
        );
        await assert.rejects(
          retireUnknownProjectAdmission(
            { ...config, planning: { kind: "unsupported" } },
            {},
            4,
            {},
            "Fixture",
            maintenanceLock,
          ),
          /unknown provider resource protocols/,
        );
        await assert.rejects(
          retireUnknownProjectAdmission(config, {}, 4, {}, "Fixture", {
            ...maintenanceLock,
            token: "foreign",
          }),
          /exclusive stopped installation lease/,
        );
      } finally {
        releaseControllerLock(
          installationLockPath(repository),
          maintenanceLock,
        );
      }
      // Exercise the real stopped-controller entry and its error settlement.
      // These deliberately incomplete descriptors claim no operator observation,
      // provider response or permission to retire any of the preserved intents.
      const configPath = join(directory, "maintenance-config.json"),
        configBytes = Buffer.from(JSON.stringify(config)),
        refusedProofPath = join(directory, "not-an-operator-proof.json"),
        refusedProofBytes = Buffer.from("{}\n");
      await writeFile(configPath, configBytes, { mode: 0o600 });
      await writeFile(refusedProofPath, refusedProofBytes, { mode: 0o600 });
      const refusedOriginal = {
        path: refusedProofPath,
        sha256: hash(refusedProofBytes),
        bytes: refusedProofBytes.length,
      };
      const refusedEvidence = {
        schemaVersion: 1,
        kind: "operator-retired-admission-unknown",
        operationId: randomUUID(),
        originalInstallation: {
          cli: process.execPath,
          configPath,
          configSha256: hash(configBytes),
          ownFileInventory: refusedOriginal,
        },
        originals: Object.fromEntries(
          [
            "ownerObservation",
            "installedPlan",
            "callerFailure",
            "sourceProtocolReview",
            "physicalClosure",
          ].map((name) => [name, refusedOriginal]),
        ),
      };
      const maintenanceOffset = (await readFile(diagnosticPath(repository, 0)))
        .length;
      // An actual rewritten retained original makes error settlement durable;
      // the old unknown intent itself remains byte-for-byte unchanged.
      await writeFile(join(history, `${operationId}.json`), unknownBytes);
      markCheckpointDirty(repository, {
        path: `project-queue-history/${operationId}.json`,
        kind: "historical",
      });
      observingMaintenance = true;
      try {
        await assert.rejects(
          controlObjective(
            config,
            {
              objective: 4,
              action: "handoff",
              input: {
                actor: "Fixture",
                retiredAdmissionEvidence: refusedEvidence,
              },
            },
            {},
          ),
          /Other partial effects or active owners remain held/,
        );
      } finally {
        observingMaintenance = false;
      }
      assert(maintenanceBuildOwners.length > 0);
      assert(
        maintenanceBuildOwners.every(
          (owner) => owner?.pid === process.pid && owner.objective === 4,
        ),
        "terminal error settlement retains the exclusive installation lease",
      );
      const maintenanceEvents = (await readFile(diagnosticPath(repository, 0)))
        .subarray(maintenanceOffset)
        .toString("utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const maintenanceReads = maintenanceEvents.filter(
        (event) =>
          event.operation === "recovery-checkpoint-verify" &&
          event.outcome === "started",
      );
      assert(maintenanceReads.length >= 2);
      assert(maintenanceReads.every((event) => event.metadata.owned === true));
      assert.equal(maintenanceReads[0].metadata.objectsRetained, false);
      assert(
        maintenanceReads
          .slice(1)
          .every((event) => event.metadata.objectsRetained),
        "terminal error settlement reuses the same authenticated verifier",
      );
      assert.equal(existsSync(installationLockPath(repository)), false);
      // The normal compiled CLI delegates this complete guarded controller;
      // rejection must not trigger an unowned, duplicate cold synchronization.
      const evidencePath = join(directory, "refused-maintenance-evidence.json");
      await writeFile(evidencePath, JSON.stringify(refusedEvidence), {
        mode: 0o600,
      });
      const cliOffset = (await readFile(diagnosticPath(repository, 0))).length;
      assert.throws(
        () =>
          execFileSync(
            process.execPath,
            [
              new URL("../dist/cli.js", import.meta.url).pathname,
              "handoff",
              "--objective",
              "4",
              "--retired-admission-evidence",
              evidencePath,
              "--config",
              configPath,
            ],
            { env: process.env, encoding: "utf8", timeout: 30_000 },
          ),
        (error) =>
          error.status === 1 &&
          /Other partial effects or active owners remain held/.test(
            error.stderr,
          ),
      );
      const cliReads = (await readFile(diagnosticPath(repository, 0)))
        .subarray(cliOffset)
        .toString("utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter(
          (event) =>
            event.operation === "recovery-checkpoint-verify" &&
            event.outcome === "started",
        );
      assert(cliReads.length > 0);
      assert(
        cliReads.every((event) => event.metadata.owned === true),
        "CLI error propagation never reopens an unowned verifier",
      );
      assert.equal(existsSync(installationLockPath(repository)), false);

      assert.deepEqual(
        await readFile(join(history, `${operationId}.json`)),
        unknownBytes,
      );
      assert.equal(
        (await readQueueHistory(config)).find((row) => row.id === admission.id)
          .completed,
        undefined,
      );
    });
  } finally {
    if (!lockReleased)
      releaseControllerLock(objectiveLockPath(repository, 1), lock);
    await rm(directory, { recursive: true, force: true });
    await rm(stateRoot(repository), { recursive: true, force: true });
  }
});

test("archive publication waits for a real publisher beyond one second and preserves cancellation and dead-owner reclamation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-publication-lock-"));
  const guard = join(directory, ".publication.guard");
  let other;
  try {
    other = await holder(guard, "exclusive", true);
    let entered = false;
    const waiting = withCheckpointPublication(guard, async () => {
      entered = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 1300));
    assert.equal(entered, false);
    await other.release();
    other = undefined;
    await waiting;
    assert.equal(entered, true);

    other = await holder(guard, "exclusive", true);
    const controller = new AbortController();
    const cancelled = withProcessCancellation(controller.signal, () =>
      withCheckpointPublication(guard, async () =>
        assert.fail("aborted waiter ran"),
      ),
    );
    const refusal = assert.rejects(cancelled, /original cancellation/);
    controller.abort(new Error("original cancellation"));
    await refusal;
    await other.release();
    other = undefined;

    const alreadyAborted = AbortSignal.abort(new Error("already aborted"));
    await assert.rejects(
      withRegistryFiles(guard, "exclusive", alreadyAborted, async () =>
        assert.fail("already aborted free-lock callback ran"),
      ),
      /already aborted/,
    );
    await assert.rejects(
      withProcessCancellation(alreadyAborted, () =>
        withCheckpointPublication(guard, async () =>
          assert.fail("already aborted publisher ran"),
        ),
      ),
      /already aborted/,
    );
    for (const operation of [
      () =>
        withCheckpointPublication(guard, async () =>
          assert.fail("expired publisher ran"),
        ),
      () =>
        subprocessAsync(process.execPath, [
          "-e",
          "process.stdout.write('expired child ran')",
        ]),
    ]) {
      const deadlineAt = new Date(Date.now() + 10).toISOString();
      await assert.rejects(
        withProcessCancellation(
          AbortSignal.timeout(10),
          async () => {
            // The original timer cannot fire while this actual synchronous work
            // blocks the event loop. The absolute armed deadline still applies.
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
            return operation();
          },
          undefined,
          deadlineAt,
        ),
        /original process deadline elapsed/,
      );
    }

    other = await holder(guard, "exclusive", true);
    await other.kill();
    other = undefined;
    await withCheckpointPublication(guard, async () => undefined);

    other = await holder(guard, "exclusive", "legacy");
    await assert.rejects(
      withCheckpointPublication(guard, async () =>
        assert.fail("live legacy publisher ignored"),
      ),
      /lock guard .* held by process/,
    );
    await other.release();
    other = undefined;
    await withCheckpointPublication(guard, async () => undefined);
  } finally {
    if (other) await other.kill();
    await rm(directory, { recursive: true, force: true });
  }
});
