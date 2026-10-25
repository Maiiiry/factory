# Command authority without prose (draft, for discussion)

A change to Command authority ([Plan checks](../PLANNING.md#plan-checks)). It's not built: until this page is agreed, the rule in PLANNING.md stands.

## Problem

A validation command runs on the operator's machine, so Factory only runs one someone with authority wrote down. Today an Objective grants that authority from any backticked span in its prose whose text looks like a command (`COMMAND_SHAPE` in `src/planning/facts.ts`: a lowercase word, then arguments without shell operators).

"Looks like a command" is a guess about what the writer meant:

- A function or file named in a sentence (`trimEnd`, `chain base`) has the shape, so it becomes an authorized command no one meant to run.
- A real command in a sentence ("the old `npm run legacy` is gone") is authorized too, though the sentence says not to use it.
- Each misreading so far was patched with a narrower guess (the PATH rule, since dropped; "names a program"), and each patch misreads some other Objective.

The writer shouldn't have to avoid backticks in prose to keep Factory from running something, and Factory shouldn't decide from wording which code is a command.

## Proposal

A command has authority only from a place whose whole meaning is "run this":

| Source                                                                | Status                        |
| --------------------------------------------------------------------- | ----------------------------- |
| Root package scripts at the base (`package.json`)                     | unchanged                     |
| An operator's `allow` answer                                          | unchanged                     |
| The installation's `finalValidation.requiredCommands`                 | unchanged                     |
| An Objective Acceptance bullet that is exactly one code span          | now the only Objective source |
| A backticked span in Objective prose (Goal, notes, any other section) | **removed**                   |
| A line of a repository file that is exactly a command                 | kept (see below)              |

Code in prose is then only text: the planner and reviewers read it, and no check derives anything from it. An Acceptance command bullet already is a final command (`finalCommands`), so it means the same thing in both places: the Objective's result must pass it, and items may run it.

The shell-operator filter stays as a refusal, not a guess: a command with `$`, `;`, `|`, `&`, `<`, `>` or braces is never authorized from any document.

### Own-line commands in repository files

A repository file line that is exactly a command (a bare line, or a bullet of one code span) stays authority. It's deterministic: the whole line is the command, nothing is inferred from a sentence. It's written and reviewed by people with write access. And for a repository without package scripts (Rust, Go, Python), it's how a README or CONTRIBUTING.md declares `cargo test` without an operator answer on every Objective.

Dropping it is the stricter option: such a repository would then need an `allow` answer, or the command in each Objective's Acceptance. We recommend keeping it.

## What an Objective writer sees

- A command the Objective's items must run goes in Acceptance as its own bullet:

  ```markdown
  ## Acceptance

  - `trimEdges("  a  ")` returns `"a"`.
  - `npm run lint:docs`
  ```

  The first bullet is a criterion for review, and the second is a command.

- A command named only in prose is text. If the plan needs it and no other source authorizes it, the plan check refuses it as now and the planner can ask the operator to `allow` it.
- The queue-time hold "Objective names `…` but declares no final command" goes. It reads backticked prose to guess that the writer meant a final command, which is the same guess. An Objective with no Acceptance command has no final command, and its result is judged by review and its items' validation.
- An Acceptance command bullet is its own authority: being in Acceptance is the operator's declaration, so `cargo test` there is authorized as written, as today; a package command keeps today's supported forms, checked at queue time ([Check at queue time](../reference/queue.md#check-at-queue-time)).

## Changes when agreed

- `src/planning/facts.ts`: `authorizedCommands` takes the Objective's commands from its Acceptance command bullets, not `inlineSpans`. `authorizedCommand` drops the `operatorAuthored` inline branch. `objectiveCommandProblems` drops the "names … but declares no final command" problem. Repository files keep `exactLine`.
- `docs/PLANNING.md` (Command authority), `docs/reference/security.md` (Issue bodies), `docs/templates/objective.md`: say where a command's authority comes from.
- Tests: a prose span is never authorized; an Acceptance command bullet is; an own-line command in a pinned repository doc is.
