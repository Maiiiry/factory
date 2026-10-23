# Core scope ledger

The rebuilt core keeps every capability of the old Factory. It simplifies the mechanisms, not the scope. This ledger maps each old capability to where it stands, and it is updated at every milestone. A capability is dropped, or deferred past cutover, only with the maintainer's explicit approval.

Each row is `- <status>: <capability> — <where>`, with a status from the list under Ledger. `node scripts/ledger-counts.mjs` derives the counts from the rows (CI checks them), and `--open` lists the rows still open.

## Slices

1. Skeleton, queue and check (done).
2. Planning: plan, review, questions, the plan comment. Also: detecting Objective edits after planning (`changedSincePlanning`), tying answers to the question they answer, and command checks at queue time (done 2026-10-22). Two parts moved on: edits after plan acceptance go to slice 3, and binding CLI answers to their question goes to slice 5.
3. One Work Item end to end: worktree, worker, validation, review, PR, CI, merge, final validation, final review and report. Also: origin-binding checks, flaky-check rerun, and detecting Objective edits after the plan is accepted (done 2026-10-22). Several Work Items at once and cancel cleanup came in from slice 4. Several Objectives at once (`maxActiveObjectives`, owned-path waits, host-wide limits) came in from slice 6. Moved on: predecessor blame and `requiredEnvironment` go to slice 5; refusing Factory's own repositories and checking origin before a fetch went to slice 7 (both ported 2026-10-23); worker settings in config go to slice 7; running execution profiles goes to slice 6.
4. Delivery modes: native stacks and LFS assets. Also: scheduling by the plan's hints, and sharing worker notes with peers (done 2026-10-22). Came in from slice 6: Media AssetSets (capture, selection, binding), LFS upload and hydration, Objective source asset import, review artifacts and image review evidence.
5. Operator surface. Part A is done; part B (5B) is the rest:
   - queue pause, resume and drain, plus per-Objective pause (done, part A);
   - `queue list` (done, part A), `watch` and `status --issue`;
   - `factory run N`: a request that queues one Objective plus a follower that follows it, with the old exit codes;
   - a deadline per Objective;
   - Objective dependencies through blocked-by;
   - Work Item issues (one display-only issue per Work Item, see Decisions), sub-issues, their Live comments, Project cards and closing, role labels, native issue types and priority inheritance;
   - failure comments, the reminder after a hold is open 24 h, and the progress on/off settings;
   - stable refusal codes in JSON output (done, part A);
   - binding CLI answers to the question they answer (done 2026-10-23, per-item holds);
   - redaction (done for status and log, part A) and the display time zone in comments;
   - predecessor blame and `requiredEnvironment`;
   - `factory reset`, and the `factory log` read command (done, part A);
   - hold answers: `retry --rereview` with the resultRereviews budget, `--retire-command`, `decide --criterion`, `--fresh` repairs and `repair --proposal`;
   - the remaining allowances: resultRereviews and perPath;
   - a frozen configuration per Objective (done 2026-10-23, #1790);
   - configurable step deadlines (done 2026-10-23, #1786: two configured bounds, the rest fixed).

   Done early, in the lean sweep after slice 3: the check refuses a malformed Quality checkpoint, Package manager update or Workspace package additions section.

6. Capability ports:
   - Planning options: context lookup, recipes, discovery, expansions, conditions, splits, amendments.
   - Running QA and discovery Work Items, conditions and expansions; execution profiles, chosen and run (#1793, open).
   - capacityRecommendation and scheduling reservations.
   - Retained conversations: resuming a session by id across revisions.
   - Objective knowledge in review: peers' handoff notes in result review, and every item's notes in final review (done 2026-10-23, #1789).
   - Several named providers, and provider selection (done 2026-10-22, with the Copilot planner and worker and managed execution). Managed execution is parked: no API keys yet (Kirk, 2026-10-23).
   - Copilot Validate (done 2026-10-23, #1788).
   - Learning, Dream and proposals, with their own curated store kept outside run-log rotation.
   - `propose` (done 2026-10-23, W4-14) and the library analysis API. The adapter library API is replaced by the Worker seam (Kirk, 2026-10-23). The Codex app-server transport is dropped (Kirk, 2026-10-23): upstream-experimental owned RPC client; Codex plans via the SDK; retained conversations come through W5-06.
   - Diagnostics, capture export, accounting, scorecard and analysis on the run log.
7. Cutover: setup in both modes, the systemd install, the readiness checklist (setup's one prerequisite checklist), plugin and skills packaging, migration. Also: setup flags for the worker settings (the settings themselves are in config since the lean sweep after slice 3) and the branch-protection recommendation. Refusing Factory's own repositories, the origin check before every fetch and refusing a configuration inside the checkout are ported (2026-10-23).

## Decisions

These are the maintainer's decisions (2026-10-22 unless dated), and defaults taken since, marked as such:

- **The queue.** The GitHub Project is the source of truth for the queue. Setting the Factory field to its queued option admits an Objective. Edits made after planning are detected (slice 2).
- **Answers by comment.** Answers come from `/factory <answer>` comments by users with write access, as well as from the CLI.
- **Concurrency.** Push concurrency to use the local machine (maintainer, 2026-10-22). Up to 3 Objectives run at once by default with owned-path waits, 8 Work Items per Objective, and host caps sized from the CPU count. This supersedes the earlier one-at-a-time v1 decision.
- **One installation per repository.** Two machines serving one queue are not supported. That would need a real distributed lock, such as a database.
- **Commands authorized in answers.** An operator answer may authorize an exact validation command for an Objective. It is recorded in the plan.
- **Plan approval.** A clean, reviewed plan runs without an approval step. Factory asks only about operator-decision findings.
- **Work Items** (default taken, 2026-10-23). A Work Item is one PR, tracked by one display-only issue (slice 5B). The issue shows progress and never drives it: state, holds and answers stay on the Objective.
- **Sources are pinned at base** (default taken, 2026-10-23). A plan reads each Source at the base it was made against, so a Source file changed on the default branch later doesn't change the plan; `replan` reads the new bytes.
- **Kirk's calls (2026-10-23).** repairClasses is replaced by repair diagnosis and one repair budget per Work Item. The adapter library API (AgentHarness) is replaced by the Worker seam. Managed execution is parked until there are API keys to qualify it.

## Contradictions

Where the core deliberately reverses an old Factory rule. Each resolution is approved; the ledger lines that cite this section point here.

- **Queue consent.** Old: `queue add` bound consent to the exact issue body. Core: whoever can set the Project's Factory field to its queued option consents (Kirk, 2026-10-22). A body written by a non-writer is planned only after a writer approves its shown text, bound to its digest.
- **Foreground runs.** Old: `factory run --objective N` ran the Objective in the terminal. Core: the service does all work. `factory run N` (slice 5) is a request that queues the Objective plus a follower that follows it to the end and exits with the old codes, so there is one code path.
- **Human comments as input.** Old: Factory read no human comment. Core: a `/factory <answer>` comment from a user with write access answers a hold, bound to the question it answers (Decisions: Answers by comment).
- **Work Item issues.** Old: each Work Item had its own GitHub issue (Task type, sub-issue, blocked-by edges). Core: CORE.md defined a Work Item as one PR, with no issue. Resolved: one PR, tracked by one display-only issue (slice 5B; Decisions: Work Items).

## Ledger

Each row maps an old Factory capability to where it stands in the core. The details are in [CORE.md](CORE.md). A row is `- <status>: <capability> — <where>`.

Status words:

- Closed:
  - `ported`: in core/src; Where names the file.
  - `replaced`: the same guarantee, delivered another way; Where says how.
  - `dropped`: not carried, with the maintainer's approval named.
  - `parked`: in core/src but unused until the maintainer unparks it; Where names the approval.
- Open:
  - `in-progress`: Where says what's missing and the PR or slice that carries it.
  - `planned`: Where names the PR or slice.
  - `owed`: a test or drill still to run.

The old tree is deleted only when `node scripts/ledger-counts.mjs --open` lists no row.

<!-- prettier-ignore-start -->
<!-- counts:start -->
| Section | ported | replaced | dropped | parked | in-progress | planned | owed | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Objectives and checks | 20 | 0 | 0 | 0 | 2 | 0 | 0 | 22 |
| Queue and control | 14 | 10 | 1 | 0 | 0 | 0 | 0 | 25 |
| Planning | 24 | 1 | 0 | 0 | 1 | 0 | 0 | 26 |
| Planning options | 8 | 0 | 0 | 0 | 0 | 0 | 0 | 8 |
| Execution and providers | 25 | 2 | 1 | 1 | 0 | 1 | 0 | 30 |
| Validation and review | 18 | 1 | 0 | 0 | 0 | 0 | 0 | 19 |
| Delivery | 10 | 2 | 0 | 0 | 0 | 0 | 0 | 12 |
| GitHub tracking | 7 | 2 | 0 | 0 | 2 | 0 | 0 | 11 |
| Holds and decisions | 9 | 1 | 0 | 0 | 1 | 0 | 0 | 11 |
| Recovery and restart | 10 | 6 | 0 | 0 | 0 | 0 | 0 | 16 |
| Learning and knowledge | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 3 |
| Telemetry and diagnostics | 10 | 1 | 1 | 0 | 3 | 1 | 0 | 16 |
| Setup and service | 9 | 2 | 0 | 0 | 0 | 0 | 1 | 12 |
| Safety | 15 | 0 | 0 | 0 | 0 | 0 | 0 | 15 |
| Tests and drills | 4 | 0 | 0 | 0 | 0 | 0 | 1 | 5 |
| **All** | **186** | **28** | **3** | **1** | **9** | **2** | **2** | **231** |
<!-- counts:end -->
<!-- prettier-ignore-end -->

## Objectives and checks

- ported: Objective = GitHub issue with Goal, Acceptance, optional Context, Sources and Constraints — objective.ts checkObjective over shown.ts blocks (the structure of GitHub's rendered issue)
- ported: A Goal under the heading "Outcome" was accepted — objective.ts accepts Outcome as the Goal
- ported: A "Non-goals" heading is a known section — objective.ts treats it as a known section
- ported: Retired headings (Final validation, Planning sources, What must be true) are refused with a fix — objective.ts RETIRED
- ported: A malformed Sources line is refused, naming where the content goes — objective.ts
- ported: Each Source path and pinned heading must exist exactly once at base — facts.ts planningSources, run by the check through objectiveCommandProblems
- ported: An Acceptance bullet that is exactly one backticked command is a final validation command — objective.ts checkObjective (one `code` list item); facts.ts finalObjectiveCommands; steps.ts records the plan's finalCommands
- ported: Backticked commands in Objective prose are declared command authority — facts.ts authorizedCommands, used by buildFacts and the plan checks
- ported: The queue-add check refuses base-declared commands that have no Acceptance bullet (objective_preflight_failed) — workflow.ts checkStep calls facts.ts objectiveCommandProblems
- ported: The check runs once at queue time, with the same checks planning uses — workflow.ts checkStep and `replan` run steps.ts readObjective; service.ts runs the check at once, slot or not
- ported: A failed check holds, naming every problem; you edit the issue and answer `recheck` — workflow.ts
- ported: Optional "Quality checkpoint" section — prompts.ts qualityCheckpointInstructions; planning/steps.ts readObjective refuses a malformed section (validate.ts declarationProblems)
- ported: Optional "Workspace package additions" section — prompts.ts; wire.ts `newPackages` owners own their manifest; validate.ts workspaceAdditions and pinRefusal; declarationProblems
- ported: Optional "Package manager update" section, an exact pin required by validation — prompts.ts packageManagerUpdate; declarationProblems and executables.ts at the check; validate.ts pinRefusal enforces the pin
- ported: Optional "Adaptive workflow" section with planning context (`planning.context`) — validate.ts adaptiveWorkflow, knowledge/settings.ts planningContext, knowledge/index.ts; adaptive graph behind `planning.adaptiveGraph`; planning/lookup.ts
- in-progress: Optional "Workflow recipe" section with repository or packaged recipes — recipes.ts resolves and checks the recipe at base; missing: required memory lookups by query wait for planner lookups
- ported: Objective source assets (user-attachment URLs, repository files, private local files) imported as worker inputs — media.ts resolveInputs (base blob, LFS, `media.localAssetRoots`, GitHub attachments); checks.ts mediaFindings; work/prompt.ts stages them
- in-progress: Objective dependencies through native blocked-by, waiting for predecessors' accepted evidence — W3-09: planning/predecessors.ts, github.ts blockedBy; missing: a split parent standing for its children (with the child split row)
- ported: Editing the Objective or its Sources after planning is detected (changedSincePlanning) — planning/steps.ts up to acceptance, then work/steps.ts objectiveEdited holds; Sources pinned at base (default taken, 2026-10-23)
- ported: The check refuses a missing or wrong-version host executable a final command needs, naming the fix — executables.ts observeLocalExecutables, called by workflow.ts checkStep
- ported: An Objective template and GitHub issue form are shipped — the templates are unchanged in docs/templates
- ported: Plans may name only base PR workflow jobs, and delivery re-checks a renamed job — facts.ts workflowCheckNames, unknownCheckNames; delivery.ts renamedChecks

## Queue and control

- ported: Background queue on a GitHub Project, read every queue.pollSeconds (30 s) — queue.ts, github-sync.ts; also reads known and recently updated issues, since the item list lagged (f#1767)
- replaced: `queue add` as explicit consent, with approval bound to the exact issue body; labels and cards never admit work — setting the Project Status to "queued" is consent (whoever can edit the Project); see Contradictions (Kirk, 2026-10-22)
- ported: `queue list` shows unqueued candidates and inert cards — cli.ts queueCommand with queue.ts readCards: queued, candidate or inert, with the reason; `--json`
- replaced: `queue remove` withdraws an Objective and archives its card — move Status out of "queued" before the Objective starts; after it starts, use cancel
- replaced: `queue sync` — the 30 s poll
- ported: Ordered queue — queue.ts queued: order field, then issue number
- ported: `queue pause|resume|drain`, a queue-wide hold — a `queue` request; state.ts saves the mode in `queue.json`; service.ts applies pause, drain and resume; no control card
- ported: Per-Objective `pause|drain|resume`, surviving restarts — `factory pause|drain|resume N`, saved in the state's `control`; service.ts `allowed`; work/steps.ts startedItems
- ported: `cancel` from every non-terminal state, under changed config, with no provider call — engine.ts, service.ts: a cancel request is applied even under a hold
- ported: Cancel closes open Factory PRs and removes worktrees — work/steps.ts cancelCleanupStep closes PRs under `factory/<issue>/` and the issue, removes worktrees; sandbox.ts processGroups
- replaced: `cancel --provider NAME` for a stranded Objective — cancel doesn't need a provider
- replaced: `factory run --objective N` foreground run with exit codes 0, 2 and 1 — W3-03: `factory run N` is a `run` request (requests.ts) the service queues; cli.ts runCommand follows, exit 0/1/2; see Contradictions
- replaced: Several Objectives run in parallel from separate terminals; a second live run of the same Objective is refused — the single `serve` with a lock (lock.ts), which runs several Objectives at once
- ported: queue.maxActiveObjectives 1-8, with waits on overlapping owned paths and shared host limits — config.ts queue.maxActiveObjectives (default 3); service.ts slots and pathOwner; engine.ts HostLimiter
- ported: An absolute deadline (`--deadline`, queue.objectiveDeadlineSeconds) that restarts can't extend — W3-02: `queue.objectiveDeadlineSeconds` saved as `state.deadline`; engine.ts `expire`; `factory run N --deadline` (state.ts `deadlineAt`)
- replaced: A Project queue requires a current admission before a foreground run — there are no foreground runs
- dropped: Two hosts never consume the same admission — only a per-host flock; CORE.md assumes one installation (Kirk, 2026-10-22)
- ported: One control plane: the service applies CLI commands — requests.ts, service.ts
- ported: Stable lifecycle refusal codes as JSON on stderr — requests.ts RefusalCode; the CLI prints `{"kind":"lifecycle-refusal","code":"..."}` on stderr; new codes for the new commands
- replaced: Upgrade by handoff (drain, safe-point handoff) — stop, install, start; crash-only restart continues from the last step
- replaced: Settle deadline: end steps are bounded — per-step deadlines (engine.ts Step.deadlineMs)
- ported: Unknown or misplaced flags are refused with a fix hint — cli.ts parse from the one command table, refusing with how to write it; `--help`, `-h` and a bare `factory` show help
- ported: Queuing a finished Objective again runs it again, cleaning up the old run first — service.ts admit, engine.ts stop, work/steps.ts rerunCleanupStep, queue.ts moveStatusOffDone
- ported: `factory help` lists every command and option — cli.ts USAGE, made from the command table, for every core command; commands still to come are slice 6
- replaced: `--config PATH` on every command, with XDG config and state roots — FACTORY_CONFIG and `--repo`; config in ~/.config/factory (config.ts); paths in paths.ts

## Planning

- ported: Plan from a pinned base (default-branch head at the first plan), ignoring uncommitted edits — git.ts defaultHead, read by planning/steps.ts readObjective and saved in the check result
- ported: The planner compiles a Work Item graph from a read-only export at base — steps.ts planRoundStep, wire.ts, graph.ts, repository.ts exportTree
- ported: Coverage: each acceptance criterion and source exit item has exactly one owner; exclusions need reasons — graph.ts checkCoverageShape and checkCoverageSources, run by checks.ts checkPlan
- ported: Deterministic plan lint before paid review, returned as one correction — checks.ts checkPlan runs in the plan round; steps.ts sends only a clean draft to review
- ported: Independent graph review; fix findings auto-revise within planningRevisions — steps.ts reviewStep and decideStep, review.ts, autonomy.allowances.planningRevisions (default now 4 rounds, was 1)
- ported: Operator-decision findings and planner questions stop for the operator; the answer revises the draft — steps.ts decideStep and questionFor: `answer <text>` goes back to the planner as an operator correction
- ported: Granting 2 more revisions when revisions run out — the `more` answer (steps.ts questionFor and granted) grants planningRevisions again
- replaced: `decide --outcome refuse` discards the plan — `replan` discards the draft and plans again, `cancel` ends the Objective (steps.ts); no separate refuse answer
- ported: The planner and reviewer are told worker capability, authorized and CI-only commands, and the validation environment — prompts.ts with rubric.ts workerCapability, facts.ts commandInstructions and VALIDATION_ENVIRONMENT
- ported: Target design checklist (AGENTS.md) and doc map honored by briefs, workers and review — rubric.ts, prompts.ts, facts.ts (planning); work/prompt.ts, claude-worker.ts (workers); review/result.ts, review/final.ts
- in-progress: Child Objective split (sub-issues, blocked-by), with the parent closing when all children are accepted — planning ported (wire.ts split, checks.ts splitFindings); creating issues, queueing children and closing the parent is slice 6
- ported: Scheduling hints (estimatedDurationMs) and critical-path ordering — graph.ts checks the hints; planning/schedule.ts rank orders items; work/steps.ts buildSteps emits steps in that order
- ported: Declared resources are exclusive: an item waits, without a question, while another in flight declares the same one — planning/schedule.ts resourceGate, used by work/steps.ts buildSteps
- ported: No plan-only command: a clean plan runs with no extra approval — steps.ts decideStep accepts a clean, reviewed plan; `approve` only for operator-decision findings
- ported: Playbook advice in planning — steps.ts reads planning.playbook; prompts.ts playbookAdvice; the Dream playbook pinned via knowledge/index.ts planningKnowledge
- ported: The accepted plan is posted on the Objective as one comment with a marker, edited in place and never duplicated — steps.ts postPlan, github.ts upsertComment; overflow continues in numbered `plan-data` comments
- ported: `allow <exact command>` answers a planner question by authorizing an exact validation command — steps.ts allowedCommands; facts.ts authorizedCommands takes it, except a CI-only command
- ported: Each planning answer is recorded with the question it answered, who answered and when, and the plan comment lists them — engine.ts saves the open question with each answer; steps.ts records it; the plan comment lists them
- ported: Before a plan is accepted, Factory re-reads the issue and holds if it was edited since planning — steps.ts objectiveChanged and changedHold
- ported: `replan` re-reads the issue and the default branch, reruns the check's checks, and starts a new plan — steps.ts readObjective
- ported: A revision answers with only its changes to the current plan, and the re-review is scoped to what changed — wire.ts applyRevision, prompts.ts revisionScope
- ported: A round that returns the same findings as the last one asks the operator instead of spending more rounds — steps.ts sameFindings
- ported: An invalid planner answer gets one retry that shows the planner the error; repeated failures hold — steps.ts INVALID_ANSWER, invalidAnswer
- ported: Each planning step saves its result, so a restart repeats at most the step that was running — steps.ts keys plan:g:n, review:g:n, decide:g:n and plan; the milestone drill passed 8 of 8 crash points
- ported: AGENTS.md and README.md are context, not Sources, unless the Objective pins them — facts.ts planningSources marks them `context`; wire.ts decodePlan refuses the obligation
- ported: `replan` after the plan is accepted, from any build, final, final-review or report hold — workflow.ts `Workflow.replan`; work/steps.ts replanOutcome, planning/steps.ts planningReplan, rerunCleanupStep

## Planning options

- ported: Execution profiles: the planner assigns a harness per Work Item — providers/config.ts `execution.profiles`; planning/steps.ts `offeredProfiles`; selection.ts providerWorker; frozen by freezeConfig
- ported: Read-only QA Work Items (declared commands and named CI checks); Objectives made only of QA qualify existing bytes — planning/types.ts EXECUTABLE_KINDS; work/steps.ts qaValidateStep, qaReviewStep; delivery.ts observeNamedCheck; review/result.ts reviewQa
- ported: Discovery Work Items and reviewed expansion envelopes — W4-06: work/discovery.ts, planning/expansion.ts expandAt, plan.ts withExpansions, behind `planning.adaptiveGraph`; semantic worker replaced
- ported: Declared work conditions and aggregate nodes — work/steps.ts ready, settleStep, skipStep, conditionUnknown; plan.ts conditionVerdict; graph.ts conditionFindings; behind `planning.adaptiveGraph`
- ported: Graph amendments: worker discoveries, operator `propose-amendment` with review, and replacement amendments — W4-07: planning/amendments.ts; workflow.ts runs a pending amendment first; work/steps.ts `discoveryOutcome`
- ported: `decline-discovery` for an obsolete worker discovery — W4-07: `factory decline-discovery N --item ITEM --reason R` and the `decline-discovery <reason>` answer (amendments.ts `declineDiscovery`)
- ported: Planning context bounds (`planning.context.bounds`) and repository memory (SQLite/FTS) — knowledge/memory.ts applies the bounds; planner lookup rounds in planning/lookup.ts; the old context packet is replaced by kept rounds
- ported: `recipe --file` preview with no model call — cli.ts recipe with recipes.ts markdownBlocks; exits 1 when blocked; core/test/recipe.test.mjs

## Execution and providers

- ported: Codex planning and review (codex-sdk), with gpt-6.1-sol defaults at high/medium/medium — providers/codex.ts CodexPlanner; DEFAULT_CODEX_MODELS is gpt-6.1-sol, planner high, reviewer medium
- ported: Claude planning and review (claude-agent-sdk), with explicit models, maxOutputTokens, and login/OAuth/API key — providers/claude.ts ClaudePlanner: models, maxOutputTokens, login, OAuth token or API key, LoadCredential values
- ported: Per-role reasoning effort, per-phase reviewEffort, and Codex serviceTier — planner.ts ModelChoice and modelChoice (reviewEffort per phase); codex.ts serviceTier; `models` checked at load
- dropped: Codex app-server planning transport (experimental) — dropped (Kirk, 2026-10-23): upstream-experimental owned RPC client; Codex plans via the SDK; retained conversations come through W5-06
- replaced: Provider timeouts and idle bounds, retried within bounds — step deadlines (work/steps.ts), planner.ts IdleWatchdog, retry then hold after 3; validate.ts validationDeadlineMs; Copilot `worker.idleSeconds`
- ported: Codex worker harness with a sandboxed shell and network host|off — providers/codex-worker.ts in Codex's sandbox, `.git` read-only; network from `worker.network` (providers/config.ts, off by default)
- ported: Codex worker model, effort and serviceTier in config (runbook 7.1) — W1-07: `worker.model`, `worker.effort`, `worker.serviceTier` in providers/config.ts; selection.ts resolvedProvider; codex-worker.ts
- ported: Claude worker harness: maxTurns 400, 2 continuations, tools, permissions, setting sources and its file tools — providers/claude-worker.ts with these defaults and every tool; changed through the provider's `worker` object (providers/config.ts)
- ported: FACTORY_CLAUDE_1M opt-in — claude-worker.ts
- ported: GitHub Copilot worker harness — providers/copilot.ts CopilotWorker (Copilot SDK, file tools, model checked before billing); CopilotPlanner is new
- ported: Copilot Validate: the Copilot worker runs the Work Item's declared validation commands, as Claude's Validate does — work/self-validate.ts SelfValidation, shared with claude-worker.ts; providers/copilot.ts serves it as the `run_validation` tool
- parked: Managed execution (openai-agents, claude-managed-agents) with budgetCents and orphan reporting — providers/managed.ts, unused until a drill with real keys qualifies it (Kirk, 2026-10-23: no API keys yet)
- replaced: Custom registered adapters through the library API (AgentHarness, composeWithLocalHarness/Profiles) — the Worker seam (Kirk, 2026-10-23): a `Worker` (work/worker.ts) in providers/, chosen by `worker.kind` (selection.ts providerWorker)
- ported: Multiple named providers, defaultProvider, and `setup --provider NAME` — providers/config.ts `providers.<name>` (planner plus worker); setup.ts `setup --provider NAME`; the first becomes defaultProvider
- ported: Provider selection: a started Objective keeps its frozen provider; `--provider` applies to new work — state.ts `frozen.provider`, frozen at admission (service.ts); selection.ts providerWorkflow; `status` shows selectedBy
- ported: Frozen config digest per Objective, and status explains restore or end — state.ts `frozen` with its SHA-256 digest; a changed key holds with `adopt`, `switch NAME`, `cancel` (providers/selection.ts)
- ported: Never fall back to another provider; a missing login stops and names the fix — providers/selection.ts runs only the frozen provider; login faults hold naming the fix; only a `switch NAME` answer moves providers
- planned: Retained conversations (planner across compile, correction and diagnosis; worker and reviewer continuations) — see Slices; CORE.md reruns a model call and keeps only the worktree
- ported: Concurrent Work Items in isolated worktrees, with owned-path enforcement — work/steps.ts buildSteps, worktree.ts, work/collect.ts owned-path refusal, execution.concurrency
- ported: Host-sized concurrency, capacityRecommendation, and scheduling reservations — capacity.ts, engine.ts HostLimiter (slots plus memory within `execution.memoryMiB`); recommendation shown by setup and `status --capacity`
- ported: Ordered setup and probe commands from Sources, run in each fresh checkout — validate.ts runs an item's commands in order in a fresh checkout; final validation runs declared prerequisites first (finalSequence)
- ported: Worker brief with pinned sources (.factory-inputs), handoff notes (.factory-handoff.json) and verification notes — work/prompt.ts, work/collect.ts; planning/schedule.ts peerNotes; work/prompt.ts stagePeerSources
- ported: The controller owns commits, under the Factory identity; workers get read-only Git — work/collect.ts commits as the Factory identity; codex-worker.ts and sandbox.ts mount `.git` read-only
- ported: Worker isolation: private HOME and CODEX_HOME, no personal configs or MCP, no GitHub/Git/SSH credentials — codex-worker.ts workerHome; claude-worker.ts loads no setting sources; worktree.ts workerEnvironment allow-list
- ported: Provider usage-limit wait until reset, shown in status; retry ends it early — codex.ts codexFailure, claude.ts failedResult, copilot.ts, managed.ts; engine.ts retry waits up to 3 h, else holds (`wait`, `switch`, `cancel`)
- ported: Hedged planner calls: a silent call starts an identical second call; the first answer wins — providers/planner.ts HedgedPlanner around every planner, reviewer and diagnosis call (cli.ts); worker runs are not hedged
- ported: A shared Codex model list, so each private Codex home skips the fetch at start — codex.ts privateCodexHome seeds each home; saveModelsCache keeps a fetched list
- ported: Provider event timing and tracing (FACTORY_PROVIDER_TRACE) — codex.ts codex-event, traceWrapper and keepOrRemove; claude.ts claude-event; codex-worker.ts logs commands and edits
- ported: Host-wide limits on worker runs and validations, plus Work Item steps per Objective — engine.ts HostLimiter and Step.resource; config.ts; cli.ts
- ported: Prompt and workspace instructions per profile, and the Claude worktree-read MCP — `execution.profiles.<id>.instructions` (work/prompt.ts); `worktreeRead: true` MCP in claude-worker.ts; frozen with the profile

## Validation and review

- ported: Validate the exact candidate tree in a fresh checkout: declared commands only, offline, FACTORY_BASE_SHA, private TMPDIR — validate.ts validateTree, every command through sandbox.ts
- ported: Supported dependency bootstrap (npm ci / pnpm frozen with --ignore-scripts) run first; pinned package scripts — facts.ts packageBootstrap; validate.ts runs the bootstrap first and pins package scripts to the base
- ported: finalValidation.requiredCommands — facts.ts objectiveCommandProblems; the plan records finalCommands; work/steps.ts finalStep runs them
- ported: finalValidation.ciOnlyCommands, never run locally and refused in Objectives — refused in Acceptance; facts.ts leaves them out of authorized commands and `allow`; checks.ts ci-only refuses them in a plan
- ported: Flaky check: one fresh rerun when worker Validate passed, then flakyRerun shown in status and the PR — work/steps.ts validateStep ties the rerun to the exact tree; delivery.ts names it in the PR body; status.ts `flakyRerun`
- ported: Final validation of the integrated tree, re-run when other Objectives merged first — work/steps.ts finalStep validates the default-branch head after the last merge
- ported: Independent result review per Work Item against criteria, contract, design checklist and engineering standard — review/result.ts
- ported: Result review knows the item's delivery position and its dependencies' results — work/steps.ts reviewStep and dependencyResults; review/result.ts deliveryRows
- ported: Final Objective review of the integrated tree: every criterion, coverage obligation and integration edge — review/final.ts
- ported: Final review judges only this Objective's merges, with the integrated tree as context — review/final.ts, work/steps.ts finalReviewStep
- ported: reviewArtifacts selectors (stdout, stderr, files, located files) — review/artifacts.ts; config.ts checks selectors once; validate.ts captures; per-stream outputLimit; validation holds on a removed selector
- ported: Image review evidence (receipt and PNG bound to the candidate), with reuse in final review — review/artifacts.ts image selectors (receipt bound to the candidate bytes; 8 images, 64 MiB); codex.ts and claude.ts attach the PNGs
- ported: A controller candidate receipt for review of media candidate sets and the selection — media.ts candidateReceipts; review/result.ts candidateRows and CANDIDATE_GUIDANCE; review/final.ts; planning/rubric.ts CANDIDATE_SETS
- ported: A controller input receipt for review: every read-only input an item's worker got — media.ts inputReceipts, review/result.ts inputRows, work/steps.ts keeps the resolved inputs
- ported: Objective knowledge in review: peers' and items' handoff notes as advisory claims — review/result.ts knowledgeRows; planning/schedule.ts peerNotes and objectiveNotes; work/prompt.ts stagePeerSources
- replaced: Review evidence budget env vars — fixed bounds in review/result.ts, no env vars (Kirk, 2026-10-22)
- ported: `retry --rereview [--review-artifacts]` within resultRereviews — hold answer `revalidate` (work/steps.ts `revalidatable`), charged to resultRereviews; `--review-artifacts N...` names configured selectors
- ported: `retry --retire-command CMD --reason` — hold answers `retire-command <n> <reason>` and `retire <n> <reason>`; planning/plan.ts `retired`, `runnableItem`; work/facts.ts
- ported: `decide --item --criterion` for human acceptance of a criterion, or final acceptance — W2-06: hold answers `accept <n> <reason>` and `refuse <n> <reason>`, bound to the exact tree; planning/plan.ts decisionsOf

## Delivery

- ported: Regular mode: one PR per Work Item, a branch push, and merge commit only, under branch protection — delivery.ts publish and merge on `factory/<issue>/<item>`; github.ts mergePull with the head as guard
- ported: Native-stack mode (linear stacked PRs) — config.ts delivery.kind; planning/units.ts chains; delivery.ts mergeUnit; github.ts findStack, createStack, mergeAsync
- ported: Delete Factory's branch after its PR merges and on cancel, only when Factory made every commit on it — delivery.ts deleteFactoryBranch, work/steps.ts merge step and cancel cleanup
- ported: PR body: Work Item goal, links, changed files, candidate commit and tree, passing commands, no model call — delivery.ts pullRequestBody
- replaced: No duplicate PR after a lost response — the PR is found by its fixed head branch before one is opened, and a push uses a lease (delivery.ts publish)
- ported: Wait for required checks (rulesets and classic protection); failed CI becomes repair with log excerpts — github.ts required checks; delivery.ts judge turns a failed check or conflict into a repair with annotations and log tails
- ported: Update the PR branch when behind base — delivery.ts updateBranch, for a BEHIND PR and a stack layer whose layer below moved
- ported: Closed, draft or stuck PRs become decisions — delivery.ts judge: draft, closed (`republish`) or stuck checks hold; CI waits hold after 3 h; human gates remind after 24 h
- ported: Never bypass branch protection; recommend "require branches up to date" — W6-02 (#1805): readiness.ts recommends it; delivery.ts never bypasses, merging with the head as guard and holding on a blocked merge
- ported: A delivery repair replays the refused change onto the current default branch with a three-way apply — work/steps.ts rebaseWorktree and workStep; a media item's worker still runs
- replaced: Media AssetSets: `select --output DIR`, `select --set --bind` — the select step: media.ts captureAssets, readSelection and materializeSelection; the answer is the set id with `bind ITEM...`
- ported: Git LFS upload on delivery, and LFS hydration for validation — media.ts lfsPushIfPointers, hydrateTree, verifyOriginMedia; sandbox.ts readOnlyFiles; no LFS-paths option (Kirk, 2026-10-22)

## GitHub tracking

- ported: One GitHub issue per Work Item (Task type, label, sub-issue, blocked-by edges, hidden marker) — W3-07: tracking.ts via github-sync.ts `track`; `tracking.issueType`, sub-issue and blocked-by links; queue.ts `addCard`
- ported: Live status comment per Objective, edited in place — progress.ts via github-sync.ts `status`, marker `status:<run>`, from status.ts `statusOf`; at most one edit per 60 s
- ported: Live status comment per Work Item issue — tracking.ts, marker `item-status:<id>`
- ported: New notification comments only for decisions, failures and outcomes; progress.enabled and includeQuestions — github-sync.ts ask, note, failureLines, cancelled; work/steps.ts reportStep; `progress.enabled`, `progress.includeQuestions` (defaults taken)
- in-progress: Project Status sync per phase — Objective cards ported (queue.ts QueueDisplay); missing: Work Item cards get no per-phase Status (tracking.ts adds them with none) (S)
- replaced: Explicit projectStatus field binding, or disabled — queue.field and queue.options in config.ts; "disabled" isn't possible, since Status drives the queue (Kirk, 2026-10-22)
- replaced: Factory reads no human comment as input — reversed: `/factory <answer>` comments from users with write access (github-sync.ts); see Contradictions
- in-progress: Close Work Item issues on merge and the Objective on accepted completion; cancel closes as not planned; duplicates are closed — all ported but duplicates, which #1838 ports (tracking.ts sweep)
- ported: Create the role labels and the native issue types (Feature, Task); priority inheritance — W3-07: github-roles.ts makes the role labels and resolves `tracking.issueType`; tracking.ts applies roles and `P<n>` labels
- ported: Display times in the host zone, with FACTORY_DISPLAY_TIMEZONE — display.ts displayTime in status, logs and GitHub comments (progress.ts, github-sync.ts waiting note, engine.ts reset and deadline notes; #1839)
- ported: A reminder comment after a hold is open 24 h — github-sync.ts remind, keyed by the hold id; crash points `sync:remind:*`; the human-gate reminder in github-sync.ts note

## Holds and decisions

- ported: Every stop is a question with named answers, and each answer works — engine.ts `hold`, state.ts Hold with `options`; listed by `status --json`, the text status and the question comment
- ported: A hold whose fix is a configuration change names the restart it needs — validate.ts and delivery.ts ensureStack name the restart; no hot reload (Kirk, 2026-10-22); a frozen config per Objective instead
- ported: An operator wait on a Work Item blocks only that item and its dependents — state.ts `holds`, engine.ts `heldBy` and objectiveWide, service.ts slots, github-sync.ts one question comment per hold
- replaced: Answer from the CLI: `factory answer ISSUE ANSWER --question ID [--text | --text-file PATH]` — cli.ts answer
- ported: Stale-answer protection: refuse an answer when a different question is open (question digest) — answers bind by hold id; an unbound comment applies only to one shown hold (state.ts `Hold.shownAt`, `lastShownAt`; engine.ts answer)
- ported: The director skill asks holds with AskUserQuestion, recommended answer first — skills/director/SKILL.md, rewritten for the core CLI; renders each hold's `options` from status JSON
- ported: Autonomy allowances, perPath caps and repairClasses, snapshotted; running out stops for a decision — allowances.ts, config.ts `autonomy.allowances` (frozen); `more`, `replan`, `cancel`; repairClasses replaced by hold causes (Kirk, 2026-10-23)
- ported: autonomy.requiredEnvironment secrets checked before planning — workflow.ts check step holds naming missing names; config.ts refuses disallowed and GH_/GITHUB_/GIT_/SSH_ names; core/test/service.test.mjs
- ported: policy.allowedSecretNames passed by name and redacted from output — config.ts secretValues, worktree.ts workerEnvironment, github.ts `redacting`, display.ts redactDeep, delivery.ts secret refusal
- in-progress: Predecessor blame: a failure in a merged predecessor's file stops with a decision and spends no repair — repair.ts, steps.ts mergedBlame, blameAmendment; missing: the merged-blame repair stays charged and an overrun asks first (S)
- ported: `fail` holds with retry, replan and cancel — state.ts `HoldCause` `failure`; engine.ts hold adds `replan` (workflow.ts `replannable`); `needsText` enforced

## Recovery and restart

- replaced: Crash or restart reconciles issues, PRs and merges by stable identity, with no duplicate effects — crash-only steps plus GitHub lookup (engine.ts, state.ts, crash.ts, delivery.ts, work/steps.ts); GitHub crash points owed to the drill
- replaced: Reattach running workers; `collect` freezes a return that finished while the controller was down — workers die with the service and the work step reruns on its kept worktree; the `collect` command goes
- ported: Abandoned in-flight model calls start fresh — engine.ts reruns an interrupted step; service.ts crash-loop delay and a hold at three deaths
- ported: Automatic repair: review findings become a correction; failed commands go to diagnosis (repair, question, or blame) — repair.ts correction (the first review refusal, else diagnosis); an operator question holds; `predecessor` blame
- ported: A repair continues from the refused result, three-way rebased onto a moved base; `--fresh` starts from base — kept worktree and three-way apply (work/steps.ts); `--fresh` replaced by the `fresh` answer (engine.ts, work/steps.ts `freshOutcome`)
- ported: Facts that must outlive a repair are kept apart from the step results a repair clears — engine.ts Outcome.keep into state.kept; work/steps.ts
- ported: `revalidate` on a Work Item hold re-checks a kept refused result with no worker run — work/steps.ts revalidatable, refusedResult and workStep; engine.ts offers it
- ported: An operator's media selection stands across a repair that isn't about the media — work/steps.ts KeptSelection and aboutMedia; work/prompt.ts mediaContract
- ported: A repair stops the running steps it clears, so a late outcome of cleared work is never saved — engine.ts abortRunning
- replaced: `repair --proposal FILE` for an operator-diagnosed correction — implementation repairs by `answer <text>` (work/steps.ts repairContext); the planning half by the `replace <correction>` answer (W4-07)
- ported: Usage-limit and transient errors retry with backoff — engine.ts retry classes every wait by its cause; github.ts githubOutcome
- replaced: Git checkpoints to a private archive (gitPersistence), with `persistence status|sync|inspect|maintain` — state is rebuilt from GitHub (`factory reset N`, reset.ts); learning and receipt archiving dropped (Kirk, 2026-10-22)
- replaced: Restore on another machine (`persistence restore`, `reconcile`) — `factory reset N` (reset.ts `rebuild` step) from the plan comment, PRs by head branch, the report and a closed issue
- replaced: An archive bound being exceeded stops with exit 2 — there is no archive; log retention is 20 runs and 2 GB (log.ts rotateLogs)
- ported: Retention of finished Objectives, with worktrees and logs reclaimed — log.ts; work/steps.ts reportStep and cancelCleanupStep; state.ts finishState and findState (objectives/finished/)
- ported: An incompatible state version is refused with guidance — state.ts STATE_VERSION and service.ts hold with `reset` and `cancel`; github-sync.ts reads `/factory reset` and `/factory cancel`

## Learning and knowledge

- ported: `dream --record`, preview, approve or reject by digest, `--show`; the playbook is pinned per Objective — knowledge/dream.ts and store.ts, `factory dream` (cli.ts); the service applies writes (dream.ts applyDream); blocking on interrupted calls replaced
- ported: `propose --source DOC#HEADING` drafts Objectives; `--approve SHA [--enqueue]` publishes issues, dependencies and cards — W4-14 (#1832): proposals.ts, `factory propose` through the Planner seam
- ported: Repository memory for adaptive planning — knowledge/memory.ts (queryMemory, retain), service.ts `observer`; every role reads it; the memory export is replaced

## Telemetry and diagnostics

- ported: `status` without an Objective shows service, queue, active Objectives and holds — status.ts statusText; the list hides Objectives finished over 24 h ago, `--all` shows them (default taken, 2026-10-23)
- ported: `status --objective N [--json]`: phase, Next command, Work Item table, provider, plan, allowances and repairs — status.ts `statusOf` as text or `--json`: `nextAction`, Work Item table, frozen config, allowances, holds (default taken, 2026-10-23)
- ported: `status --issue N|URL` resolves a Work Item issue — W3-07: status.ts `issueFocus`, from local state only; an unknown issue is refused `no_factory_state`
- replaced: Status names a command only while Factory would accept it; prerequisiteGuidance — status names only commands Factory accepts now (`nextAction`), and each hold names its fix (default taken, 2026-10-23)
- in-progress: `watch` live view (liveness, turns, context, compactions, no-progress, last 8 tool calls) — watch.ts and the `worker-activity` event (work/worker.ts `activity`); missing: context size, compactions, no-progress, validation-failing time
- ported: `factory log` reads an Objective's run log, and `status` reads the end of it (CORE.md#Process model) — cli.ts `log ISSUE [--tail N] [--follow] [--json]`; log.ts readLog; status shows the last event
- ported: `diagnostics` timeline, `--follow`, `--logs ITEM`, `--summary` — diagnostics.ts: `--follow`, `--logs ITEM [--show-captures]`, `--summary`; the run log in log.ts (default taken, 2026-10-23)
- ported: Content capture (prompts and responses, 0600, byte cap, retainInRecovery) — log.ts RunLog: `capture.enabled` (off by default, Kirk), 0600, `capture.maxBytesPerCall`; `retainInRecovery` replaced (no archive)
- ported: Token and cache accounting per role and phase; native Codex telemetry — providers/usage.ts model-usage, codex-telemetry.ts; diagnostics.ts --summary, analysis.ts, scorecard.ts
- ported: `diagnostics --captures`, `--analyze`, `--gantt` — analysis.ts: `--captures`, `--analyze`, `--gantt` (text lanes, `--json`; the SVG replaced by stdout, default taken 2026-10-23)
- in-progress: Old formal-history fields with no run-log field (observer sequence, write-failure counters, digests, attempt ids) — gap, needs Kirk's approval: old formal-history fields (observer sequence, write-failure counters, digests, attempt ids) have no run-log field
- in-progress: Old per-call analysis fields with no run-log field (digests, staged outcomes, TTFT, request bytes, transport) — gap, needs Kirk's approval: old per-call fields (digests, staged outcomes, TTFT, request bytes, native usage, transport) have no run-log field
- ported: `diagnostics --scorecard`, including the codex-direct comparison — W5-04 (#1835): scorecard.ts, cli.ts `diagnostics --scorecard FILE [--json]`, codex-direct packets
- ported: `export-captures` OTLP preview then authorized send — W5-05 (#1833): capture-export.ts, a preview by default, `--send --endpoint URL --authorize DIGEST`
- planned: Library analysis API (readInteractionMetadata etc.) — see Slices
- dropped: Diagnostics older than the 20-run retention window — they are lost (Kirk, 2026-10-22)

## Setup and service

- ported: Plugin for Codex and Claude Code (setup and director skills), plus an attested CLI tarball — W6-05 (#1827): bin core/dist/cli.js, prepack, release tests/packs/attests; skills/setup rewritten
- ported: `setup --config-only` writes and verifies config with JSON status; idempotent; refuses a conflicting option — setup.ts: verifies the file loads (restoring it if not), checks origin and the Project field; a repeat reports `changed: []`
- owed: `setup --background` checks readiness, then installs and starts the systemd user service — setup.ts serviceSetup, systemd.ts, `--check`/`--stop`/`--uninstall`; owed: a live install, check, stop and uninstall on a host
- ported: A blocked setup gives one prerequisite checklist — setup.ts with readiness.ts: one checklist of `ok`, `warn` or `blocked` checks with fixes
- ported: Setup options for delivery, network, planning transport, models, tools, outside-directory and credential-file — setup.ts options; `--credential-file` in systemd.ts; `--outside-directory` replaced by readiness's sandbox probe; `--planning-transport` dropped with the app-server transport (Kirk, 2026-10-23)
- ported: Service credentials through systemd LoadCredential — `setup --background --credential-file NAME=FILE`; providers/claude.ts serviceCredential
- replaced: `supervisor start|check|stop|upgrade|uninstall` with a rollback hint — `setup --background|--check|--stop|--uninstall` (systemd.ts); upgrade reruns `--background`, rollback is `--uninstall`
- ported: An idle service makes no model calls — service.ts: only the check step runs
- ported: A held or failed Objective holds only itself — engine.ts; service.ts tick gives no slot to a holding Objective; github-sync.ts backs off per Objective
- replaced: Installation-wide holds for auth (401/403) and disk faults, lifted by queue resume — each Objective holds at once naming the fix (github.ts githubOutcome, providers, engine.ts), and `retry` lifts it
- ported: The first run checks host and worker readiness without model calls — readiness.ts, run by setup: sandbox, pasta, PATH, package store, SDKs and logins, Codex sandbox probe, GitHub access
- ported: Validation environment report, and a warning for network tools in scripts — facts.ts networkToolOfCommand, checks.ts network; readiness.ts `readiness.validationEnvironment` warnings

## Safety

- ported: Refuse Factory's own repositories, local-path origins and mismatched fetch and push URLs, before every fetch and push — git.ts remoteGit, originProblem and originBound for every remote call; config.ts ownRepositoryProblem; planning/steps.ts readObjective
- ported: Config and state live outside the target checkout — config.ts configPath, paths.ts stateRoot; loadConfig refuses either inside the checkout, by given and real path
- ported: bubblewrap sandbox for every worker-caused command; refuse without bwrap; refuse as root — sandbox.ts runSandboxed, ROOT_REFUSAL, sandbox.required; Codex workers in Codex's own sandbox (codex-worker.ts)
- ported: Sandbox setup failures are config faults, not the candidate's failure — sandbox.ts returns a fault; validate.ts turns it into a hold
- ported: sandbox.network package-install (registry-only through pasta) and packageStore — package-network.ts, sandbox.ts, config.ts
- ported: sandbox.readOnlyPaths, and sandbox.environment with a deny-list — config.ts sandboxSection, sandbox.ts
- ported: Sandbox limits (tmpMiB, homeMiB, checkoutMiB, files, candidate size, processes) — config.ts sandbox.limits, sandbox.ts, work/collect.ts candidate bounds
- ported: Refuse gitlinks and submodules — worktree.ts hasGitlink, used by collect.ts, validate.ts and claude-worker.ts
- ported: Pre-publish scan: changed-path ownership, unsafe links and special files, Secretlint by rule and path — work/collect.ts; `policy.secretlintConfig`; publish secret scan (git.ts secretNeedles, media.ts lfsObjectsHoldingSecrets, delivery.ts)
- ported: Fixed acceptance scripts and package-manager metadata protected unless authorized — facts.ts fixedScripts; validate.ts pinRefusal enforces them
- ported: Controller PATH guidance: refuse protected PATH dirs and exclude its own bin — sandbox.ts toolchainDirectories; worktree.ts workerToolchainPath drops Factory's own launcher
- ported: Credentials stay with the service; workers never see them — github.ts keeps the token; worktree.ts environments; codex-worker.ts proxyPolicy; providers/config.ts; providers/managed.ts
- ported: Only users with write access can answer through comments — github.ts canWrite; an answer about access counts for 10 minutes
- ported: A non-writer's issue is planned only after a writer approves its visible text; hidden content never reaches a model — planning/steps.ts readObjective and authorHold; shown.ts readShown over `body_html`; approval bound to the shown digest
- ported: A delivered branch counts as Factory's only with its own commits and update-branch merges that add nothing — delivery.ts updateMerge, used by updates and factoryMade

## Tests and drills

- ported: CI covers each stability rule it can reach without GitHub or a model — core/test/service.test.mjs
- owed: Crash points around GitHub effects, skipped in CI and drilled on the scratch repository — owed for the drill suite: sync:remind and sync:cancel before/after; plan:data ported (`FACTORY_COMMENT_LIMIT`); 26 of 30 drilled 2026-10-22
- ported: The slice gate drill: cut the network and stop a model mid-turn on a real Objective — drilled 2026-10-22 on the stability build; the drill suite repeats it on demand
- ported: A test that bounded cost holds (rule 6) — drilled 2026-10-22 through a counting proxy: 2 GraphQL requests per poll plus one comment read per unfinished Objective
- ported: A CI test of step order (CORE.md#Testing lists it) — core/test/service.test.mjs runs the real service on a two-item plan with GitHub down

## Milestone log

- **2026-10-22, Planning (slice 2).** Planning and the planner and reviewer providers are ported and wired into the workflow. A drill accepted a plan end to end, answered a planner question by a `/factory answer` comment, then revised and accepted the plan, and passed 8 of 8 crash points. Ledger counts after this update: 48 ported, 16 replaced, 30 in progress, 103 planned, and 1 gap (198 lines). A line counts as ported or replaced only when nothing in it is left for later. A line that is partly ported counts as in progress. A line with only a slice or planned mark counts as planned. Planning capabilities still not ported:
  - Edits to the Objective after the plan is accepted: slice 3.
  - Binding CLI answers to the question they answer: slice 5.
  - Refusing a malformed Quality checkpoint or Package manager update section, and parsing Workspace package additions: slice 3 (checked when validation is ported).
  - Validation side of planned facts (required commands, bootstrap, package manager pin, workspace additions, fixed scripts): slice 3.
  - `requiredEnvironment` checked before planning: slice 3.
  - Design checklist in workers and review, and the worker side of provider login holds and usage-limit waits: slice 3.
  - Running aggregates, scheduling use of hints, and the delivery re-check of CI check names: slice 4.
  - Objective dependencies through blocked-by: slice 5.
  - Execution profiles, discovery items, expansions, conditions, amendments, `decline-discovery`, recipes, planner-requested context lookups, memory in worker prompts, child Objective issues, QA execution and source asset import: slice 6.
  - Several named providers, provider selection, retained conversations and the Codex app-server transport: slice 6.
  - A frozen config per Objective: slice 5.
- **2026-10-22, Execution (slice 3) and concurrency.** Execution is ported onto the core: worktrees, Codex and Claude workers, the sandbox, validation, result review, repair, regular PR delivery with CI and merge, final validation, final review, the report and cancel cleanup. Several Work Items and several Objectives run at once, with owned-path waits and host-wide limits; this came forward from slices 4 and 6. Drills on the scratch repository finished a single-item and an 8-item Objective, ran 3 Objectives at once with an owned-path wait, passed 7 of 7 crash points, repaired a CI failure on the same PR, and cancelled during 8 workers and during CI with PRs closed, worktrees removed and no processes left. Ledger counts after this update, by the same rules: 90 ported, 20 replaced, 34 in progress, 62 planned, and 1 gap (207 lines). Execution capabilities still not ported:
  - Refusing a malformed Quality checkpoint, Package manager update or Workspace package additions section at the check (validate.ts declarationProblems exists but is not called): slice 5.
  - Predecessor blame, `requiredEnvironment`, `--fresh` repairs, closing a cancelled Objective as not_planned, flaky reruns in status, and the policy.allowedSecretNames setting: slice 5.
  - The repair budget and other allowances in config (resultRereviews, perPath, repairClasses, snapshotting): planned, no slice yet.
  - Comparing Source files changed on the default branch after planning: no slice yet.
  - Scheduling by the plan's hints, and sharing worker notes with peers: slice 4.
  - Native stacks and LFS delivery: slices 4 and 6.
  - QA and discovery items, execution profiles, conditions, capacityRecommendation and scheduling reservations: slice 6.
  - Worker settings in config (Codex network host, Claude tools, permissions, setting sources and maxTurns), the origin check before a fetch, refusing Factory's own repositories, and the branch-protection recommendation: slice 7.
  - The Decisions entry and CORE.md#One at a time still say one Objective at a time; the code runs up to queue.maxActiveObjectives (default 3).
- **2026-10-22, Delivery modes (slice 4).** Native stacks, media and LFS, review artifacts, scheduling hints and peer notes are ported and wired into the item steps. Media came in from slice 6: source asset import, candidate capture, the select step with binding, LFS upload, hydration and origin verification, and the controller candidate receipt. Review artifacts and image review evidence came in from slice 6 too. Drills on the scratch repository, each finished and closed as completed:
  - Drill 51, a native stack of 3 layers plus an independent item: the stack merged as one, with one shared merge commit (353cc13), after CI repairs on the bottom and middle layers and a recovery from a stale upper layer (built on an older head of the layer below, then moved onto the current one).
  - Drill 57, glb and png candidate sets: the operator chose a set that was not the recommended one, and the LFS pointers were verified on origin.
  - Drill 59: the selection stood across a CI repair that wasn't about the media, every LFS file was restored for validation, and `revalidate` recovered a result Factory's own check had refused.

  Gaps the drills found, all fixed on this milestone: steps kept running after a repair cleared them and could save stale results (engine.ts abortRunning); the reviewer had no record of the candidate sets (the controller candidate receipt); an unrelated repair made the operator select again (the selection stands); validation restored only the selected members, not the LFS files already in the repository (hydrateTree restores every LFS file); and there was no way to resubmit an unchanged result after a wrong refusal (`revalidate`).

  Ledger counts after this update, by the same rules: 107 ported, 21 replaced, 27 in progress, 57 planned, and 1 gap (213 lines). Delta from the slice 3 milestone: +17 ported, +1 replaced, -7 in progress, -5 planned, +6 lines. Of the lines that became ported, 5 had been done by the lean sweep after slice 3 and were still marked open: refusing malformed Quality checkpoint, Workspace package additions and Package manager update sections at the check, and the Codex and Claude worker settings in config. Still not ported from this area:
  - Peers' notes in result review, and every item's notes in final review: slice 6 (found at this milestone; the old tree had them).
  - Secret values weren't redacted from GitHub writes (found at this milestone); fixed at the GitHub write choke point.
  - `retry --rereview` from holds other than repair diagnosis, `--review-artifacts` and the resultRereviews budget: slice 5.
  - Setup flags for delivery and the worker settings: slice 7.
  - QA and discovery items, execution profiles, conditions, capacityRecommendation and scheduling reservations: slice 6.

- **2026-10-22, Knowledge (slice 6, part).** The curated playbook, repository memory and Dream are ported (`knowledge/*`). Planning gets them through one hook in planning/steps.ts planningFacts, and the service records memory through `observer` (service.ts). Crash tests kill real `factory dream` processes at the store's commit points, and a service test retries a failed observation and keeps one episode per run across restarts and `--record`. Local runs with real Codex Dream calls approved two playbook versions and checked pinning across three Objectives. There is no scratch-repository drill yet. Ledger counts after this update, counted by each line's first status mark: 116 ported, 24 replaced, 21 in progress, 51 planned, and 1 gap (213 lines). Delta from main after #1772, counted the same way: +1 ported, +3 in progress, -4 planned, no new lines. Dream became ported; Adaptive workflow, planningContext bounds and repository memory became in progress. Knowledge capabilities still not ported:
  - Planner-requested context lookups (maxRounds, maxRequestsPerRound and maxProviderCalls), which need a lookup turn in planning/wire.ts and the providers: slice 6.
  - Memory in worker prompts (old src/adaptive-context.ts), which needs a hook in work/prompt.ts: slice 6.
  - Discovery items, recipes and expansions turned on by Adaptive workflow: slice 6.
- **2026-10-22, Stability pass over slices 1 to 3.** An audit of the merged slices against the design plan confirmed gaps in stability, and this pass closes them in the mechanisms: a comment that can't be checked no longer blocks the ones after it; sync jobs back off per Objective and a finished Objective syncs once; every GitHub error outside delivery is classed the way delivery classes it; waits are classed by cause (CORE.md#Waits) instead of a 6 h cap; replan, cancel and re-queue close every PR under `factory/<issue>/`, remove every worktree and reset Factory's own earlier branches; re-queue stops the old run before the new one exists; the check runs when an Objective is first seen; holds and path waits take no slot, and path order follows plan acceptance; finished Objectives leave memory and the queue read follows the Project; large plans continue in marked comments; unreadable state is shown and answered on GitHub; every answer keeps its question; every GitHub effect has crash points. The ledger was also wrong in the other direction (declarationProblems is called by the check, cancel closes the issue as not planned, config has the worker settings and policy.allowedSecretNames); the slice 4 milestone had already corrected those lines. Moved into slice 5: `factory reset` and `factory log` (they had no slice), comparing Source files changed after planning (it had none), and configurable step deadlines. Owed: the network-cut and model-stop drill for every slice so far, the GitHub crash points, and a bounded-cost check.

  Ledger counts after this update, rebased onto the Knowledge milestone and counted the way it counts (each line's first status mark): 117 ported, 24 replaced, 22 in progress, 52 planned, 3 owed (tests and drills, not capabilities) and 1 gap (219 lines). Delta from the Knowledge milestone: +1 ported, +1 in progress, +1 planned, +3 owed, +6 lines. New lines: re-queue runs again (ported), the CI stability loop (ported), `factory log` (planned) and the 3 owed tests. Changes inside lines: provider timeouts note that configurable deadlines are slice 5, an incompatible state version goes from ported to in progress, and installation-wide auth and disk holds are replaced by per-Objective holds.

- **2026-10-22, Review fixes to the stability pass.** No capability removed; restored or added: dequeue before planning (old Factory's withdraw, now by moving the card out of Queued), reorder until an Objective starts, and a `reset` answer when a Factory branch holds someone else's commits. Mechanisms changed: the queue acts on Status edges (GitHub's option time against Factory's own last write), not levels; the Project read is filtered to queued cards by GitHub; wait budgets are per class; only real rate limits wait for a reset; gate waits take no slot; branch reset needs every commit beyond the default branch to be Factory's; marked comments count only from Factory's login; unchecked comments wait in a bounded retry list; a transient state-file read error retries. Still owed: the drill for these GitHub paths (no CI coverage without GitHub). Ledger counts are unchanged from the stability pass: 117 ported, 24 replaced, 22 in progress, 52 planned, 3 owed and 1 gap (219 lines).

- **2026-10-22, Stability drill fixes.** The drill found three defects; no capability removed. An interrupted step is no longer an error: it reruns at once, and crash-loop protection moved to the service (a resume delay from the third quick restart, and a hold only on the one step running at three deaths with progress between). Dequeue now reads a change from queued against the option Factory last saw or wrote, so clearing the field or removing the card dequeues, and Status is never written over the operator's change. Queuing a finished Objective whose issue is closed reopens the issue. Report and cancel cleanup remove the whole work directory. Ledger counts are unchanged.

- **2026-10-22, Stability pass reconciled with providers and knowledge.** The stability pass is rebased onto #1772 and #1771; no capability removed. The usage-limit `switch` answer now works on named providers: `switch NAME` (plain `switch` when exactly one other provider is configured) changes the Objective's frozen provider and settings, `selectedBy: "switch"`, and the question names the other configured providers; the old planning.provider and execution.workerProvider fields are gone from the stability code. Copilot quota and weekly limits, and managed 429s with Retry-After, are classed as resets. The knowledge observer sees every end of a run: a re-queue and a withdraw release the old run before its state is replaced or removed (the admission or the withdraw waits if the release fails), and a finished Objective leaves memory only after its settled observation, so at startup a settled Objective stays until it is observed once. Approved marks applied (Kirk, 2026-10-22): two hosts on one admission and diagnostics past the retention window are dropped; learning and receipt archiving under gitPersistence is dropped; `queue add` consent, projectStatus binding and review evidence env vars carry the approval of their replacements; managed execution's snapshot replacement is approved and the entry stays in progress, not live-qualified. The LFS-paths and hot-reload marks belong to the #1777 branch and are not applied here.

  Ledger counts after this update, counted the same way: 117 ported, 24 replaced, 22 in progress, 50 planned, 3 owed, 2 dropped and 1 gap (219 lines). Delta from the stability pass: -2 planned, +2 dropped, no new lines.

- **2026-10-22, Plan-compare and simplification fixes.** Eight verified defects fixed by cause; no capability removed. Final validation's ancestor check retries on a Git error instead of holding (worktree.ts isAncestor, shared with delivery). The refused result is one kept fact (commit, tree, notes) written by repairOutcome for every repair, so a stack layer above no longer leaves a stale tree for collection. git.ts has one checked blob reader and one size reader, so a missing object is an error, not a misparse. An empty change is decided by GitHub's compare status, not its error text. Claude worker settings and planner models are checked when the configuration loads. The secret set is derived once and includes managed-provider credentials. An open question pauses other steps' wait clocks, with no pseudo-retry, false status note or 3 h question from human time. Settled Objectives move to objectives/finished/, so startup reads and observes no history, and observation has a 5-minute deadline. Two service tests were added or extended (the paused clocks; the move to finished/ and no history read at startup). Still owed: the step-order CI test. Ledger counts are unchanged.

- **2026-10-23, Whole-system security review fixes.** Ten of the eleven confirmed findings fixed by cause; no capability removed. A local source asset comes only from operator-configured `media.localAssetRoots` (off by default) and never from what the sandbox seals, checked in the plan and at the copy. An issue a non-writer wrote is planned only after a writer approves its visible text (bound to its digest), and hidden markdown never reaches a model; queue consent stays the Project field. Claude workers refuse project and local settings. Publish refuses a result carrying a config.secrets value, as written or base64. Write-access answers expire after 10 minutes. Managed archives are read without links. A Codex worker's shell holds no proxy credential. A web-flow merge counts as Factory's only when its tree is the merge of its parents. The owed step-order CI test is added. Still owed: the reset finding on the unmerged slice 5A branch (reset trusts the first json block of the plan comment), which that branch fixes. Ledger counts after this update, counted the same way: 120 ported, 24 replaced, 22 in progress, 50 planned, 2 owed, 2 dropped and 1 gap (221 lines). Delta from the plan-compare fixes: +3 ported (2 new lines, for issue-body authority and web-flow merges, and the step-order test), -1 owed, +2 lines.

- **2026-10-23, Live drill defect fixes.** The main-build drill's defects and the Copilot baseline's, fixed by cause; no capability removed. A rerun after an interruption resets a worktree whose base was never kept onto the base it picks, so a moved default branch no longer gives a false "Worker changed HEAD" repair (D3). The engine removes a kept fact a step forgets, so no reader sees `null`; a second repair's kept selection no longer crashes (D4). A GitHub attachment may redirect to GitHub's own S3 buckets by exact name (D1). Result and final review get a controller input receipt with digest-checked copies of the worker's inputs, so source-asset Objectives no longer hold twice for `accept` (D5). Repository memory keeps a record that cites any admitted path, with only its admitted paths (D6). Episodes count native-stack lower layers as merged (D8). FACTORY_PROVIDER_TRACE copies across filesystems and logs a failure (D9). Copilot checks its model list before any billed session, and a model hold asks for the setting and `switch NAME`, which now also re-freezes the same provider's changed settings (C1, C2). Factory deletes its own branches after merge and on cancel. D7 was already fixed by ordering path waits on plan acceptance; the paths-wait CI test now seeds the later-accepted Objective as the lower issue, which fails under issue ordering. D2 and D10 were already fixed in the stability drill round. Still owed: the drill for the new branch-delete crash points. Ledger counts after this update, counted the same way: 122 ported, 24 replaced, 22 in progress, 50 planned, 2 owed, 2 dropped and 1 gap (223 lines). Delta from the security review fixes: +2 ported (2 new lines: the review input receipt and branch deletion), +2 lines.

- **2026-10-23, #1779 review batch.** Seven causes fixed from the review of the new commits; no capability removed. visibleMarkdown parses CommonMark + GFM (micromark) instead of scanning lines, so an escaped backtick, a fence inside an HTML block and multi-line reference definitions no longer let hidden text through, and a parse failure holds; a service test checks the approval digest of four golden bodies. The pre-publish secret refusal matches whole values (8+ characters) and key-material pieces only, so PEM armor, JSON lines and short values no longer hold, and `publish` lets one exact finding through. A proxy without a scheme is read as http:// before its credential is stripped. A stack layer's update-branch merge from its predecessor branch counts as Factory's. Select and publish media repairs no longer record the refused tree, so a correct fix isn't refused as no change. An answered question no longer moves a human gate's start, so its reminder isn't posted twice. An unavailable frozen provider offers `switch NAME`. Still owed: the drill checks for these paths. Ledger counts are unchanged: 122 ported, 24 replaced, 22 in progress, 50 planned, 2 owed, 2 dropped and 1 gap (223 lines).

- **2026-10-23, #1779 review batch 3.** Six causes fixed from the third review; no capability removed. visibleMarkdown also cuts footnote definitions no shown text references, as GitHub hides them (a fifth golden body). A secret hold keeps its finding's digest, and `publish` is checked against that, never against the question's text, which quotes worker-chosen paths. A repair keeps every cleared work result's commit as its own replay fact, so a lower stack layer's publish or select repair, or a publish conflict, no longer wipes a change on rebase; only the repaired item's own refused fact depends on whether the repair refuses its result. The Copilot model-list hold offers `retry`, which bills nothing. The provider-unavailable hold offers exactly the `switch` targets the engine accepts (engine.ts switchTargets). A partly admitted memory record is stale when any cited file changed. Still owed: the drill checks for these paths. Ledger counts are unchanged: 122 ported, 24 replaced, 22 in progress, 50 planned, 2 owed, 2 dropped and 1 gap (223 lines).

- **2026-10-23, #1779 review batch 4.** One cause fixed structurally; no capability removed. Four review rounds each found a markdown construct where visibleMarkdown disagreed with GitHub, so GitHub's renderer is now the authority: at check and replan, the planning text's POST /markdown rendering must show the same visible text as the issue's body_html, or the check holds fail closed with the first difference (`recheck`, `cancel`). One render per body digest, kept in state. visibleMarkdown stays the producer: only the first definition per label counts, so a duplicate footnote definition is cut and its references no longer decide what else is shown, and a link definition that shown text references is kept (cutting it would show `[text][label]` and hold every reference-style link). The service golden test now serves body_html and /markdown: seven bodies pass, a mismatch holds. Still owed: the drill check of body_html against /markdown on real GitHub. Ledger counts are unchanged: 122 ported, 24 replaced, 22 in progress, 50 planned, 2 owed, 2 dropped and 1 gap (223 lines).

- **2026-10-23, #1779 review batch 5.** One cause fixed structurally; no capability removed. Comparing GitHub's rendering of the body with its rendering of the filtered text caught only over-cutting: text hidden in both (image alt, link and reference-definition titles, raw HTML attributes, sanitized content) still reached the planner. The planning text is now derived from what GitHub shows: shownMarkdown converts the issue's `body_html` to Markdown, one source of truth. visibleMarkdown, renderedHold, POST /markdown and its kept digest are removed, which also removes the secret-redacted /markdown request that could hold forever. The split-child marker is read from the raw body as structure and kept as `child` on the generation inputs. Approval digests and edit detection (objectiveChanged, objectiveEdited) use the shown text. The service golden test serves micromark-rendered `body_html` and checks one body whose comment, alt, titles, attribute and unreferenced footnote never reach the approved text, while headings and task lists do. Mermaid `%%` comment lines are dropped (the diagram never shows them). Residual, by design: math sources are kept as code, so a TeX colour trick still reaches the planner as code, and code-block language names GitHub doesn't keep are lost. Still owed: the drill run that plans from `body_html` on real GitHub. Ledger counts are unchanged: 122 ported, 24 replaced, 22 in progress, 50 planned, 2 owed, 2 dropped and 1 gap (223 lines).

- **2026-10-23, #1779 review batch 6.** Three causes fixed; no capability removed. The converter wrote shown text with Markdown escapes, so unbackticked Sources paths (`src/\_internal.ts`), heading anchors (`\[draft]`) and prose asset paths no longer matched: text is now written verbatim (markdown.ts `text` handler; a line break is a newline, not a trailing backslash; only `|` in a table cell stays escaped), and strong is written with `_`, so `x/__tests__/a.ts` round-trips. A shown line that would parse as a heading or fence starts with U+200B, so a `\## Acceptance` paragraph can't open an Objective section. A blank issue-form field (`<p><em>No response</em></p>`) is recognized in the HTML tree and becomes `_No response_`; githubEmptyField also accepts `*No response*`. Mermaid `accTitle`/`accDescr` lines and blocks are dropped, and other diagram types (geojson, topojson, stl, unknown) show as `[<type> diagram]`. The service golden adds unbackticked `_`, `__tests__` and `&` Sources paths, a `#Heading [draft] *x* & y` anchor, a shown `## Acceptance` paragraph, a blank Package manager update field and a mermaid block with hidden lines. Residual, by design: a single-`_` emphasis pair in an unbackticked path (`docs/_draft_.md`) or a `**bold**` heading anchor comes back with the other marker; backtick them. Ledger counts are unchanged: 122 ported, 24 replaced, 22 in progress, 50 planned, 2 owed, 2 dropped and 1 gap (223 lines).

- **2026-10-23, #1779 review batch 7.** One cause fixed structurally; no capability removed. Seven rounds found mismatches between what GitHub shows and what the Objective parser read, because structure came from a round trip: HTML to Markdown text, then line regexes (a `<br>` in a heading wrote a setext heading, so an Out of scope command became an Acceptance command; a shown ``- `cmd` `` paragraph line became a bullet; intraword bold became entities in paths). The structure now comes from GitHub's rendered tree: shown.ts readShown parses`body_html`once and returns the blocks (headings, list items, paragraphs, code blocks, blank fields; commands, paths and pins from`code`elements), the inline code elements and the planner text. objective.ts checkObjective, validate.ts declarationProblems and adaptiveWorkflow, prompts.ts packageManagerUpdate and the quality checkpoint, facts.ts final commands, coverage, Sources and Objective command authority, the media and local-asset checks and final review's criteria all read the blocks; the generation inputs keep the shown Objective and whether the author can write. A paragraph in Acceptance or Sources is its own entry and never joins the item before it. The planner text keeps default Markdown escapes (the U+200B line marker, the`_`strong choice and the verbatim text handler are gone). A non-writer's mermaid diagram and math are`[mermaid diagram]`and`[math]`in the planner text and the approval digest, and the approval question says so; a writer's stay as source (the mermaid line filter is gone). Edit detection and the approval use one digest of the structure, code spans and planner text. parseObjective on Markdown is removed: core has no runtime Markdown Objective input (child Objectives are read from GitHub like any issue; core has no`recipe --file`). Read-only check on clockgrove/factory-drill #51, 57, 59, 84, 88, 89, 93, 103, 106 and 122: Goal, Acceptance, final commands and Sources match the old parse of the raw body on every real Objective; #122 is a render probe with no Acceptance in both. Changed by design: an unbackticked path with intraword bold (`x/**tests**/a.ts`) reads as shown (`x/tests/a.ts`); backtick it. Ledger counts are unchanged: 122 ported, 24 replaced, 22 in progress, 50 planned, 2 owed, 2 dropped and 1 gap (223 lines).

- **2026-10-23, #1779 review batch 8.** Five causes fixed; no capability removed. Shown inline text dropped emphasis and strikethrough, so unbackticked `pkg/__init__.py` and `src/__tests__/a.ts` read as `pkg/init.py` and `src/tests/a.ts`, a `#Step *y*` anchor lost its heading and a struck Acceptance criterion read as required: shown.ts inline writes strong as `__text__`, emphasis as `_text_` and struck text as `~~text~~`, and facts.ts sectionText treats `*` and `_` as one marker, so `#Step *y*` finds the heading as the old parser did, or `Step _y_` too. This reverses batch 7's choice that `x/__tests__/a.ts` reads as `x/tests/a.ts`. A paragraph or quote of one code span in Acceptance was a final command: commands come only from list items (objective.ts checkObjective). Coverage found Objective commands by a regex on the criterion text, so bold code (`**`npm run e2e`**`) or escaped backticks counted as final there but not in finalCommands: each criterion now carries its command (`ParsedObjective.acceptance[].command`, `CoverageObligation.source.command`), and the safety-claim exemption reads it (checks.ts graphLint); a split child's outcome keeps its parent criterion's command. graph.ts commandObligation, obligationCommands and the command-proof loop are removed: the loop could only find a command that was already a final, which it skipped, so it never reported. A writer's inline math was a code element and so a command; it is now text (`$…$`). The service golden adds unbackticked `pkg/__init__.py` and `src/__tests__/a.ts`, a `#Step *y*` anchor, a struck, a bold-code and a writer math-only Acceptance bullet and a code-only paragraph, with exact parsed values and final commands. Read-only check on clockgrove/factory-drill #51, 57, 59, 84, 88, 89, 93, 103, 106 and 122 against the parser at 6efa0381: Acceptance, final commands and Sources match on all ten, writer and non-writer; Goal differs only in rendering (#89's autolink shows as the bare URL; #122, the render probe, shows a writer's inline math as `$x^2$` instead of a code span and its mermaid source without fences). Residual, by design: a `**` or `*` in an unbackticked path comes back as `__` or `_`; backtick it. Ledger counts are unchanged: 122 ported, 24 replaced, 22 in progress, 50 planned, 2 owed, 2 dropped and 1 gap (223 lines).

- **2026-10-23, Live shakedown fixes.** Two causes fixed; no capability removed. A re-queued finished Objective's reopened issue was closed again about 6 s later, as completed, by the Project's "Auto-close issue" workflow, because the built-in Status still read Done (clockgrove/factory-drill #123 and #134). The rerun step now moves a Done built-in Status to In Progress, else Todo, else the first other option, before it reopens (crash points `rerun:status:before` and `:after`), and the check after it holds with retry and cancel, naming who closed the issue, if it was closed again anyway. Progress for the crash-loop suspect hold was saved only at the heartbeat, so a death right after a step counted as no progress: each step outcome now saves the run's id in the Objective's state (`finishedRun`), and the crash record reads it. Still owed: the drill run of the re-queue path and the two new crash points. Ledger counts are unchanged: 122 ported, 24 replaced, 22 in progress, 50 planned, 2 owed, 2 dropped and 1 gap (223 lines).

- **2026-10-23, Per-item holds on the stability base.** The per-item holds feature (core-item-holds 2080c609 and a35c5a1f, built on a pre-providers base) is replayed onto the stability branch by intent, not merged; no capability removed. A Work Item's question stops only that item and its dependents; a hold declares its scope, and Objective-wide causes raised by item steps (issue closed or edited, author approval, a full disk, GitHub 401/403/404 and refused pushes or repository settings, provider login, billing, package and setup failures, Git refusals, origin problems, host sandbox and package-network problems, the Secretlint configuration, and resets too far away) stop every step and are asked once. Several holds can be open, one per scope. Answers bind by question id; an unbound comment applies only when one hold was open since before it was written, and question comments show the short form only while one hold is open. Clocks pause only for steps a closing hold stopped, without counting overlapping holds twice; `wait` grants every step on that limit and `switch` re-runs every step on a provider limit on the new provider. Crash-loop resume, the suspect hold, revalidate, select, media and secret-scan holds keep their behavior with the scope of the step that asks. STATE_VERSION is 2 with no migration: an existing state file is unreadable and answers only `cancel` until `factory reset` (#1775) lands; reset must rebuild `holds` and `lastShownAt`, not `hold`. Two service tests were ported (an item hold with a second hold, bound, stale and unbound answers, SIGKILL and restart, and cancel; an Objective-scoped hold raised from an item step stops everything, once), and the step-order, switch and wait-clock tests check scoped holds. Still owed: the drill checks of one question comment per hold, the edit to the bound form, and `/factory <answer> --question <id>` on real GitHub. Ledger counts after this update, by the last entry's count plus this delta: 124 ported, 24 replaced, 21 in progress, 50 planned, 2 owed, 2 dropped and 1 gap (224 lines). Delta: +2 ported (1 new line, per-item holds, and stale-answer protection from in progress), -1 in progress, +1 line.

- **2026-10-23, Per-item holds review fixes.** Nine confirmed findings fixed by cause; no capability removed. Answer binding compared a comment's GitHub time with a host time, so a host clock behind GitHub's could land a short form on a newer question, and one ahead refused bound answers: each hold now saves its question comment's GitHub `created_at`/`updated_at` (`shownAt`) and whether it showed the short form, the state keeps the latest GitHub time any question was shown (`lastShownAt`), and an unbound answer applies only to the one open short-form hold shown before it and after every other; a bound answer skips the time guard (`holdsChangedAt` is gone). Scope was marked per site and missed the Codex and Copilot workers' login, billing and model holds and the reviewArtifacts hold: a `PlannerError` that holds is now Objective-wide unless it is one Work Item's own (`PlannerError.itemHold`), and `providerOutcome` maps it for every provider's planner and workers. A question deferred under a covering hold now runs again right after that answer (its retry comes due at once), and a repair over budget or a crash-loop suspect is saved on the step's retry (`asking`) and asked before the step runs. Native-stack layers above a held layer wait with it (work/steps.ts `layersBelow`, Workflow `upstream`). `factory retry ISSUE` without `--question` runs the waiting steps no hold stops while only item holds are open, and never answers a hold. Tests: the unbound-answer test seeds GitHub times ahead of the host's (shown, shown after another, bound with a skewed time); two in-process engine tests check that a Codex worker's login or quota hold on one item stops every item once, and the deferred questions, stack-layer waits and bare retry. Still owed: the drill checks listed in the entry above. Ledger counts are unchanged: 124 ported, 24 replaced, 21 in progress, 50 planned, 2 owed, 2 dropped and 1 gap (224 lines).

- **2026-10-23, Integrated core review fixes.** Twenty confirmed findings of the whole-core review (some duplicates), fixed by ten causes, one commit each; no capability removed. (A) GitHub artifacts are bound to the run: the report marker names the run (state.ts `runOf`, the one run identity, which #1775's `state.run` can replace), so a re-queued Objective posts its own report and checks for edits; an unreadable state's question is keyed by the file's digest (one incident) and its comments are read from that question's GitHub time; a `/factory` comment counts only if created at or after the cursor, so an edited old comment never acts. (B) A repair consumes the answer of the step that returned it, so a `replan` to a final, final-review, report or split hold no longer replans the new plan again; replan is a repair marked `reset`, which drops the cleared steps' repair history and isn't counted against `check`; `continue` to the planning edit question keeps the shown digest as the accepted text. (C) Continuations return `retry` with `progress`, which isn't a wait (no note, no 3 h clock); final review re-validates on `retry` only after its own refusal. (D) A dequeue during the check or before a re-run's cleanup is done is saved (`withdrawing`) and withdraws once they end. (E) A run's comment cursor starts at its card's queue time by GitHub's clock, with no margin, so an early answer is read and no earlier run's comment counts. (F) Cancel cleanup counts a 404 or 410 on the issue as nothing to close, still cleans PRs, branches and work files, and settles; the sync treats a gone issue as synced. (G) Knowledge is best effort for admission, withdrawal and retirement: failed releases and unlanded settled observations are retried in the background (`late`); engines.node is >=22.13. (H) Every step running at three deaths in a row, with progress between, holds with its own question. (I) Checks and re-run cleanups count against a host-wide `github` cap of `queue.maxActiveObjectives`. (J) Fetches in one checkout are single-flight: a caller joins the fetch that starts after the running one. Tests: a replan answer spent once with a fresh budget, two suspects holding, the check cap, a dequeue during the check, retirement under `--no-experimental-sqlite`, and 8 concurrent defaultHead calls over 3 moves of the default branch (the raw race failed 21 of 24). Still owed, the drill checks: a re-queued Objective posts a second report with its run's marker; an unreadable incident after an earlier one posts a new question and an old `/factory cancel` doesn't act; an edited old `/factory cancel` doesn't act; a `/factory` answer right after queuing is read with the host clock ahead; a `replan` to final validation's hold plans once and the report counts only new repairs; `continue` to the planning edit question doesn't ask again at publish; a media capture continuation posts no status note; a `retry` to a final-review error hold doesn't rerun final validation; a dequeue during the check and during a re-run's cleanup withdraws; cancel after the issue is deleted settles; and a burst of queued issues checks within the cap. Ledger counts are unchanged: 124 ported, 24 replaced, 21 in progress, 50 planned, 2 owed, 2 dropped and 1 gap (224 lines).
- **2026-10-23, Integrated fixes review.** Six confirmed findings of the review of the integrated fixes, fixed by four causes, one commit each; no capability removed. (1) A pending withdraw: while `withdrawing` is set the sync writes no Status and asks nothing, so the operator's dequeue stands; a re-run's cleanup that hasn't begun never runs (the earlier run's finished record stands), and one that holds or errors withdraws instead of asking; a withdrawn run keeps its last queued time, so only a later queue admits the issue again. (2) The GitHub client never follows a redirect: a transferred issue's 301 no longer closes or comments on the issue in its new repository. Cancel cleanup and the sync count a moved issue as gone; any other step holds with cancel and retry; GraphQL reads by number (the queue, the re-run's Status move) check the issue's repository and number; an Actions job log is read from its signed storage link without Factory's login. (3) An unlanded settled observation is saved as `finished/<issue>@<run>.observe.json` and retried after a restart; startup lists only those files. (4) Any sync job's gone answer (404, 410, redirect) marks the issue gone, whether or not a queue read asks for it; a finished one's unsent replies are dropped with a log line and its sync settles. Tests: the dequeue test also withdraws an Objective dequeued before its re-run's cleanup began, and the knowledge test stops the service before a failed observation lands and checks the restart records it. Still owed, the drill checks: a transferred issue's cancel closes nothing in the other repository; a dequeue during a held re-run cleanup withdraws and the card keeps the operator's option; a reply to a deleted finished Objective's issue settles. Ledger counts are unchanged (224 lines).
- **2026-10-23, Repository rename.** With redirects never followed, a renamed repository (the configuration still naming the old one) made every known issue look gone: REST answered 301 everywhere, GraphQL by-number cards named the new repository, finished runs settled without their final sync, holds were never posted and cancel closed nothing. Fixed by cause; no capability removed. The GitHub client checks the repository's identity (`GET /repos/{owner}/{repo}`, never redirected) at service start and on any 301 under the repository; a 301 there, or a GraphQL repository `nameWithOwner` that differs (the queue read, the re-run's Status move), is RepositoryMoved: transient, never a gone issue, and every later request is refused. The service then pauses every GitHub effect: no step or sync job runs, nothing settles or retires, steps keep their state, `status` shows the problem, and the run log says so once; a restart with the fixed configuration resumes. An issue moved to another repository while the repository answers under its name is still gone. Still owed, the drill check: rename the drill repository with an unfinished held Objective and a finished one awaiting its final sync, see the pause and the status problem, then fix the configuration, restart, and see the hold posted, the final sync written and nothing marked gone. Ledger counts are unchanged (224 lines).
- **2026-10-23, Wave 1 complete.** The open stack and the structural seams landed one PR at a time from main; no capability removed. This entry is the wave's only milestone entry; it replaces the per-PR entries for #1783 and #1784. PRs:
  - #1775: the operator CLI (slice 5 part A): queue-wide and per-Objective pause, drain and resume, `queue list`, stable refusal codes, `factory reset` as an engine step, and `factory log`.
  - #1774: the director skill, rewritten for the core CLI.
  - #1777: slice 4 audit follow-ups (stacks, LFS validation, review context, peer bytes, selection reasons, holds, crash points).
  - #1776: slice 6 planning options: recipes, the adaptive graph (gated by `planning.adaptiveGraph`) and the planning side of amendments.
  - #1781: Dream counts the playbook budget as stored and tells the model its costs.
  - #1782: one review runner shared by result and final review.
  - #1783: Factory refuses its own repositories, and one origin check runs before every remote Git call.
  - #1784: one checked configuration: every section through checked.ts `section`, unknown and retired keys refused by name, `planning.context` and `policy.secretlintConfig` in the configuration, the Codex worker's model keys, and configuration and state outside the checkout.
  - #1785: one keyed background job runner with a deadline (jobs.ts), and the FACTORY_COMMENT_LIMIT test knob.
  - #1786: step deadlines follow `validation.commandTimeoutSeconds` and a Copilot worker's `idleSeconds`.
  - #1787: engine outcomes: a failure is a hold with a cause, `replan` is applied from one place, one error mapper, cleanup after cancel never asks (`neverAsks`), and cancel is recorded in `ended`.
  - #1788 and #1792: Copilot Validate, and a running Claude Validate bounded by the item's validation deadline.
  - #1789: peers' notes in result review, and every item's notes in final review.
  - #1790: one frozen configuration per Objective, with `adopt`.
  - #1791: CI runs the frozen `src/` suite only when a pull request changes it.
  - #1794: kept facts through one typed helper, with one refused record.
  - #1795: knowledge under the one-writer rule: Dream's writes are service requests, and the store is bounded and never gates admission.
  - #1796: hold options as core data, which the director skill renders.
  - #1797: `currentPlan` is the one plan reader.
  - W1-01 (this entry's PR): CORE.md matches the code, and the ledger fixes of runbook 7.1b.

  #1793 (execution profiles) is still open and is not part of the wave.

  Ledger changes made with this entry: Sources are pinned at base, so editing detection is ported (default taken); prerequisiteGuidance in status is replaced (default taken); the adapter library API is replaced by the Worker seam, repairClasses is replaced, and managed execution is parked (Kirk, 2026-10-23); allowance snapshotting is ported through the frozen configuration; the Work Item issue gap becomes slice 5B under the new Work Items decision; `factory run` is slice 5, a request plus a follower; the Work Item comments, cards, closing and labels, failure comments, the progress switches, the 24 h hold reminder and the hold answers (rereview, retire-command, decide-criterion, `repair --proposal`) are slice 5B; QA execution and capacityRecommendation join the slice 6 list; the Codex worker's model keys have their own line; the Contradictions section is added; stale file references are fixed (service.ts pathOwner, git.ts defaultHead, delivery.ts factoryMade, review/result.ts deliveryRows, config.ts sandboxSection).

  Ledger counts, by each line's first status mark, recounted from the file. At the wave's start (main after #1780): 126 ported, 24 replaced, 21 in progress, 50 planned, 1 owed, 2 dropped and 1 gap (225 lines). Before this entry (main at 723ff64a): 143 ported, 24 replaced, 23 in progress, 35 planned, 2 dropped and 1 gap (228 lines). After it: 144 ported, 26 replaced, 21 in progress, 35 planned, 1 parked and 2 dropped (229 lines). Wave delta: +18 ported, +2 replaced, -15 planned, -1 owed, +1 parked, -1 gap, +4 lines. Still owed: the drill checks each PR lists.
