# Third-party skill attribution

The skills in this directory are vendored from **Matt Pocock's skills**, published at
<https://github.com/mattpocock/skills> and licensed under the MIT License. The full license text is
kept alongside this file as `LICENSE.mattpocock`.

They used to install as a separate `mattpocock-skills` plugin from the fork `christinoleo/skills`.
They now live here so every source sits in one plugin with its own folder. That fork is no longer
read by the marketplace.

## What was taken

Every skill but one in upstream's plugin manifest. From `skills/engineering/`: `code-review` (now `diff-review`),
`codebase-design`, `diagnosing-bugs`, `domain-modeling`, `grill-with-docs`, `improve-codebase-architecture`, `prototype`, `research`, `retro`,
`setup-matt-pocock-skills`, `tdd`, `to-spec`, `to-tickets`, `triage`, and `wayfinder`. From
`skills/productivity/`: `grill-me`, `grilling`, `handoff`, `teach`, `to-questionnaire`,
and `writing-for-agents`.

## What was left behind

- `skills/in-progress/`, including `chief-of-staff` and `software-factory`, and `skills/deprecated/`,
  `skills/misc/`. Upstream's manifest does not ship them.
- `wait-what`, merged into pstack's `bro` after review: both restate the last message plainly, and
  `bro` gained its "give a little context, use the glossary terms". Skip it when syncing.
- `ask-matt`, removed after the migration review: `ak-help` routes over every group, while
  `ask-matt` only knew this one. Skip it when syncing.
- `pr`, removed when `tstack` came in: its `file-pr` covers filing a pull request, and nothing
  else in `workflow/skills/` referenced `pr`. Skip it when syncing.
- `implement` and `implement-spec`, removed after they came across: `implement` repeats the build
  steps of `full-send` (which `full-stop` follows), and `implement-spec` runs the maestro's task graph
  inside one session. The maestro took over the two things only `implement-spec` had: an
  integration branch per epic, and notes shared through the parent issue. Skip both when syncing.
- `wizard`, removed after it came across: human-only steps get a numbered checklist in the ticket
  instead of a generated script. Skip it when syncing.
- Each skill's `agents/openai.yaml`. It configures another vendor's agent and nothing here reads it.

## Local modifications

- The `engineering/` and `productivity/` split is flattened, because this folder is one `skills`
  entry in the manifest.
- `triage` is `triage-issues`, including its frontmatter name and every reference that means the
  skill. It was renamed while the `ak` set had its own `triage` for review findings; that one is
  gone, and the name stays so references do not churn. Prose about triage as an activity and the example tickets in
  `AGENT-BRIEF.md` are unchanged.
- Sixteen skills had `disable-model-invocation` removed, for the same reason as the pstack set: the
  agent should reach for a skill when the situation comes up. The fork carried this change already.
- `code-review` is `diff-review`, including its frontmatter name and every reference in
  `tdd`. Claude Code ships a built-in `code-review` skill, and
  providers see one flat list of names.
- Claude Code-only wording is provider-neutral, so every provider T3 Code runs can follow these
  skills:
  - "Call the Skill tool with X" (and "call the Skill tool twice, for X and Y") reads "use the X
    skill" in `grill-me`, `grill-with-docs`, `handoff`,
    `improve-codebase-architecture`, `retro`, `tdd`, `triage-issues`, and `wayfinder`.
  - Where a skill hands work to a subagent, it names T3 Code's `delegate_task` in parentheses:
    `diff-review`, `improve-codebase-architecture`, `grilling`, `research`,
    `wayfinder`, and `codebase-design/DESIGN-IT-TWICE.md`. Workers that commit on their own branch
    (`wayfinder` research subagents) get `isolation: "worktree"`.
    Read-only workers (the two `diff-review` reviewers, design-it-twice designers) share the
    checkout, because a fresh worktree would miss uncommitted work and gains nothing.
  - `retro` finds past sessions with `t3_thread_search` and `t3_thread_read` instead of searching
    session logs on disk.
  - `CLAUDE.md` mentions in `setup-matt-pocock-skills`, `retro`, and `writing-for-agents` are
    unchanged. They mean the repo's instruction file, which is real for Claude projects.
- Questions go through the harness's structured question tool where it has one, so T3 Code shows a
  question card and notifies the user instead of leaving the question in plain text. `grilling`
  asks each round that way and keeps upstream's text format as the fallback; `to-tickets`,
  `wayfinder`, and `improve-codebase-architecture` ask their approval and pick questions the same way.
- `diff-review`, `diagnosing-bugs`, `tdd`, `codebase-design`, `retro`, and `to-spec`
  each gained one sentence citing the pstack principles that apply, by name when the principle is
  a visible skill and by `~/.agents/skills/principle-<name>/SKILL.md` when it is hidden.
- `tdd` points at this fork's `review-change` skill where it
  pointed at `diff-review`. `review-change` runs checks, simplify, a test-quality pass,
  `no-comments`, and the harness's own reviewer, and still runs `diff-review` for its Spec axis
  when the change implements an issue or spec.
- Fixes from the pipeline model (`ak/ak-help/model/`): `to-spec` labels its spec `epic` instead of
  `ready-for-agent`, so the maestro never hands a whole spec to one worker; `to-tickets` nudges a
  `maestro <owner/repo>` thread after publishing;
  `wayfinder` unassigns week-old abandoned claims and asks the user what to do with fog left after
  the last ticket.
- `grilling`, `to-spec`, `to-tickets`, `triage-issues`, and `diff-review` end with one `**Related:**`
  line naming the skills that come before or after them in this fork's flows.
- Tie-ins so related skills run where they belong: `wayfinder` scans existing code with
  `improve-codebase-architecture` while mapping the frontier; `to-tickets` makes a refactor judged with
  `codebase-design` the first ticket when it simplifies the slices, and gives human-only tickets a
  numbered checklist; `grilling` sends external-fact questions to `research` and look-and-feel questions
  to `prototype`.
- `wayfinder` ends a finished map by filing implementation tickets with `to-tickets` and handing them
  to `maestro`, so charting runs straight into dispatch. One added step under "Work through the map".
- Related skills now call each other under a clear condition, each a sentence or two:
  - `grilling` also uses `domain-modeling` when the plan coins a domain term or the repo keeps a
    glossary, so `wayfinder`, `triage-issues`, and `improve-codebase-architecture` name only
    `grilling` where they named both. It also parks a branch on `to-questionnaire` when the answer
    belongs to someone else. `grill-me` and `grill-with-docs` stay as aliases.
  - `to-spec`, `to-tickets`, `wayfinder`, `triage-issues`, and `diff-review` say
    to use `setup-matt-pocock-skills` where they said to tell the user to run it.
    `setup-matt-pocock-skills` says `triage-issues` where it meant `triage`, and records a glossary
    the repo already keeps elsewhere instead of creating a root `GLOSSARY.md`.
  - `to-spec` and `to-tickets` run `replan` on the draft. `wayfinder` publishes a spec destination with
    `to-spec` first and hands human-only credential or dashboard tasks a numbered checklist.
  - `diff-review`'s Standards
    prompt adds `typescript-best-practices` for `.ts` and `.tsx` diffs.
  - `tdd` gained "Should this test exist?", asked before each red test, so the loop stops writing
    tests no regression needs; unattended runs record their seams for the reviewer instead of
    approving them silently. A slice an existing case can absorb gets a row, not a new test.
  - `teach` has two modes. Course mode is upstream's `teach`. Explain mode is pstack's `teach` (once
    this fork's `explain-work`), merged in; pstack upstream changes to it land in that section. Both
    share its rules on grounding, plain words and building diagrams up, and lessons explain their
    knowledge the way Explain mode does.
  - `to-tickets` gained "Sketch the shared shape": work that changes types, signatures or module
    boundaries across modules runs pstack's `architect` (Phases A to C, checkpoint on) first, and the
    agreed sketch becomes a scaffold ticket that blocks every slice. Later steps are renumbered.
  - `wayfinder` and `to-tickets` read the Plan group of this fork's `principles` index.
  - `research` does the work itself when it already runs as the delegated agent, and saves where its
    caller says. `wayfinder`'s research subagents record their own resolution (comment, close,
    Decisions-so-far line) after pushing their `research/<name>` branch.
  - `diagnosing-bugs` vets measurements with `benchmark-checklist`, runs `why` on a suspect that
    looks deliberate or a regression, and offers `improve-codebase-architecture` when no correct
    seam exists. `improve-codebase-architecture` shows its report with `html_preview` and
    `html_render` in T3 Code.
  - `handoff` names a `show-me-your-work` log, `retro` offers `/correct` when a mistake class recurs,
    `teach` fills `RESOURCES.md` with `research`, and `writing-for-agents` ends by running `unslop`.

## Upstream sync

Skills here sit in role folders (`factory/`, `on-demand/`), as `workflow/README.md` describes; upstream keeps them flat, so each upstream `<skill>/` maps to the one `<role>/<skill>/` folder of that name.

Last synced against `mattpocock/skills` commit `4ae2317` (2026-10-31). To sync again, run a three-way
merge per file with the previous sync commit as the base, so local changes survive and upstream
prose comes across, mapping `triage` to `triage-issues` and `code-review` to `diff-review`.

## The vendored shell template

`diagnosing-bugs/scripts/hitl-loop.template.sh` was reviewed line by line. It is a template that an
agent copies and edits for one task, and nothing in this plugin runs it on its own. It only prompts
in the terminal and prints what it captured. No change was needed.
