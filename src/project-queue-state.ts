import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  type FactoryConfig,
  factoryAuthorityDigest,
  stateRoot,
} from "./config.js";
import { LocalContentStore } from "./content/local.js";
import type {
  ContentRef,
  GitHubGateway,
  ProjectQueueAction,
  ProjectQueueBinding,
  ProjectQueueIntent,
  ProjectQueueSnapshot,
  ProjectQueueWriteReceipt,
} from "./contracts.js";
import {
  assertProjectQueueIntent,
  assertProjectQueueWriteReceipt,
} from "./github-project-queue.js";
import {
  awaitCheckpointAdmission,
  assertRecoveryCheckpointManifest,
  hasPrivateCheckpointScope,
  markCheckpointDirty,
  type RecoveryCheckpointClosure,
  readVerifiedRecoveryCheckpoint,
  type QueueCheckpointWitness,
} from "./recovery-checkpoint.js";
import type { ContinuationState } from "./state.js";
import {
  assertRestoredContinuationReady,
  continuationConfigurationMatches,
  parsePortableContinuation,
  readControllerOwner,
  objectiveLockPath,
  installationLockPath,
  statePath,
  restoredContinuationOwnershipHold,
  type ControllerLock,
} from "./state-store.js";
import { canHandoff } from "./runner/ownership.js";
import { isExecutionState, isPreparationState } from "./state.js";
import { linuxProcessIdentity } from "./process.js";

export const queueDigest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const date = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Project queue receipt");
  return value as Record<string, unknown>;
};
const only = (value: Record<string, unknown>, keys: string[]) => {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error("Unsupported Project queue receipt field");
};

export type QueueMode = "running" | "paused" | "draining";
export type QueueMetadata =
  | {
      schemaVersion: 1;
      kind: "admission";
      admissionId: string;
      receiptId: string;
      state: "queued" | "withdrawn";
    }
  | {
      schemaVersion: 1;
      kind: "control";
      receiptId: string;
      mode: QueueMode;
      watch: boolean;
    };
export function parseQueueMetadata(text: string): QueueMetadata {
  const value = object(JSON.parse(text));
  if (value.schemaVersion !== 1 || !uuid(value.receiptId))
    throw new Error("Invalid Project queue metadata identity");
  if (value.kind === "admission") {
    only(value, ["schemaVersion", "kind", "admissionId", "receiptId", "state"]);
    if (
      !uuid(value.admissionId) ||
      !["queued", "withdrawn"].includes(String(value.state))
    )
      throw new Error("Invalid Project admission metadata");
  } else {
    only(value, ["schemaVersion", "kind", "receiptId", "mode", "watch"]);
    if (
      value.kind !== "control" ||
      !["running", "paused", "draining"].includes(String(value.mode)) ||
      typeof value.watch !== "boolean"
    )
      throw new Error("Invalid Project control metadata");
  }
  return value as unknown as QueueMetadata;
}
interface QueueEffect {
  intent: ProjectQueueIntent;
  receipt?: Omit<ProjectQueueWriteReceipt, "original">;
  original?: ContentRef;
  rejectedOriginal?: ContentRef;
}
export interface QueueOperation {
  schemaVersion: 1;
  kind: "project-queue-operation";
  id: string;
  repository: string;
  binding: ProjectQueueBinding;
  authorityDigest: string;
  at: string;
  action: "admit" | "withdraw" | "control" | "roadmap";
  /** Original explicit local operation; these historical receipts never supply membership. */
  approval: {
    kind: "queue-command" | "background-setup" | "proposal";
    proposalId?: string;
    approvalDigest?: string;
  };
  scope: string;
  previousReceiptId: string | null;
  objective?: number;
  issueNodeId?: string;
  bodyDigest?: string;
  order?: number;
  metadata?: string;
  effects: QueueEffect[];
  completed?: true;
}
export interface QueueOwnerClaim {
  schemaVersion: 1;
  kind: "project-queue-owner";
  id: string;
  repository: string;
  authorityDigest: string;
  admissionId: string;
  receiptId: string;
  objective: number;
  bodyDigest: string;
  ownerTokenDigest: string;
  at: string;
  deadlineAt: string | null;
  priorRunId?: string;
  runBinding?: { schemaVersion: 1; runId: string; initialSnapshot: ContentRef };
  settled?: {
    at: string;
    runId?: string;
    disposition: "quiescent";
    cancellation?: QueueCancellationProof;
    handoff?: QueueStoppedHandoffProof;
  };
}
/** A new recovery owner proves only local cessation of the original stopped planning run. */
export interface QueueStoppedHandoffProof {
  schemaVersion: 1;
  originalClaim: ContentRef;
  stoppedSnapshot: ContentRef;
  configDigest: string;
  owner: { pid: number; startTime: string; tokenDigest: string };
}
function assertStoppedClaimState(state: ContinuationState): void {
  if (
    !isPreparationState(state) ||
    state.cancelRequested ||
    state.cancelledAt ||
    state.planningRecovery?.phase !== "stopped" ||
    !canHandoff(state) ||
    restoredContinuationOwnershipHold(state)
  )
    throw new Error(
      "Project handoff requires the original nonterminal stopped planning run and settled native resources",
    );
  const recovery = state.planningRecovery;
  const receipts = [
    ...(recovery.invocations ?? []),
    ...recovery.history.flatMap((entry) => entry.invocations),
  ];
  if (
    receipts.some((receipt) => !receipt.resultDigest) ||
    (recovery.invocation &&
      !receipts.some(
        (receipt) =>
          receipt.id === recovery.invocation!.id &&
          receipt.phase === recovery.invocation!.phase &&
          receipt.resultDigest,
      ))
  )
    throw new Error(
      "Stopped Project handoff has an unresolved retained planning invocation",
    );
}

export interface QueueCancellationProof {
  schemaVersion: 1;
  originalClaim: ContentRef;
  initialSnapshot: ContentRef;
  cancelledSnapshot: ContentRef;
  configDigest: string;
  owner: { pid: number; startTime: string; tokenDigest: string };
  lineage:
    | { kind: "producer-bound" }
    | {
        kind: "verified-first-run";
        checkpoints: {
          before: QueueCheckpointWitness;
          claimed: QueueCheckpointWitness;
          initial: QueueCheckpointWitness;
        };
      };
}
function sameContentRef(left: ContentRef, right: ContentRef): boolean {
  return (
    left.digest === right.digest &&
    left.bytes === right.bytes &&
    left.mediaType === right.mediaType
  );
}
function sameRunBinding(
  left: QueueOwnerClaim["runBinding"],
  right: QueueOwnerClaim["runBinding"],
): boolean {
  return left === undefined || right === undefined
    ? left === right
    : left.schemaVersion === right.schemaVersion &&
        left.runId === right.runId &&
        sameContentRef(left.initialSnapshot, right.initialSnapshot);
}
/** Retain literal archive originals without treating JSON key order as identity. */
export function retainProjectQueueOriginal(
  store: LocalContentStore,
  reference: ContentRef,
  bytes: Uint8Array,
): ContentRef {
  if (!ref(reference)) throw new Error("Invalid Project original reference");
  const retained = store.putBytes(bytes, { mediaType: reference.mediaType });
  if (!sameContentRef(retained, reference))
    throw new Error("Project original retention differs");
  return reference;
}
type QueueRecord = QueueOperation | QueueOwnerClaim;
const ref = (value: unknown): value is ContentRef => {
  const row = object(value);
  only(row, ["digest", "bytes", "mediaType"]);
  return (
    digest(row.digest) &&
    Number.isSafeInteger(row.bytes) &&
    Number(row.bytes) >= 0 &&
    row.mediaType === "application/json"
  );
};
export function parseQueueRecord(
  bytes: Uint8Array,
  repository: string,
  id: string,
): QueueRecord {
  const row = object(JSON.parse(Buffer.from(bytes).toString("utf8")));
  if (
    row.schemaVersion !== 1 ||
    row.repository !== repository ||
    row.id !== id ||
    !uuid(row.id) ||
    !digest(row.authorityDigest) ||
    !date(row.at)
  )
    throw new Error("Project queue history binding differs");
  if (row.kind === "project-queue-owner") {
    only(row, [
      "schemaVersion",
      "kind",
      "id",
      "repository",
      "authorityDigest",
      "admissionId",
      "receiptId",
      "objective",
      "bodyDigest",
      "ownerTokenDigest",
      "at",
      "deadlineAt",
      "priorRunId",
      "runBinding",
      "settled",
    ]);
    if (
      !uuid(row.admissionId) ||
      !uuid(row.receiptId) ||
      !digest(row.bodyDigest) ||
      !digest(row.ownerTokenDigest) ||
      !Number.isSafeInteger(row.objective) ||
      Number(row.objective) < 1 ||
      !(row.deadlineAt === null || date(row.deadlineAt)) ||
      (row.priorRunId !== undefined && !uuid(row.priorRunId))
    )
      throw new Error("Invalid Project queue owner identity");
    if (row.runBinding !== undefined) {
      const binding = object(row.runBinding);
      only(binding, ["schemaVersion", "runId", "initialSnapshot"]);
      if (
        binding.schemaVersion !== 1 ||
        !uuid(binding.runId) ||
        !ref(binding.initialSnapshot)
      )
        throw new Error("Invalid immutable Project run binding");
    }
    if (row.settled !== undefined) {
      const settled = object(row.settled);
      only(settled, ["at", "runId", "disposition", "cancellation", "handoff"]);
      if (
        !date(settled.at) ||
        settled.disposition !== "quiescent" ||
        (settled.runId !== undefined && !uuid(settled.runId))
      )
        throw new Error("Invalid Project queue owner settlement");
      if (settled.handoff !== undefined) {
        const proof = object(settled.handoff);
        only(proof, [
          "schemaVersion",
          "originalClaim",
          "stoppedSnapshot",
          "configDigest",
          "owner",
        ]);
        const owner = object(proof.owner);
        only(owner, ["pid", "startTime", "tokenDigest"]);
        if (
          settled.cancellation !== undefined ||
          !row.runBinding ||
          proof.schemaVersion !== 1 ||
          !uuid(settled.runId) ||
          !ref(proof.originalClaim) ||
          !ref(proof.stoppedSnapshot) ||
          !digest(proof.configDigest) ||
          !Number.isSafeInteger(owner.pid) ||
          Number(owner.pid) < 1 ||
          typeof owner.startTime !== "string" ||
          !owner.startTime ||
          !digest(owner.tokenDigest)
        )
          throw new Error("Invalid attributable stopped Project handoff proof");
      }
      if (settled.cancellation !== undefined) {
        const proof = object(settled.cancellation);
        only(proof, [
          "schemaVersion",
          "originalClaim",
          "initialSnapshot",
          "cancelledSnapshot",
          "configDigest",
          "owner",
          "lineage",
        ]);
        const owner = object(proof.owner);
        only(owner, ["pid", "startTime", "tokenDigest"]);
        const lineage = object(proof.lineage);
        only(
          lineage,
          lineage.kind === "verified-first-run"
            ? ["kind", "checkpoints"]
            : ["kind"],
        );
        if (
          proof.schemaVersion !== 1 ||
          !uuid(settled.runId) ||
          !ref(proof.originalClaim) ||
          !ref(proof.initialSnapshot) ||
          !ref(proof.cancelledSnapshot) ||
          !digest(proof.configDigest) ||
          !Number.isSafeInteger(owner.pid) ||
          Number(owner.pid) < 1 ||
          typeof owner.startTime !== "string" ||
          !owner.startTime ||
          !digest(owner.tokenDigest) ||
          !["producer-bound", "verified-first-run"].includes(
            String(lineage.kind),
          )
        )
          throw new Error("Invalid attributable Project cancellation proof");
        if (lineage.kind === "verified-first-run") {
          const witnesses = object(lineage.checkpoints);
          only(witnesses, ["before", "claimed", "initial"]);
          for (const name of ["before", "claimed", "initial"]) {
            const witness = object(witnesses[name]);
            only(witness, ["commitSha", "manifest"]);
            if (
              typeof witness.commitSha !== "string" ||
              !/^[a-f0-9]{40,64}$/.test(witness.commitSha) ||
              !ref(witness.manifest)
            )
              throw new Error(
                "Invalid historical Project cancellation witness",
              );
          }
        }
      }
    }
  } else {
    only(row, [
      "schemaVersion",
      "kind",
      "id",
      "repository",
      "binding",
      "authorityDigest",
      "at",
      "action",
      "approval",
      "scope",
      "previousReceiptId",
      "objective",
      "issueNodeId",
      "bodyDigest",
      "order",
      "metadata",
      "effects",
      "completed",
    ]);
    if (
      row.kind !== "project-queue-operation" ||
      !["admit", "withdraw", "control", "roadmap"].includes(
        String(row.action),
      ) ||
      typeof row.scope !== "string" ||
      !(row.previousReceiptId === null || uuid(row.previousReceiptId)) ||
      !Array.isArray(row.effects) ||
      row.effects.length > 3 ||
      (row.completed !== undefined && row.completed !== true)
    )
      throw new Error("Invalid Project queue operation");
    const binding = object(row.binding);
    only(binding, [
      "repository",
      "projectId",
      "metadataFieldId",
      "orderFieldId",
      "controlItemId",
      "factoryManagedFields",
    ]);
    if (
      binding.repository !== repository ||
      binding.factoryManagedFields !== true ||
      ["projectId", "metadataFieldId", "orderFieldId", "controlItemId"].some(
        (key) =>
          typeof binding[key] !== "string" ||
          !/^[A-Za-z0-9_-]{1,256}$/.test(String(binding[key])),
      )
    )
      throw new Error("Invalid Project queue field binding");
    const approval = object(row.approval);
    only(approval, ["kind", "proposalId", "approvalDigest"]);
    if (
      !["queue-command", "background-setup", "proposal"].includes(
        String(approval.kind),
      ) ||
      (approval.kind === "proposal" &&
        (!uuid(approval.proposalId) || !digest(approval.approvalDigest)))
    )
      throw new Error("Invalid Project queue approval provenance");
    if (
      row.action !== "control" &&
      (!Number.isSafeInteger(row.objective) ||
        Number(row.objective) < 1 ||
        typeof row.issueNodeId !== "string" ||
        !digest(row.bodyDigest))
    )
      throw new Error("Invalid Project queue Objective binding");
    if (
      row.order !== undefined &&
      (!Number.isSafeInteger(row.order) || Number(row.order) < 1)
    )
      throw new Error("Invalid Project queue order binding");
    if (row.metadata !== undefined) {
      if (
        typeof row.metadata !== "string" ||
        parseQueueMetadata(row.metadata).receiptId !== id
      )
        throw new Error("Project queue metadata differs from producer receipt");
    }
    const seen = new Set<string>();
    for (const raw of row.effects) {
      const effect = object(raw);
      only(effect, ["intent", "receipt", "original", "rejectedOriginal"]);
      assertProjectQueueIntent(effect.intent);
      const intent = effect.intent as ProjectQueueIntent;
      if (
        JSON.stringify(intent.binding) !== JSON.stringify(binding) ||
        seen.has(intent.requestId)
      )
        throw new Error("Project queue effect differs from operation");
      seen.add(intent.requestId);
      if (effect.original !== undefined && !ref(effect.original))
        throw new Error("Invalid Project queue original body reference");
      if (
        effect.rejectedOriginal !== undefined &&
        !ref(effect.rejectedOriginal)
      )
        throw new Error("Invalid rejected Project queue original reference");
      if ((effect.receipt === undefined) !== (effect.original === undefined))
        throw new Error("Project queue receipt requires its original response");
      if (
        effect.receipt !== undefined &&
        JSON.stringify(object(effect.receipt).intent) !== JSON.stringify(intent)
      )
        throw new Error("Project queue response intent differs");
    }
    if (
      row.completed &&
      row.effects.some((raw) => object(raw).receipt === undefined)
    )
      throw new Error("Completed Project queue operation has unknown effects");
  }
  return row as unknown as QueueRecord;
}
function privateBytes(path: string): Buffer {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.uid !== process.getuid?.() ||
    stat.mode & 0o077 ||
    realpathSync(dirname(path)) !== dirname(path)
  )
    throw new Error(
      "Project queue history must be an owned private regular file",
    );
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
function save(record: QueueRecord): void {
  const directory = join(stateRoot(record.repository), "project-queue-history");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (realpathSync(directory) !== directory)
    throw new Error(
      "Project queue history directory resolves through a symlink",
    );
  const path = join(directory, `${record.id}.json`);
  parseQueueRecord(
    Buffer.from(JSON.stringify(record)),
    record.repository,
    record.id,
  );
  if (existsSync(path)) {
    const previous = parseQueueRecord(
      privateBytes(path),
      record.repository,
      record.id,
    );
    if (previous.kind !== record.kind)
      throw new Error("Project receipt identity cannot change its role");
    if (
      previous.kind === "project-queue-operation" &&
      record.kind === "project-queue-operation"
    ) {
      const {
        effects: oldEffects,
        completed: oldCompleted,
        ...oldBinding
      } = previous;
      const {
        effects: newEffects,
        completed: newCompleted,
        ...newBinding
      } = record;
      if (
        JSON.stringify(oldBinding) !== JSON.stringify(newBinding) ||
        (oldCompleted && !newCompleted) ||
        newEffects.length < oldEffects.length
      )
        throw new Error(
          "Original Project admission and effect history are immutable",
        );
      for (const [index, oldEffect] of oldEffects.entries()) {
        const next = newEffects[index]!;
        if (
          JSON.stringify(oldEffect.intent) !== JSON.stringify(next.intent) ||
          (oldEffect.receipt &&
            JSON.stringify(oldEffect.receipt) !==
              JSON.stringify(next.receipt)) ||
          (oldEffect.original &&
            JSON.stringify(oldEffect.original) !==
              JSON.stringify(next.original)) ||
          (oldEffect.rejectedOriginal &&
            JSON.stringify(oldEffect.rejectedOriginal) !==
              JSON.stringify(next.rejectedOriginal))
        )
          throw new Error(
            "Original Project mutation intent/response cannot be replaced",
          );
      }
    } else if (
      previous.kind === "project-queue-owner" &&
      record.kind === "project-queue-owner"
    ) {
      const {
        settled: oldSettled,
        runBinding: oldRun,
        ...oldBinding
      } = previous;
      const { settled: newSettled, runBinding: newRun, ...newBinding } = record;
      if (
        JSON.stringify(oldBinding) !== JSON.stringify(newBinding) ||
        (oldRun && !sameRunBinding(oldRun, newRun)) ||
        (oldSettled &&
          JSON.stringify(oldSettled) !== JSON.stringify(newSettled))
      )
        throw new Error(
          "Original Project owner claim and settlement are immutable",
        );
    }
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(record)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  const parent = openSync(directory, constants.O_RDONLY);
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
  markCheckpointDirty(record.repository, {
    path,
    kind: "project-queue-receipt",
  });
}
function queueOwnerReferences(record: QueueOwnerClaim): ContentRef[] {
  const refs = [
    ...(record.runBinding ? [record.runBinding.initialSnapshot] : []),
  ];
  const proof = record.settled?.cancellation;
  if (proof) {
    refs.push(
      proof.originalClaim,
      proof.initialSnapshot,
      proof.cancelledSnapshot,
    );
    if (proof.lineage.kind === "verified-first-run")
      refs.push(
        ...Object.values(proof.lineage.checkpoints).map(
          (witness) => witness.manifest,
        ),
      );
  }
  if (record.settled?.handoff)
    refs.push(
      record.settled.handoff.originalClaim,
      record.settled.handoff.stoppedSnapshot,
    );
  const distinct = new Map<string, ContentRef>();
  for (const reference of refs) {
    const previous = distinct.get(reference.digest);
    if (previous && !sameContentRef(previous, reference))
      throw new Error("Project ownership reference binding differs");
    distinct.set(reference.digest, reference);
  }
  return [...distinct.values()];
}
function assertQueueOwnerReferenceBodies(
  record: QueueOwnerClaim,
  readReference: (ref: ContentRef) => Uint8Array,
): ContentRef[] {
  parseQueueRecord(
    Buffer.from(JSON.stringify(record)),
    record.repository,
    record.id,
  );
  const bytes = (ref: ContentRef) => {
    const data = Buffer.from(readReference(ref));
    if (
      data.length !== ref.bytes ||
      createHash("sha256").update(data).digest("hex") !== ref.digest
    )
      throw new Error("Project ownership original bytes differ");
    return data;
  };
  const json = (ref: ContentRef) =>
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes(ref)));
  const snapshot = (ref: ContentRef) =>
    parsePortableContinuation(json(ref), record.repository, record.objective);
  const matches = (state: ContinuationState, runId: string) => {
    if (
      state.runId !== runId ||
      state.objectiveBodyDigest !== record.bodyDigest ||
      (state.coordinator?.deadlineAt ?? null) !== record.deadlineAt ||
      (record.priorRunId !== undefined && record.priorRunId !== runId)
    )
      throw new Error(
        "Project claim differs from its original run/body/deadline",
      );
  };
  if (record.runBinding)
    matches(
      snapshot(record.runBinding.initialSnapshot),
      record.runBinding.runId,
    );
  if (record.settled?.handoff) {
    const proof = record.settled.handoff;
    const original = parseQueueRecord(
      bytes(proof.originalClaim),
      record.repository,
      record.id,
    );
    const { settled: _settled, ...binding } = record;
    if (
      original.kind !== "project-queue-owner" ||
      original.settled ||
      !original.runBinding ||
      JSON.stringify(binding) !== JSON.stringify(original) ||
      original.runBinding.runId !== record.settled.runId
    )
      throw new Error(
        "Stopped handoff differs from its original producer-bound Project claim",
      );
    const initial = snapshot(original.runBinding.initialSnapshot);
    const stopped = snapshot(proof.stoppedSnapshot);
    matches(initial, original.runBinding.runId);
    matches(stopped, original.runBinding.runId);
    if (
      initial.configDigest !== proof.configDigest ||
      stopped.configDigest !== proof.configDigest
    )
      throw new Error(
        "Stopped handoff configuration differs from its original run",
      );
    assertStoppedClaimState(stopped);
  }
  const proof = record.settled?.cancellation;
  if (proof) {
    const original = parseQueueRecord(
      bytes(proof.originalClaim),
      record.repository,
      record.id,
    );
    if (original.kind !== "project-queue-owner" || original.settled)
      throw new Error(
        "Cancellation requires the original unfinished Project claim",
      );
    const { settled: ignored, runBinding: run, ...binding } = record;
    const {
      settled: originalIgnored,
      runBinding: originalRun,
      ...originalBinding
    } = original;
    if (JSON.stringify(binding) !== JSON.stringify(originalBinding))
      throw new Error("Cancellation cannot rewrite the original Project claim");
    const initial = snapshot(proof.initialSnapshot);
    const terminal = snapshot(proof.cancelledSnapshot);
    matches(initial, record.settled!.runId!);
    matches(terminal, record.settled!.runId!);
    if (
      initial.configDigest !== proof.configDigest ||
      terminal.configDigest !== proof.configDigest ||
      !terminal.cancelledAt ||
      !terminal.cancelRequested ||
      Date.parse(record.settled!.at) < Date.parse(terminal.cancelledAt) ||
      (isExecutionState(terminal) && terminal.finalAcceptance) ||
      !canHandoff(terminal) ||
      restoredContinuationOwnershipHold(terminal)
    )
      throw new Error(
        "Project cancellation has no authenticated terminal quiescent continuation",
      );
    if (proof.lineage.kind === "producer-bound") {
      if (
        !run ||
        !originalRun ||
        run.runId !== record.settled!.runId ||
        !sameRunBinding(run, originalRun) ||
        !sameContentRef(run.initialSnapshot, proof.initialSnapshot)
      )
        throw new Error(
          "Cancellation differs from the producer-bound Project run",
        );
    } else {
      if (
        record.deadlineAt === null ||
        original.priorRunId ||
        original.runBinding ||
        !initial.coordinator?.phaseStartedAt ||
        Date.parse(initial.coordinator.phaseStartedAt) <
          Date.parse(record.at) ||
        Date.parse(initial.coordinator.phaseStartedAt) >
          Date.parse(record.deadlineAt)
      )
        throw new Error("Historical first-run Project provenance is ambiguous");
      const { checkpoints } = proof.lineage;
      const manifests = Object.fromEntries(
        Object.entries(checkpoints).map(([key, witness]) => [
          key,
          json(witness.manifest),
        ]),
      );
      for (const manifest of Object.values(manifests)) {
        assertRecoveryCheckpointManifest(manifest, manifests.initial.binding, {
          maxBytes: Number.MAX_SAFE_INTEGER,
          maxFiles: Number.MAX_SAFE_INTEGER,
        });
        if (
          manifest.binding.repository !== record.repository ||
          manifest.binding.scope !== "private-history" ||
          manifest.binding.visibility !== "private"
        )
          throw new Error(
            "Historical cancellation witnesses have invalid private binding",
          );
      }
      const claimPath = `project-queue-history/${record.id}.json`;
      const statePaths = [
        `objectives/${record.objective}/state.json`,
        `objectives/${record.objective}/pre-state.json`,
      ];
      const claimedRef = manifests.claimed.files.find(
        (file: { path: string }) => file.path === claimPath,
      )?.ref;
      const initialClaimRef = manifests.initial.files.find(
        (file: { path: string }) => file.path === claimPath,
      )?.ref;
      const initialStateRef = manifests.initial.files.find(
        (file: { path: string }) => statePaths.includes(file.path),
      )?.ref;
      if (
        manifests.before.files.some(
          (file: { path: string }) =>
            file.path === claimPath || statePaths.includes(file.path),
        ) ||
        !claimedRef ||
        !sameContentRef(claimedRef, proof.originalClaim) ||
        !initialClaimRef ||
        !sameContentRef(initialClaimRef, proof.originalClaim) ||
        !initialStateRef ||
        !sameContentRef(initialStateRef, proof.initialSnapshot) ||
        !(
          manifests.before.sequence < manifests.claimed.sequence &&
          manifests.claimed.sequence <= manifests.initial.sequence
        ) ||
        manifests.initial.authority?.configDigest !== proof.configDigest ||
        manifests.initial.authority?.authorityDigest !==
          record.authorityDigest ||
        manifests.claimed.authority?.configDigest !== proof.configDigest ||
        manifests.claimed.authority?.authorityDigest !==
          record.authorityDigest ||
        Date.parse(manifests.before.createdAt) > Date.parse(record.at) ||
        Date.parse(manifests.claimed.createdAt) < Date.parse(record.at) ||
        Date.parse(manifests.initial.createdAt) <
          Date.parse(initial.coordinator.phaseStartedAt)
      )
        throw new Error(
          "Historical cancellation witnesses differ from original claim/run cohort",
        );
    }
  }
  const refs = queueOwnerReferences(record);
  for (const reference of refs) bytes(reference);
  return refs;
}
export async function authenticateQueueOwnerReferences(
  record: QueueOwnerClaim,
  readReference: (ref: ContentRef) => Promise<Uint8Array> | Uint8Array,
): Promise<ContentRef[]> {
  const refs = queueOwnerReferences(record);
  const bodies = new Map<string, Uint8Array>();
  for (const reference of refs)
    bodies.set(reference.digest, await readReference(reference));
  return assertQueueOwnerReferenceBodies(record, (reference) => {
    const bytes = bodies.get(reference.digest);
    if (!bytes) throw new Error("Project ownership original is unavailable");
    return bytes;
  });
}
export function projectQueuePersistenceClosure(
  config: FactoryConfig,
  root = stateRoot(config.repository),
): RecoveryCheckpointClosure {
  const directory = join(root, "project-queue-history");
  const store = new LocalContentStore(join(root, "content"));
  const closure: RecoveryCheckpointClosure = {
    files: [],
    contentRefs: [],
    gaps: [],
  };
  for (const name of existsSync(directory)
    ? readdirSync(directory).sort()
    : []) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name))
      throw new Error("Unrecognized Project queue history file");
    const bytes = privateBytes(join(directory, name));
    const record = parseQueueRecord(
      bytes,
      config.repository,
      name.slice(0, -5),
    );
    const body = store.putBytes(bytes, { mediaType: "application/json" });
    closure.files.push({
      kind: "historical",
      path: `project-queue-history/${name}`,
      ref: body,
      visibility: "private",
    });
    closure.contentRefs.push(body);
    if (record.kind === "project-queue-owner")
      closure.contentRefs.push(
        ...assertQueueOwnerReferenceBodies(record, (reference) =>
          store.readBytes(reference),
        ),
      );
    if (record.kind === "project-queue-operation")
      for (const effect of record.effects) {
        if (effect.original) {
          assertProjectQueueWriteReceipt({
            ...effect.receipt,
            original: JSON.parse(
              store.readBytes(effect.original).toString("utf8"),
            ),
          });
          closure.contentRefs.push(effect.original);
        }
        if (effect.rejectedOriginal) {
          store.readBytes(effect.rejectedOriginal);
          closure.contentRefs.push(effect.rejectedOriginal);
        }
      }
  }
  return closure;
}
export function requireProjectQueueEffects(
  config: FactoryConfig,
): ProjectQueueBinding {
  const binding = config.queue?.project;
  if (!binding)
    throw new Error(
      "Queue operations require an explicitly bound Project; run Factory setup with its existing queue fields and control card",
    );
  if (
    config.gitPersistence?.scope !== "private-history" ||
    !hasPrivateCheckpointScope()
  )
    throw new Error(
      "Project queue mutation and dispatch require the configured private-history Git checkpoint scope",
    );
  return binding;
}
export async function readQueueHistory(
  config: FactoryConfig,
): Promise<QueueRecord[]> {
  if (config.gitPersistence?.scope !== "private-history")
    throw new Error(
      "Authenticated Project queue receipts require private-history Git persistence",
    );
  const archive = await readVerifiedRecoveryCheckpoint(config);
  const records: QueueRecord[] = [];
  for (const file of archive.manifest.files) {
    const match = /^project-queue-history\/([a-f0-9-]{36})\.json$/.exec(
      file.path,
    );
    if (!match) continue;
    if (file.visibility !== "private" || file.kind !== "historical")
      throw new Error("Project queue receipt has an invalid archive scope");
    const record = parseQueueRecord(
      await archive.readVerifiedBlob(file.ref),
      config.repository,
      match[1]!,
    );
    if (record.kind === "project-queue-operation")
      for (const effect of record.effects)
        if (effect.original) {
          assertProjectQueueWriteReceipt({
            ...effect.receipt,
            original: JSON.parse(
              Buffer.from(
                await archive.readVerifiedBlob(effect.original),
              ).toString("utf8"),
            ),
          });
        }
    if (record.kind === "project-queue-owner")
      await authenticateQueueOwnerReferences(record, (reference) =>
        archive.readVerifiedBlob(reference),
      );
    if (records.some((previous) => previous.id === record.id))
      throw new Error("Duplicate archived Project queue receipt");
    records.push(record);
  }
  return records;
}
export interface VerifiedQueueEntry {
  objective: number;
  itemId: string;
  issueNodeId: string;
  admissionId: string;
  receiptId: string;
  bodyDigest: string;
  authorityDigest: string;
  order: number;
  state: "queued" | "withdrawn";
}
export interface VerifiedQueueObservation {
  snapshot: ProjectQueueSnapshot;
  history: QueueRecord[];
  control: Extract<QueueMetadata, { kind: "control" }>;
  entries: VerifiedQueueEntry[];
}
function producer(
  config: FactoryConfig,
  history: QueueRecord[],
  text: string,
  scope: string,
  itemId: string,
  historical = false,
): QueueOperation {
  const metadata = parseQueueMetadata(text);
  const record = history.find(
    (entry): entry is QueueOperation =>
      entry.kind === "project-queue-operation" &&
      entry.id === metadata.receiptId,
  );
  if (
    !record ||
    !record.completed ||
    record.scope !== scope ||
    record.metadata !== text ||
    (!historical &&
      record.authorityDigest !== factoryAuthorityDigest(config)) ||
    JSON.stringify(record.binding) !== JSON.stringify(config.queue?.project)
  )
    throw new Error(
      "Project queue metadata lacks its exact authenticated explicit producer receipt",
    );
  if (
    history.some(
      (entry) =>
        entry.kind === "project-queue-operation" &&
        entry.scope === scope &&
        entry.previousReceiptId === record.id,
    )
  )
    throw new Error(
      "Project queue metadata was superseded or has an unresolved successor",
    );
  const last = record.effects.at(-1);
  if (
    last?.intent.action !== "set-metadata" ||
    last.intent.itemId !== itemId ||
    last.intent.metadata !== text ||
    last.receipt?.kind !== "response"
  )
    throw new Error(
      "Project queue metadata has no exact original field-update receipt",
    );
  if (
    metadata.kind === "control"
      ? record.action !== "control"
      : record.action !== (metadata.state === "queued" ? "admit" : "withdraw")
  )
    throw new Error(
      "Project metadata role differs from its explicit original action",
    );
  return record;
}
export function verifyQueueObservation(
  config: FactoryConfig,
  snapshot: ProjectQueueSnapshot,
  history: QueueRecord[],
  historical = false,
): VerifiedQueueObservation {
  if (
    JSON.stringify(snapshot.binding) !==
      JSON.stringify(config.queue?.project) ||
    snapshot.control.metadata === null
  )
    throw new Error(
      "Project queue control metadata is missing or differs from its binding",
    );
  producer(
    config,
    history,
    snapshot.control.metadata,
    "control",
    snapshot.control.itemId,
    historical,
  );
  const control = parseQueueMetadata(snapshot.control.metadata);
  if (control.kind !== "control")
    throw new Error("Project control card contains admission metadata");
  const entries: VerifiedQueueEntry[] = [];
  for (const card of snapshot.cards) {
    if (card.archived) continue;
    if (card.metadata === null) continue;
    const metadata = parseQueueMetadata(card.metadata);
    const operation = producer(
      config,
      history,
      card.metadata,
      card.issueNodeId,
      card.itemId,
      historical ||
        (metadata.kind === "admission" && metadata.state === "withdrawn"),
    );
    if (
      metadata.kind !== "admission" ||
      operation.objective !== card.objective ||
      operation.issueNodeId !== card.issueNodeId ||
      operation.order !== card.order ||
      card.repository !== config.repository ||
      !Number.isSafeInteger(card.order) ||
      Number(card.order) < 1
    )
      throw new Error(
        "Project queue card/order differs from original admission",
      );
    entries.push({
      objective: card.objective,
      itemId: card.itemId,
      issueNodeId: card.issueNodeId,
      admissionId: metadata.admissionId,
      receiptId: metadata.receiptId,
      bodyDigest: operation.bodyDigest!,
      authorityDigest: operation.authorityDigest,
      order: card.order!,
      state: metadata.state,
    });
  }
  if (
    new Set(entries.map((entry) => entry.objective)).size !== entries.length ||
    new Set(entries.map((entry) => entry.order)).size !== entries.length ||
    new Set(entries.map((entry) => entry.admissionId)).size !== entries.length
  )
    throw new Error("Project queue has duplicate admission/order bindings");
  // An unknown operation can have failed before its metadata reached any card.
  if (
    history.some(
      (entry) =>
        entry.kind === "project-queue-operation" &&
        !entry.completed &&
        entry.authorityDigest === factoryAuthorityDigest(config),
    )
  )
    throw new Error(
      "A Project queue operation remains partial or unknown; preserve its original receipt and do not replay it",
    );
  return {
    snapshot,
    history,
    control,
    entries: entries.sort((a, b) => a.order - b.order),
  };
}
export async function observeProjectQueue(
  config: FactoryConfig,
  github: GitHubGateway,
  authority: "current" | "explicit-operation" = "current",
): Promise<VerifiedQueueObservation> {
  const binding = config.queue?.project;
  if (!binding || !github.projectQueueRead)
    throw new Error(
      "The configured GitHub gateway cannot read the bound Project queue",
    );
  const snapshot = await github.projectQueueRead(binding);
  return verifyQueueObservation(
    config,
    snapshot,
    await readQueueHistory(config),
    authority === "explicit-operation",
  );
}
export function createQueueOperation(
  config: FactoryConfig,
  fields: Pick<
    QueueOperation,
    "action" | "scope" | "previousReceiptId" | "approval"
  > &
    Partial<
      Pick<QueueOperation, "objective" | "issueNodeId" | "bodyDigest" | "order">
    >,
): QueueOperation {
  return {
    schemaVersion: 1,
    kind: "project-queue-operation",
    id: randomUUID(),
    repository: config.repository,
    binding: requireProjectQueueEffects(config),
    authorityDigest: factoryAuthorityDigest(config),
    at: new Date().toISOString(),
    ...fields,
    effects: [],
  };
}
export async function performQueueEffect(
  config: FactoryConfig,
  github: GitHubGateway,
  operation: QueueOperation,
  action: ProjectQueueAction,
): Promise<ProjectQueueWriteReceipt> {
  requireProjectQueueEffects(config);
  if (
    !github.projectQueueWrite ||
    operation.effects.some((effect) => !effect.receipt)
  )
    throw new Error(
      "Project queue write is unavailable or held by an unknown prior effect",
    );
  const requestId = randomUUID();
  const store = new LocalContentStore(
    join(stateRoot(config.repository), "content"),
  );
  let retained: QueueEffect | undefined;
  try {
    const returned = await github.projectQueueWrite({
      ...action,
      binding: operation.binding,
      requestId,
      beforeWrite: async (intent) => {
        assertProjectQueueIntent(intent);
        if (
          intent.requestId !== requestId ||
          JSON.stringify(intent.binding) !== JSON.stringify(operation.binding)
        )
          throw new Error("Project queue adapter intent differs");
        retained = { intent };
        operation.effects.push(retained);
        save(operation);
        await awaitCheckpointAdmission(config.repository, "before-effect");
      },
    });
    assertProjectQueueWriteReceipt(returned);
    if (returned.kind === "existing-read") {
      if (action.action !== "ensure-card" || retained)
        throw new Error(
          "Existing Project observation cannot settle a submitted effect",
        );
      retained = { intent: returned.intent };
      operation.effects.push(retained);
    }
    if (
      !retained ||
      JSON.stringify(retained.intent) !== JSON.stringify(returned.intent)
    )
      throw new Error("Project queue response differs from retained effect");
    const { original, ...receipt } = returned;
    retained.original = store.putBytes(Buffer.from(JSON.stringify(original)), {
      mediaType: "application/json",
    });
    retained.receipt = receipt;
    save(operation);
    await awaitCheckpointAdmission(config.repository, "explicit");
    return returned;
  } catch (error) {
    if (
      retained &&
      error &&
      typeof error === "object" &&
      "original" in error &&
      error.original !== undefined
    ) {
      retained.rejectedOriginal = store.putBytes(
        Buffer.from(JSON.stringify(error.original)),
        { mediaType: "application/json" },
      );
      save(operation);
    }
    throw error;
  }
}
export async function completeQueueOperation(
  config: FactoryConfig,
  operation: QueueOperation,
): Promise<void> {
  operation.completed = true;
  save(operation);
  await awaitCheckpointAdmission(config.repository, "explicit");
}
export async function claimProjectQueueRun(
  config: FactoryConfig,
  github: GitHubGateway,
  objective: number,
  ownerToken: string,
  snapshot?: ContinuationState,
): Promise<QueueOwnerClaim | undefined> {
  if (!config.queue?.project) return;
  requireProjectQueueEffects(config);
  if (snapshot) assertRestoredContinuationReady(snapshot, config);
  if (snapshot && !continuationConfigurationMatches(snapshot, config))
    throw new Error(
      "Existing execution configuration differs; use supported reconciliation without renewing admission or allowances",
    );
  // Existing archive without this host's verified baseline cannot be overwritten.
  await awaitCheckpointAdmission(config.repository, "explicit");
  const observed = await observeProjectQueue(config, github);
  const entry = observed.entries.find(
    (candidate) =>
      candidate.objective === objective && candidate.state === "queued",
  );
  const card = observed.snapshot.cards.find(
    (candidate) => !candidate.archived && candidate.objective === objective,
  );
  if (
    observed.control.mode !== "running" ||
    !entry ||
    card?.state !== "open" ||
    queueDigest(card.body) !== entry.bodyDigest
  )
    throw new Error(
      `Foreground and queue dispatch require a current open, exact-content approved Project admission and running control; use factory queue add ${objective}, or factory queue resume for an intentionally paused queue`,
    );
  const prior = observed.history.filter(
    (record): record is QueueOwnerClaim =>
      record.kind === "project-queue-owner" && record.objective === objective,
  );
  if (
    observed.history.some(
      (record) => record.kind === "project-queue-owner" && !record.settled,
    )
  )
    throw new Error(
      "This Project admission has an unfinished or foreign owner; supported resource reconciliation is required before dispatch",
    );
  if (
    prior.length &&
    (!snapshot ||
      prior.some(
        (claim) =>
          (claim.settled?.runId ?? claim.priorRunId) !== snapshot.runId,
      ))
  )
    throw new Error(
      "A prior Objective run exists; restore its exact continuation before dispatch, preserving its original results and spent allowances",
    );
  const recorded = prior.at(0)?.deadlineAt;
  if (prior.some((claim) => claim.deadlineAt !== recorded))
    throw new Error("Historical Objective deadlines differ; dispatch is held");
  const deadlineAt =
    recorded !== undefined
      ? recorded
      : snapshot
        ? (snapshot.coordinator?.deadlineAt ?? null)
        : config.queue?.objectiveDeadlineSeconds === undefined
          ? null
          : new Date(
              Date.now() + config.queue.objectiveDeadlineSeconds * 1000,
            ).toISOString();
  if (
    snapshot &&
    recorded !== undefined &&
    recorded !== (snapshot.coordinator?.deadlineAt ?? null)
  )
    throw new Error(
      "Project admission deadline differs from its original continuation",
    );
  if (deadlineAt !== null && Date.parse(deadlineAt) <= Date.now())
    throw new Error(
      "Project admission's frozen deadline elapsed; it cannot be renewed",
    );
  const claim: QueueOwnerClaim = {
    schemaVersion: 1,
    kind: "project-queue-owner",
    id: randomUUID(),
    repository: config.repository,
    authorityDigest: factoryAuthorityDigest(config),
    admissionId: entry.admissionId,
    receiptId: entry.receiptId,
    objective,
    bodyDigest: entry.bodyDigest,
    ownerTokenDigest: queueDigest(ownerToken),
    at: new Date().toISOString(),
    deadlineAt,
    ...(snapshot ? { priorRunId: snapshot.runId } : {}),
  };
  save(claim);
  await awaitCheckpointAdmission(config.repository, "before-effect");
  await assertProjectQueueRunLive(config, github, claim);
  return claim;
}
/** A fresh read can hold an actual owner; it never grants or releases ownership. */
export async function assertProjectQueueRunLive(
  config: FactoryConfig,
  github: GitHubGateway,
  claim: QueueOwnerClaim,
): Promise<void> {
  const observed = await observeProjectQueue(config, github);
  const entry = observed.entries.find(
    (candidate) =>
      candidate.admissionId === claim.admissionId &&
      candidate.receiptId === claim.receiptId &&
      candidate.state === "queued",
  );
  const card =
    entry &&
    observed.snapshot.cards.find(
      (candidate) => candidate.itemId === entry.itemId,
    );
  const retained = observed.history.find(
    (record) => record.kind === "project-queue-owner" && record.id === claim.id,
  );
  if (
    observed.control.mode !== "running" ||
    !entry ||
    card?.state !== "open" ||
    queueDigest(card.body) !== claim.bodyDigest ||
    !retained ||
    retained.kind !== "project-queue-owner" ||
    retained.settled ||
    retained.ownerTokenDigest !== claim.ownerTokenDigest
  )
    throw new Error(
      "The owned Project admission is unavailable, changed, paused or draining; retain its original claim and use supported queue reconciliation",
    );
}
/** Only the actual owning controller calls this after its existing resource check. */
export async function settleProjectQueueRun(
  config: FactoryConfig,
  claim: QueueOwnerClaim,
  ownerToken: string,
  runId?: string,
): Promise<void> {
  if (claim.ownerTokenDigest !== queueDigest(ownerToken) || claim.settled)
    throw new Error(
      "Project admission settlement differs from its actual owner",
    );
  claim.settled = {
    at: new Date().toISOString(),
    disposition: "quiescent",
    ...(runId ? { runId } : {}),
  };
  save(claim);
  await awaitCheckpointAdmission(config.repository, "explicit");
}

/** Freeze the literal first canonical snapshot before the controller admits work. */
export function bindProjectQueueRun(
  config: FactoryConfig,
  claim: QueueOwnerClaim,
  ownerToken: string,
  state: ContinuationState,
): void {
  if (
    claim.settled ||
    claim.ownerTokenDigest !== queueDigest(ownerToken) ||
    state.repository !== config.repository ||
    state.objective !== claim.objective ||
    !continuationConfigurationMatches(state, config) ||
    state.objectiveBodyDigest !== claim.bodyDigest ||
    (state.coordinator?.deadlineAt ?? null) !== claim.deadlineAt ||
    (claim.priorRunId !== undefined && claim.priorRunId !== state.runId)
  )
    throw new Error("Project producer cannot bind a different continuation");
  if (claim.runBinding) {
    if (claim.runBinding.runId !== state.runId)
      throw new Error("Project producer run binding cannot change");
    return;
  }
  const bytes = readFileSync(statePath(config.repository, state.objective));
  const original = parsePortableContinuation(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    config.repository,
    state.objective,
  );
  if (JSON.stringify(original) !== JSON.stringify(state))
    throw new Error(
      "Project producer requires the saved original canonical snapshot",
    );
  const store = new LocalContentStore(
    join(stateRoot(config.repository), "content"),
  );
  claim.runBinding = {
    schemaVersion: 1,
    runId: state.runId,
    initialSnapshot: store.putBytes(bytes, { mediaType: "application/json" }),
  };
  save(claim);
}

/** Neutral stopped-owner handoff; never cancels, resumes or retries the original run. */
export async function settleStoppedProjectQueueRun(
  config: FactoryConfig,
  state: ContinuationState,
  lock: ControllerLock,
): Promise<void> {
  requireProjectQueueEffects(config);
  assertStoppedClaimState(state);
  if (
    state.repository !== config.repository ||
    !continuationConfigurationMatches(state, config)
  )
    throw new Error("Stopped Project handoff configuration differs");
  const lockPath = objectiveLockPath(config.repository, state.objective);
  const assertOwner = () => {
    const identity = linuxProcessIdentity(process.pid);
    const owner = readControllerOwner(lockPath);
    if (
      !identity ||
      !owner ||
      owner.token !== lock.token ||
      owner.pid !== process.pid ||
      owner.startTime !== identity.startTime ||
      owner.objective !== state.objective
    )
      throw new Error(
        "Stopped Project handoff requires its actual exclusive recovery owner",
      );
    return owner;
  };
  assertOwner();
  await awaitCheckpointAdmission(config.repository, "explicit");
  const history = await readQueueHistory(config);
  if (
    history.some(
      (record) =>
        record.kind === "project-queue-operation" && !record.completed,
    )
  )
    throw new Error(
      "Stopped Project handoff cannot settle an unfinished queue mutation",
    );
  const pending = history.filter(
    (record): record is QueueOwnerClaim =>
      record.kind === "project-queue-owner" && !record.settled,
  );
  if (!pending.length) return;
  if (pending.length !== 1 || pending[0]!.objective !== state.objective)
    throw new Error("Stopped Project handoff has competing unfinished claims");
  const claim = pending[0]!;
  const admission = history.find(
    (record): record is QueueOperation =>
      record.kind === "project-queue-operation" &&
      record.id === claim.receiptId,
  );
  const metadata = admission?.metadata
    ? parseQueueMetadata(admission.metadata)
    : undefined;
  const effect = admission?.effects.at(-1);
  if (
    !claim.runBinding ||
    claim.runBinding.runId !== state.runId ||
    claim.authorityDigest !== factoryAuthorityDigest(config) ||
    claim.bodyDigest !== state.objectiveBodyDigest ||
    claim.deadlineAt !== (state.coordinator?.deadlineAt ?? null) ||
    !admission?.completed ||
    admission.action !== "admit" ||
    admission.objective !== state.objective ||
    admission.bodyDigest !== claim.bodyDigest ||
    admission.authorityDigest !== claim.authorityDigest ||
    JSON.stringify(admission.binding) !==
      JSON.stringify(config.queue?.project) ||
    metadata?.kind !== "admission" ||
    metadata.state !== "queued" ||
    metadata.admissionId !== claim.admissionId ||
    metadata.receiptId !== claim.receiptId ||
    effect?.intent.action !== "set-metadata" ||
    effect.intent.metadata !== admission.metadata ||
    effect.receipt?.kind !== "response" ||
    !effect.original
  )
    throw new Error(
      "Stopped handoff differs from its original authenticated Project admission",
    );
  const archive = await readVerifiedRecoveryCheckpoint(config);
  const snapshotFile = archive.manifest.files.find(
    (file) => file.path === `objectives/${state.objective}/state.json`,
  );
  const claimFile = archive.manifest.files.find(
    (file) => file.path === `project-queue-history/${claim.id}.json`,
  );
  if (!snapshotFile || !claimFile)
    throw new Error("Stopped handoff exact archived originals are unavailable");
  const store = new LocalContentStore(
    join(stateRoot(config.repository), "content"),
  );
  for (const reference of [
    snapshotFile.ref,
    claimFile.ref,
    claim.runBinding.initialSnapshot,
  ])
    retainProjectQueueOriginal(
      store,
      reference,
      await archive.readVerifiedBlob(reference),
    );
  const snapshotBytes = store.readBytes(snapshotFile.ref);
  const originalClaimBytes = store.readBytes(claimFile.ref);
  const currentClaimPath = join(
    stateRoot(config.repository),
    "project-queue-history",
    `${claim.id}.json`,
  );
  const owner = assertOwner();
  if (
    !Buffer.from(snapshotBytes).equals(
      readFileSync(statePath(config.repository, state.objective)),
    ) ||
    !Buffer.from(originalClaimBytes).equals(privateBytes(currentClaimPath)) ||
    JSON.stringify(
      parsePortableContinuation(
        JSON.parse(Buffer.from(snapshotBytes).toString("utf8")),
        config.repository,
        state.objective,
      ),
    ) !== JSON.stringify(state)
  )
    throw new Error(
      "Stopped handoff claim or continuation changed during authentication",
    );
  claim.settled = {
    at: new Date().toISOString(),
    runId: state.runId,
    disposition: "quiescent",
    handoff: {
      schemaVersion: 1,
      originalClaim: claimFile.ref,
      stoppedSnapshot: snapshotFile.ref,
      configDigest: state.configDigest,
      owner: {
        pid: owner.pid,
        startTime: owner.startTime,
        tokenDigest: queueDigest(owner.token),
      },
    },
  };
  await authenticateQueueOwnerReferences(claim, (reference) =>
    store.readBytes(reference),
  );
  // Reference authentication above is asynchronous; authenticate the exclusive originals again.
  assertOwner();
  if (
    !Buffer.from(snapshotBytes).equals(
      readFileSync(statePath(config.repository, state.objective)),
    ) ||
    !Buffer.from(originalClaimBytes).equals(privateBytes(currentClaimPath))
  )
    throw new Error("Stopped handoff originals changed before settlement");
  save(claim);
  await awaitCheckpointAdmission(config.repository, "explicit");
}

/** Cancellation settles only the authenticated claim for this terminal run. */
export async function settleCancelledProjectQueueRun(
  config: FactoryConfig,
  state: ContinuationState,
  lock: ControllerLock,
): Promise<void> {
  if (!config.queue?.project) return;
  requireProjectQueueEffects(config);
  if (
    !state.cancelledAt ||
    !state.cancelRequested ||
    (isExecutionState(state) && state.finalAcceptance) ||
    !canHandoff(state) ||
    restoredContinuationOwnershipHold(state) ||
    !continuationConfigurationMatches(state, config)
  )
    throw new Error(
      "Project cancellation requires a terminal run with authenticated resource cessation",
    );
  const identity = linuxProcessIdentity(process.pid);
  const owner = [
    objectiveLockPath(config.repository, state.objective),
    installationLockPath(config.repository),
  ]
    .map((path) => readControllerOwner(path))
    .find((candidate) => candidate?.token === lock.token);
  if (
    !identity ||
    !owner ||
    owner.pid !== process.pid ||
    owner.startTime !== identity.startTime ||
    owner.objective !== state.objective
  )
    throw new Error(
      "Project cancellation requires its actual exclusive controller identity",
    );
  await awaitCheckpointAdmission(config.repository, "explicit");
  const history = await readQueueHistory(config);
  const pending = history.filter(
    (record): record is QueueOwnerClaim =>
      record.kind === "project-queue-owner" &&
      record.objective === state.objective &&
      !record.settled,
  );
  if (!pending.length) return;
  if (pending.length !== 1)
    throw new Error("Project cancellation has competing unfinished claims");
  const claim = pending[0]!;
  const admission = history.find(
    (record): record is QueueOperation =>
      record.kind === "project-queue-operation" &&
      record.id === claim.receiptId,
  );
  const metadata = admission?.metadata
    ? parseQueueMetadata(admission.metadata)
    : undefined;
  const effect = admission?.effects.at(-1);
  if (
    claim.authorityDigest !== factoryAuthorityDigest(config) ||
    claim.bodyDigest !== state.objectiveBodyDigest ||
    !admission?.completed ||
    admission.action !== "admit" ||
    admission.objective !== state.objective ||
    admission.bodyDigest !== claim.bodyDigest ||
    admission.authorityDigest !== claim.authorityDigest ||
    JSON.stringify(admission.binding) !==
      JSON.stringify(config.queue.project) ||
    metadata?.kind !== "admission" ||
    metadata.state !== "queued" ||
    metadata.admissionId !== claim.admissionId ||
    metadata.receiptId !== claim.receiptId ||
    effect?.intent.action !== "set-metadata" ||
    effect.intent.metadata !== admission.metadata ||
    effect.receipt?.kind !== "response" ||
    !effect.original
  )
    throw new Error(
      "Project cancellation differs from its original authenticated admission receipt",
    );
  const archive = await readVerifiedRecoveryCheckpoint(
    config,
    undefined,
    claim.runBinding
      ? undefined
      : { objective: state.objective, claimId: claim.id, runId: state.runId },
  );
  const store = new LocalContentStore(
    join(stateRoot(config.repository), "content"),
  );
  const retain = async (reference: ContentRef) => {
    const bytes = await archive.readVerifiedBlob(reference);
    return retainProjectQueueOriginal(store, reference, bytes);
  };
  const finalFile = archive.manifest.files.find(
    (file) => file.path === `objectives/${state.objective}/state.json`,
  );
  const claimFile = archive.manifest.files.find(
    (file) => file.path === `project-queue-history/${claim.id}.json`,
  );
  if (!finalFile || !claimFile)
    throw new Error("Project cancellation originals are unavailable");
  const cancelledSnapshot = await retain(finalFile.ref);
  if (
    !Buffer.from(store.readBytes(cancelledSnapshot)).equals(
      readFileSync(statePath(config.repository, state.objective)),
    )
  )
    throw new Error(
      "Project cancellation checkpoint differs from the current terminal snapshot",
    );
  let originalClaim: ContentRef;
  let initialSnapshot: ContentRef;
  let lineage: QueueCancellationProof["lineage"];
  if (claim.runBinding) {
    originalClaim = await retain(claimFile.ref);
    initialSnapshot = await retain(claim.runBinding.initialSnapshot);
    lineage = { kind: "producer-bound" };
  } else {
    const verified = archive.queueOwnerLineage;
    if (!verified)
      throw new Error("Project historical first-run binding is unavailable");
    for (const body of verified.bodies) {
      retainProjectQueueOriginal(store, body.ref, body.bytes);
    }
    originalClaim = verified.originalClaim;
    initialSnapshot = verified.initialSnapshot;
    lineage = { kind: "verified-first-run", checkpoints: verified.checkpoints };
  }
  claim.settled = {
    at: new Date().toISOString(),
    runId: state.runId,
    disposition: "quiescent",
    cancellation: {
      schemaVersion: 1,
      originalClaim,
      initialSnapshot,
      cancelledSnapshot,
      configDigest: state.configDigest,
      owner: {
        pid: owner.pid,
        startTime: owner.startTime,
        tokenDigest: queueDigest(owner.token),
      },
      lineage,
    },
  };
  await authenticateQueueOwnerReferences(claim, (reference) =>
    store.readBytes(reference),
  );
  save(claim);
  await awaitCheckpointAdmission(config.repository, "explicit");
}
