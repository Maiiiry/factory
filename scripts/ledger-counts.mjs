#!/usr/bin/env node
// The core scope ledger's counts, derived from its rows so they never
// drift. A ledger row is a list line `- <status>: <capability> — <where>`
// under a `##` section between "## Ledger" and "## Milestone log".
//
//   node scripts/ledger-counts.mjs           print the counts
//   node scripts/ledger-counts.mjs --write   rewrite the counts block
//   node scripts/ledger-counts.mjs --check   exit 1 on a bad row or a stale block (CI)
//   node scripts/ledger-counts.mjs --open    list open rows; exit 1 if any (the cutover check)
import { readFileSync, writeFileSync } from "node:fs";

const FILE = new URL("../docs/CORE-SCOPE.md", import.meta.url);
/** Closed: nothing left to build. Open: work remains before cutover. */
const CLOSED = ["ported", "replaced", "dropped", "parked"];
const OPEN = ["in-progress", "planned", "owed"];
const START = "<!-- counts:start -->";
const END = "<!-- counts:end -->";

const ROW = new RegExp(`^- (${[...CLOSED, ...OPEN].join("|")}): (.+?) — (.+)$`);

/** A line that looks like a row however it is indented: it must be a counted one. */
const ROWLIKE = new RegExp(`^\\s*- (${[...CLOSED, ...OPEN].join("|")}):`);

function rows(text) {
  const found = [];
  const problems = [];
  let section;
  let inLedger = false;
  let ended = false;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line === "## Ledger") inLedger = true;
    else if (line === "## Milestone log") {
      inLedger = false;
      ended = true;
    }
    if (!inLedger) continue;
    if (line.startsWith("## ")) section = line.slice(3);
    const at = `docs/CORE-SCOPE.md:${index + 1}`;
    // The Status words list sits under "## Ledger", above the first section.
    if (section === "Ledger") {
      if (ROWLIKE.test(line))
        problems.push(`${at}: a row must be under a ## section`);
      continue;
    }
    if (!line.startsWith("- ")) {
      if (ROWLIKE.test(line))
        problems.push(`${at}: a row must not be indented`);
      continue;
    }
    const match = ROW.exec(line);
    if (!match || match[3].includes(" — "))
      problems.push(`${at}: a row is \`- <status>: <capability> — <where>\``);
    else {
      const [, status, capability, where] = match;
      found.push({ section, capability, status, where, at });
    }
  }
  if (section === undefined || !ended)
    problems.push(
      "docs/CORE-SCOPE.md needs a ## Ledger section followed by ## Milestone log",
    );
  else if (!found.length)
    problems.push("docs/CORE-SCOPE.md has no ledger rows");
  return { found, problems };
}

function block(found) {
  const statuses = [...CLOSED, ...OPEN];
  const sections = [...new Set(found.map((row) => row.section))];
  const count = (rows, status) =>
    rows.filter((row) => row.status === status).length;
  const lines = [
    START,
    `| Section | ${statuses.join(" | ")} | Total |`,
    `| --- | ${statuses.map(() => "---:").join(" | ")} | ---: |`,
  ];
  for (const section of sections) {
    const mine = found.filter((row) => row.section === section);
    lines.push(
      `| ${section} | ${statuses.map((status) => count(mine, status)).join(" | ")} | ${mine.length} |`,
    );
  }
  lines.push(
    `| **All** | ${statuses.map((status) => `**${count(found, status)}**`).join(" | ")} | **${found.length}** |`,
    END,
  );
  return lines.join("\n");
}

const text = readFileSync(FILE, "utf8");
const { found, problems } = rows(text);
const mode = process.argv[2];
const current = text.slice(text.indexOf(START), text.indexOf(END) + END.length);
const fresh = block(found);
if (mode === "--open") {
  const open = found.filter((row) => OPEN.includes(row.status));
  for (const row of open)
    console.log(`${row.at}: ${row.status}: ${row.capability}`);
  for (const problem of problems) console.error(problem);
  process.exit(open.length || problems.length ? 1 : 0);
}
if (problems.length) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
if (mode === "--write") {
  if (!text.includes(START) || !text.includes(END)) {
    console.error(`docs/CORE-SCOPE.md has no ${START} … ${END} block`);
    process.exit(1);
  }
  writeFileSync(FILE, text.replace(current, fresh));
} else if (mode === "--check") {
  if (current !== fresh) {
    console.error(
      "docs/CORE-SCOPE.md counts are stale: run node scripts/ledger-counts.mjs --write",
    );
    process.exit(1);
  }
} else console.log(fresh);
