import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  factoryAuthorityDigest,
  factoryConfigDigest,
  readConfig,
  resolveProvider,
  validateConfigFile,
} from "../dist/config.js";
import { addProvider, writeConfiguration } from "../dist/install.js";
import {
  hostPlanningKind,
  selectProvider,
} from "../dist/provider-selection.js";

/** A Git checkout whose origin is the configured repository. */
function checkout(repository) {
  const directory = mkdtempSync(join(tmpdir(), "factory-provider-target-"));
  execFileSync("git", ["init", "-q", directory]);
  execFileSync("git", [
    "-C",
    directory,
    "remote",
    "add",
    "origin",
    `https://github.com/${repository}.git`,
  ]);
  return directory;
}
const target = checkout("example/target");

const codex = {
  planning: {
    kind: "codex-sdk",
    planner: { model: "gpt-6.1-sol", reasoningEffort: "high" },
    reviewer: { model: "gpt-6.1-sol", reasoningEffort: "high" },
  },
  execution: {
    kind: "local",
    harness: {
      kind: "codex-sdk",
      model: "gpt-6.1-sol",
      reasoningEffort: "medium",
    },
  },
};
const claude = {
  planning: {
    kind: "claude-agent-sdk",
    maxOutputTokens: 64000,
    planner: { model: "claude-opus-5-5", reasoningEffort: "high" },
    reviewer: { model: "claude-opus-5-5", reasoningEffort: "medium" },
  },
  execution: {
    kind: "local",
    harness: {
      kind: "claude-agent-sdk",
      model: "claude-sonnet-5-5",
      reasoningEffort: "medium",
      permissionMode: "acceptEdits",
      settingSources: [],
      tools: ["Read", "Edit", "Write", "Glob", "Grep"],
      allowedTools: ["Read", "Edit", "Write", "Glob", "Grep"],
      maxTurns: 12,
    },
  },
};
const flat = {
  schemaVersion: 1,
  repository: "example/target",
  checkout: target,
  ...codex,
  delivery: { kind: "regular" },
  policy: { network: "host", allowedSecretNames: [] },
};
const file = {
  schemaVersion: 1,
  repository: "example/target",
  checkout: target,
  providers: { codex, claude },
  defaultProvider: "codex",
  delivery: { kind: "regular" },
  policy: { network: "host", allowedSecretNames: [] },
};

test("a provider resolves to the flat configuration its Objectives froze", () => {
  validateConfigFile(file);
  assert.equal(
    factoryConfigDigest(resolveProvider(file, "codex")),
    factoryConfigDigest(flat),
  );
  assert.notEqual(
    factoryConfigDigest(resolveProvider(file, "claude")),
    factoryConfigDigest(flat),
  );
  assert.throws(
    () => validateConfigFile(flat),
    /planning and execution belong to a named provider/,
  );
  assert.throws(
    () => validateConfigFile({ ...file, defaultProvider: "copilot" }),
    /defaultProvider must name a configured provider/,
  );
});

test("queue authority binds the default provider whichever provider runs", () => {
  const authority = factoryAuthorityDigest(flat);
  assert.equal(
    factoryAuthorityDigest(resolveProvider(file, "codex")),
    authority,
  );
  assert.equal(
    factoryAuthorityDigest(resolveProvider(file, "claude")),
    authority,
  );
  assert.equal(
    factoryConfigDigest(resolveProvider(file, "claude")),
    factoryConfigDigest({ ...flat, ...claude }),
  );
  assert.notEqual(
    factoryAuthorityDigest(
      resolveProvider({ ...file, defaultProvider: "claude" }, "codex"),
    ),
    authority,
  );
});

test("the calling agent host selects new work's provider", () => {
  assert.equal(hostPlanningKind({ CLAUDECODE: "1" }), "claude-agent-sdk");
  assert.equal(hostPlanningKind({ CODEX_THREAD_ID: "t" }), "codex-sdk");
  assert.equal(hostPlanningKind({}), undefined);
  assert.equal(
    hostPlanningKind({ CLAUDECODE: "1", CODEX_THREAD_ID: "t" }),
    "ambiguous",
  );
  const pick = (options) => {
    const { provider, source } = selectProvider(file, options);
    return `${provider}/${source}`;
  };
  assert.equal(pick({ env: { CLAUDECODE: "1" } }), "claude/host");
  assert.equal(pick({ env: { CODEX_THREAD_ID: "t" } }), "codex/host");
  assert.equal(pick({ env: {} }), "codex/default");
  assert.equal(
    pick({ env: { CLAUDECODE: "1" }, host: false }),
    "codex/default",
  );
  assert.equal(pick({ env: { CLAUDECODE: "1" }, flag: "codex" }), "codex/flag");
  assert.throws(
    () => pick({ env: { CLAUDECODE: "1", CODEX_THREAD_ID: "t" } }),
    /choose a provider with --provider/,
  );
  const codexOnly = { ...file, providers: { codex } };
  assert.throws(
    () => selectProvider(codexOnly, { env: { CLAUDECODE: "1" } }),
    /no provider uses it; add one with factory setup/,
  );
});

test("setup adds a provider without changing the others", () => {
  const directory = mkdtempSync(join(tmpdir(), "factory-provider-setup-"));
  const path = join(directory, "config.json");
  writeConfiguration(
    ["--repository", "example/setup", "--checkout", checkout("example/setup")],
    path,
  );
  const before = factoryConfigDigest(readConfig(path, "codex"));
  assert.equal(JSON.parse(readFileSync(path, "utf8")).defaultProvider, "codex");
  addProvider(
    [
      "--provider",
      "claude",
      "--planning",
      "claude-agent-sdk",
      "--planning-model",
      "claude-opus-5-5",
      "--review-model",
      "claude-opus-5-5",
      "--harness",
      "claude-agent-sdk",
      "--worker-model",
      "claude-sonnet-5-5",
      "--claude-max-turns",
      "12",
    ],
    path,
  );
  assert.equal(factoryConfigDigest(readConfig(path, "codex")), before);
  assert.equal(readConfig(path, "claude").planning.kind, "claude-agent-sdk");
  assert.equal(readConfig(path).planning.kind, "codex-sdk");
  assert.throws(
    () => addProvider(["--provider", "claude"], path),
    /already configured/,
  );
});
