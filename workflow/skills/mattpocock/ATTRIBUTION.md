# Third-party skill attribution

The skills in this directory are vendored from **Matt Pocock's skills**, published at
<https://github.com/mattpocock/skills> and licensed under the MIT License. The full license text is
kept alongside this file as `LICENSE.mattpocock`.

They used to install as a separate `mattpocock-skills` plugin from the fork `christinoleo/skills`.
They now live here so every source sits in one plugin with its own folder. That fork is no longer
read by the marketplace.

## What was taken

Every skill but one in upstream's plugin manifest. From `skills/engineering/`: `code-review` (now `diff-review`),
`codebase-design`, `diagnosing-bugs`, `domain-modeling`, `grill-with-docs`, `implement`,
`implement-spec`, `improve-codebase-architecture`, `prototype`, `research`, `retro`,
`setup-matt-pocock-skills`, `tdd`, `to-spec`, `to-tickets`, `triage`, `wayfinder`, and `wizard`. From
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
- Each skill's `agents/openai.yaml`. It configures another vendor's agent and nothing here reads it.

## Local modifications

- The `engineering/` and `productivity/` split is flattened, because this folder is one `skills`
  entry in the manifest.
- `triage` is `triage-issues`, including its frontmatter name and every reference that means the
  skill. `/triage` is already the `ak` command that walks through review findings, and two entries
  in one plugin cannot share a name. Prose about triage as an activity and the example tickets in
  `AGENT-BRIEF.md` are unchanged.
- Sixteen skills had `disable-model-invocation` removed, for the same reason as the pstack set: the
  agent should reach for a skill when the situation comes up. The fork carried this change already.
- `code-review` is `diff-review`, including its frontmatter name and every reference in
  `implement`, `implement-spec`, and `tdd`. Claude Code ships a built-in `code-review` skill, and
  providers see one flat list of names.
- Claude Code-only wording is provider-neutral, so every provider T3 Code runs can follow these
  skills:
  - "Call the Skill tool with X" (and "call the Skill tool twice, for X and Y") reads "use the X
    skill" in `grill-me`, `grill-with-docs`, `handoff`, `implement`, `implement-spec`,
    `improve-codebase-architecture`, `retro`, `tdd`, `triage-issues`, and `wayfinder`.
  - Where a skill hands work to a subagent, it names T3 Code's `delegate_task` in parentheses:
    `diff-review`, `implement-spec`, `improve-codebase-architecture`, `grilling`, `research`,
    `wayfinder`, and `codebase-design/DESIGN-IT-TWICE.md`. Workers that commit on their own branch
    (`implement-spec` implementers, `wayfinder` research subagents) get `isolation: "worktree"`.
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
- `diff-review`, `diagnosing-bugs`, `tdd`, `implement`, `codebase-design`, `retro`, and `to-spec`
  each gained one sentence citing the pstack principles that apply, by name when the principle is
  a visible skill and by `~/.agents/skills/principle-<name>/SKILL.md` when it is hidden.
- `implement`, `implement-spec`, and `tdd` point at this fork's `validate-change` skill where they
  pointed at `diff-review`. `validate-change` runs checks, simplify, a test-quality pass,
  `no-comments`, and the harness's own reviewer, and still runs `diff-review` for its Spec axis
  when the change implements an issue or spec.
- Fixes from the pipeline model (`ak/ak-help/model/`): `to-spec` labels its spec `epic` instead of
  `ready-for-agent`, so the maestro never hands a whole spec to one worker; `to-tickets` nudges a
  `maestro <owner/repo>` thread after publishing; `implement-spec` skips `in-progress` tickets;
  `wayfinder` unassigns week-old abandoned claims and asks the user what to do with fog left after
  the last ticket.
- `grilling`, `to-spec`, `to-tickets`, `triage-issues`, and `diff-review` end with one `**Related:**`
  line naming the skills that come before or after them in this fork's flows.
- Seven skills that went unused for months were made user-only again after a usage review:
  `setup-matt-pocock-skills`, `wizard`, `to-questionnaire`, `teach`, `retro`, `writing-for-agents`, and
  `improve-codebase-architecture`. They still run when the user names them.
- `wayfinder` ends a finished map by filing implementation tickets with `to-tickets` and handing them
  to `maestro`, so charting runs straight into dispatch. One added step under "Work through the map".

## Upstream sync

Last synced against `mattpocock/skills` commit `4ae2317` (2026-10-31). To sync again, run a three-way
merge per file with the previous sync commit as the base, so local changes survive and upstream
prose comes across, mapping `triage` to `triage-issues` and `code-review` to `diff-review`.

## The two vendored shell templates

`diagnosing-bugs/scripts/hitl-loop.template.sh` and `wizard/template.sh` were reviewed line by line.
Both are templates that an agent copies and edits for one task, and nothing in this plugin runs them
on its own. The first only prompts in the terminal and prints what it captured. The second opens
URLs in a browser, writes `.env` values at mode 0600, and sets GitHub secrets and variables through
`gh` only when a generated wizard calls those helpers. No change was needed.
