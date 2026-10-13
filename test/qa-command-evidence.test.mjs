import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { planningSources } from "../dist/compiler/sources.js";
import { factoryConfigDigest } from "../dist/config.js";
import { LocalContentStore } from "../dist/content/local.js";
import { graphDigest } from "../dist/graph-amendments.js";
import { runQaItem } from "../dist/qa-execution.js";
import { resolveAutonomy, consumption } from "../dist/repair-policy.js";
import { rereviewWorkItem } from "../dist/runner.js";
import { readState, saveState, statePath } from "../dist/state-store.js";
import { finalizeObjective } from "../dist/runner/finalization.js";
import { objectiveReviewEvidence } from "../dist/result-evidence.js";
import { renderResultReviewCall } from "../dist/compiler/model.js";
import { validateTree } from "../dist/validation.js";
import { reviewTextArtifactEvidence } from "../dist/review-image-evidence.js";
import { assertReviewArtifactSelection } from "../dist/review-artifacts.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");

test("QA rereview retains exact command, installed dependency and runtime proof through final review", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-qa-proof-"));
  const checkout = join(root, "target");
  mkdirSync(checkout);
  const git = (...args) =>
    execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Integration");
    git("config", "user.email", "integration@example.invalid");
    writeFileSync(
      join(checkout, "README.md"),
      "# QA contract\nRetain dependency and runtime proof.\n",
    );
    git("add", ".");
    git("commit", "-m", "base");
    const base = git("rev-parse", "HEAD");
    git("checkout", "-b", "implementation");
    writeFileSync(join(checkout, ".gitignore"), "node_modules/\n");
    writeFileSync(
      join(checkout, "proof.cjs"),
      `const fs=require('node:fs'),os=require('node:os'),p=require('node:path');
if(process.argv[2]==='install') { fs.mkdirSync('node_modules/.store/dependency',{recursive:true}); fs.writeFileSync('node_modules/.store/dependency/package.json',JSON.stringify({version:'1.0.0',exports:'./api.js'})); fs.writeFileSync('node_modules/.store/dependency/api.js','exports.fromState = state => [...state];\\n'); fs.symlinkSync('.store/dependency','node_modules/dependency'); console.log('Dependency inspection ready'); }
else { if(process.env.TMPDIR!==process.env.TMP || process.env.TMP!==process.env.TEMP) throw Error('temp not owned'); const dir=fs.mkdtempSync(p.join(os.tmpdir(),'runtime-')); fs.writeFileSync(p.join(dir,'node.json'),JSON.stringify({state:[1,2],restoration:true})); fs.writeFileSync(p.join(dir,'comparison.json'),JSON.stringify({equal:true})); console.log('runner prefix: Runtime evidence: '+dir); }
`,
    );
    git("add", ".");
    git("commit", "-m", "Factory: Runtime proof");
    const result = git("rev-parse", "HEAD");
    git("checkout", "main");
    git("merge", "--no-ff", "implementation", "-m", "Integrate proof");
    const commit = git("rev-parse", "HEAD"),
      treeSha = git("rev-parse", "HEAD^{tree}");
    git("remote", "add", "origin", checkout);
    const commands = [
      `${process.execPath} proof.cjs install`,
      `${process.execPath} proof.cjs`,
    ];
    const body =
      "## Sources\n- README.md\n\n## Acceptance\n- Retain dependency and runtime proof.\n";
    const item = {
      id: "qa",
      kind: "qa",
      title: "Runtime proof",
      goal: "Inspect declared proof",
      brief: "Run exact commands and retain selected evidence",
      acceptance: ["Retain dependency and runtime proof."],
      nonGoals: [],
      dependencies: [],
      ownedPaths: [],
      resources: [],
      expectedOutputRoles: [],
      requiredLfsRoles: [],
      sourceAssets: [],
      minimumAssetSets: 0,
      citations: [],
      inputSources: [],
      validation: commands.map((command) => ({
        command,
        provenance: "source-declared",
      })),
    };
    item.dependencies = ["implementation"];
    const graph = {
      objective: 1,
      baseSha: base,
      brief: "",
      items: [
        {
          ...item,
          id: "implementation",
          kind: "work",
          dependencies: [],
          acceptance: [],
          validation: [],
          ownedPaths: ["proof.cjs", ".gitignore"],
        },
        item,
      ],
      coverage: [
        {
          criterionId: hash(item.acceptance[0]),
          source: {
            path: "OBJECTIVE",
            digest: hash(item.acceptance[0]),
            text: item.acceptance[0],
          },
          itemId: "qa",
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
    const config = {
      repository: `integration/qa-proof-${root.split("/").at(-1)}`,
      checkout,
      delivery: { kind: "regular" },
      capture: {
        enabled: false,
        maxBytesPerInvocation: 1024,
        retainInRecovery: false,
      },
    };
    const prior = {
      treeSha,
      commands: commands.map((command, index) => ({
        index,
        command,
        treeSha,
        passed: true,
        exitCode: 0,
      })),
    };
    const work = {
      status: "waiting",
      step: "approve-result",
      attempt: "same-qa-attempt",
      baseSha: commit,
      executionBaseSha: commit,
      changeRef: commit,
      treeSha,
      graphRevisionDigest: graphDigest(graph),
      validation: prior,
      acceptancePending: {
        treeSha,
        criterion: item.acceptance[0],
        detail: "Missing runtime proof",
        question: "Supply complete proof",
      },
    };
    const state = {
      schemaVersion: 7,
      publicationContract: "exact-request-v1",
      repository: config.repository,
      objective: 1,
      runId: "same-qa-run",
      baseSha: base,
      graph,
      planGraphDigest: graphDigest(graph),
      capacity: { concurrency: 1 },
      issueByItemId: { implementation: 3, qa: 2 },
      configDigest: factoryConfigDigest(config),
      integratedSha: commit,
      work: {
        implementation: {
          status: "done",
          attempt: "actual-result",
          baseSha: base,
          executionBaseSha: base,
          changeRef: result,
          integratedSha: commit,
          treeSha,
          validation: { treeSha, commands: [] },
          githubClosure: "complete",
        },
        qa: work,
      },
      autonomy: resolveAutonomy({ allowances: { resultRereviews: 1 } }),
      coordinator: {
        mode: "paused",
        phase: "waiting",
        phaseStartedAt: new Date().toISOString(),
        processes: [],
      },
    };
    const selectors = [
      {
        command: commands[0],
        text: {
          source: "proof.cjs",
          stdout: { maxBytes: 4096 },
          files: [
            {
              file: "node_modules/dependency/package.json",
              mediaType: "application/json",
              maxBytes: 4096,
            },
            {
              file: "node_modules/dependency/api.js",
              mediaType: "text/plain",
              maxBytes: 4096,
            },
          ],
        },
      },
      {
        command: commands[1],
        text: {
          source: "proof.cjs",
          stdout: { maxBytes: 4096 },
          locator: {
            stdoutPathPrefix: "Runtime evidence: ",
            files: [
              {
                file: "node.json",
                mediaType: "application/json",
                maxBytes: 4096,
              },
              {
                file: "comparison.json",
                mediaType: "application/json",
                maxBytes: 4096,
              },
            ],
          },
        },
      },
    ];
    saveState(statePath(config.repository, 1), state);
    assert.throws(
      () =>
        rereviewWorkItem(config, 1, {
          item: "qa",
          actor: "operator",
          reviewArtifacts: [{ ...selectors[0], command: "echo unauthorized" }],
        }),
      /exact declared/,
    );
    assert.equal(
      consumption(readState(config.repository, 1)).resultRereviews,
      0,
    );
    assert.throws(
      () =>
        rereviewWorkItem(config, 1, {
          item: "qa",
          actor: "operator",
          reviewArtifacts: [
            {
              ...selectors[0],
              text: { ...selectors[0].text, source: "missing.cjs" },
            },
          ],
        }),
      /tracked regular/,
    );
    rereviewWorkItem(config, 1, {
      item: "qa",
      actor: "operator",
      reviewArtifacts: selectors,
    });
    const resumed = readState(config.repository, 1);
    assert.equal(resumed.work.qa.attempt, work.attempt);
    assert.equal(resumed.work.qa.changeRef, commit);
    assert.deepEqual(
      resumed.work.qa.recovery.history[0].work.validation,
      prior,
    );
    assert.equal(
      resumed.work.qa.recovery.history[0].work.reviewArtifactSelection,
      undefined,
    );
    assert.deepEqual(resumed.work.qa.reviewArtifactSelection, selectors);
    assert.equal(consumption(resumed).resultRereviews, 1);
    resumed.coordinator.mode = "running";
    const store = new LocalContentStore(join(root, "objects"));
    let captured;
    const events = [];
    const model = {
      reviewResult: async (request) => {
        captured = request;
        const index = request.reviewPacket.evidence.findIndex(
          (x) => x.content === '{"equal":true}',
        );
        assert.ok(index >= 0);
        return {
          packetId: request.reviewPacket.id,
          findings: [
            {
              criterionIndex: 0,
              verdict: "pass",
              evidenceIndices: [index],
              detail: "Complete current command proof supplied",
              question: "",
            },
          ],
        };
      },
    };
    await runQaItem({
      config,
      root,
      state: resumed,
      item: resumed.graph.items[1],
      github: { defaultBranch: async () => "main", closeIssue: async () => {} },
      model,
      objectiveBody: body,
      store,
      save() {},
      cancelled: () => false,
      diagnostics: {
        emit: (x) => events.push(x),
        emitStream: (x) => events.push(x),
        modelObserver: () => () => {},
      },
    });
    assert.equal(resumed.work.qa.status, "done");
    assert.equal(resumed.work.qa.attempt, work.attempt);
    assert.ok(events.some((x) => x.operation === "qa-validation-output"));
    const artifacts = resumed.work.qa.validation.reviewArtifacts;
    assert.equal(artifacts.length, 2);
    assert.equal(
      artifacts[0].text.source.sha256,
      hash(readFileSync(join(checkout, "proof.cjs"))),
    );
    assert.equal(
      artifacts[0].text.bodies[1].resolvedPath,
      "node_modules/.store/dependency/package.json",
    );
    assert.equal(existsSync(join(root, "validation", "qa", "worktree")), false);
    assert.equal(
      captured.reviewPacket.evidence.some((x) =>
        x.content.includes("exports.fromState = state"),
      ),
      true,
    );
    assert.equal(
      captured.reviewPacket.evidence.some((x) =>
        x.content.includes('"restoration":true'),
      ),
      true,
    );
    // The real final-evidence producer selects accepted same-tree observations;
    // fresh final commands need no duplicate prospective selector admission.
    const accepted = objectiveReviewEvidence({
      state: resumed,
      checkout,
      candidateCommitSha: commit,
      candidateTreeSha: treeSha,
    });
    assert.equal(accepted.acceptedWorkItemImages.length, 1);
    const changed = structuredClone(resumed.work.qa.validation);
    changed.reviewArtifacts[0].text.bodies[0].ref.digest = "0".repeat(64);
    await assert.rejects(
      () => reviewTextArtifactEvidence(checkout, changed, [], store),
      /missing|digest verification/,
    );

    const finalCommand = `${process.execPath} -e 'process.exit(0)'`;
    resumed.objectiveCommands = [finalCommand];
    await assert.rejects(
      () =>
        finalizeObjective({
          config,
          objective: 1,
          issue: { body },
          state: resumed,
          graph: resumed.graph,
          objectiveDirectory: join(root, "objective"),
          root,
          diagnostics: {
            emit() {},
            emitStream() {},
            modelObserver: () => () => {},
            span: async (_event, run) => run(),
          },
          github: { defaultBranch: async () => "main" },
          contentStore: store,
          planningModel: {
            reviewResult: async (request) => {
              const rendered = renderResultReviewCall(request);
              assert.ok(
                rendered.prompt.includes("accepted-work-item-validation"),
              );
              assert.ok(
                request.reviewPacket.evidence.some(
                  (x) => x.content === '{"equal":true}',
                ),
              );
              assert.deepEqual(
                request.commands.map((x) => x.command),
                [finalCommand],
              );
              assert.ok(
                request.commands.every(
                  (x) => x.passed && x.treeSha === treeSha,
                ),
              );
              throw Error("final proof inspected");
            },
          },
          save() {},
          objectiveStep: async (_state, name, run) =>
            name === "final-head"
              ? false
              : run({
                  progress() {},
                  previousInvalid: () => undefined,
                  invalid() {},
                  paid: (run) => run(),
                }),
          stopIfCancelled() {},
          cancellationRequested: () => false,
          objectiveSignal: () => new AbortController().signal,
          objectivePause: () => undefined,
        }),
      /final proof inspected/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("selected text refuses lossy, oversized, missing and foreign proof without changing commands", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-text-refusals-"));
  const checkout = join(root, "target");
  mkdirSync(checkout);
  const git = (...args) =>
    execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Integration");
    git("config", "user.email", "integration@example.invalid");
    writeFileSync(join(checkout, ".gitignore"), "node_modules/\n");
    const foreign = join(root, "old-runtime");
    mkdirSync(foreign);
    writeFileSync(join(foreign, "proof.json"), '{"stale":true}');
    writeFileSync(
      join(checkout, "proof.cjs"),
      `const fs=require('node:fs'),p=require('node:path'),os=require('node:os');
const mode=process.argv[2];
if(mode==='invalid')process.stdout.write(Buffer.from([0xff]));
if(mode==='oversized')process.stdout.write('x'.repeat(33));
if(mode==='stderr')process.stderr.write(Buffer.from([0xff]));
if(mode==='stale')console.log('Runtime: '+${JSON.stringify(foreign)});
if(mode==='escape') {fs.mkdirSync('node_modules');fs.symlinkSync(${JSON.stringify(foreign)},'node_modules/dependency');}
if(mode==='json') {const dir=fs.mkdtempSync(p.join(os.tmpdir(),'evidence-'));fs.writeFileSync(p.join(dir,'proof.json'),'not json');console.log('Runtime: '+dir);}
`,
    );
    git("add", ".");
    git("commit", "-m", "Proof contract");
    const commit = git("rev-parse", "HEAD"),
      tree = git("rev-parse", "HEAD^{tree}"),
      store = new LocalContentStore(join(root, "objects"));
    const command = (mode) => `${process.execPath} proof.cjs ${mode}`;
    const run = (mode, text) =>
      validateTree(
        checkout,
        join(root, mode),
        commit,
        tree,
        [command(mode)],
        undefined,
        undefined,
        [],
        store,
        commit,
        true,
        { commands: [] },
        [{ command: command(mode), text: { source: "proof.cjs", ...text } }],
      );
    await assert.rejects(
      () => run("invalid", { stdout: { maxBytes: 32 } }),
      /UTF-8/,
    );
    await assert.rejects(
      () => run("stderr", { stderr: { maxBytes: 32 } }),
      /UTF-8/,
    );
    await assert.rejects(
      () => run("oversized", { stdout: { maxBytes: 32 } }),
      /byte bound/,
    );
    const locator = {
      stdoutPathPrefix: "Runtime: ",
      files: [
        { file: "proof.json", mediaType: "application/json", maxBytes: 1024 },
      ],
    };
    await assert.rejects(
      () => run("stale", { locator }),
      /contained and relative/,
    );
    await assert.rejects(
      () => run("json", { locator }),
      /JSON|Unexpected token/,
    );
    await assert.rejects(
      () =>
        run("escape", {
          files: [
            {
              file: "node_modules/dependency/proof.json",
              mediaType: "application/json",
              maxBytes: 1024,
            },
          ],
        }),
      /contained and relative/,
    );
    await assert.rejects(
      () =>
        run("missing", {
          files: [
            { file: "missing.txt", mediaType: "text/plain", maxBytes: 1024 },
          ],
        }),
      /ENOENT/,
    );
    const empty = await run("empty", { stdout: { maxBytes: 32 } });
    assert.equal(empty.reviewArtifacts[0].text.bodies[0].ref.bytes, 0);
    assert.equal(
      (await store.readBytes(empty.reviewArtifacts[0].text.bodies[0].ref))
        .length,
      0,
    );
    assert.throws(
      () =>
        assertReviewArtifactSelection(
          [
            {
              command: command("empty"),
              text: {
                source: "proof.cjs",
                files: [
                  {
                    file: ".git/config",
                    mediaType: "text/plain",
                    maxBytes: 32,
                  },
                ],
              },
            },
          ],
          [command("empty")],
        ),
      /contained and relative/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
