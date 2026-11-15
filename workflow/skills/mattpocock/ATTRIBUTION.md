# Third-party skill attribution

The skills in this directory are vendored from **Matt Pocock's skills**, published at
<https://github.com/mattpocock/skills> and licensed under the MIT License. The full license text is
kept alongside this file as `LICENSE.mattpocock`.

They used to install as a separate `mattpocock-skills` plugin from the fork `christinoleo/skills`.
They now live here so every source sits in one plugin with its own folder. That fork is no longer
read by the marketplace.

## What was taken

Every skill in upstream's plugin manifest. From `skills/engineering/`: `ask-matt`, `code-review`,
`codebase-design`, `diagnosing-bugs`, `domain-modeling`, `grill-with-docs`, `implement`,
`implement-spec`, `improve-codebase-architecture`, `pr`, `prototype`, `research`, `retro`,
`setup-matt-pocock-skills`, `tdd`, `to-spec`, `to-tickets`, `triage`, `wayfinder`, and `wizard`. From
`skills/productivity/`: `grill-me`, `grilling`, `handoff`, `teach`, `to-questionnaire`, `wait-what`,
and `writing-for-agents`.

## What was left behind

- `skills/in-progress/`, including `chief-of-staff` and `software-factory`, and `skills/deprecated/`,
  `skills/misc/`. Upstream's manifest does not ship them.
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

## Upstream sync

Last synced against `mattpocock/skills` commit `4ae2317` (2026-10-31). To sync again, run a three-way
merge per file with the previous sync commit as the base, so local changes survive and upstream
prose comes across, mapping `triage` to `triage-issues`.

## The two vendored shell templates

`diagnosing-bugs/scripts/hitl-loop.template.sh` and `wizard/template.sh` were reviewed line by line.
Both are templates that an agent copies and edits for one task, and nothing in this plugin runs them
on its own. The first only prompts in the terminal and prints what it captured. The second opens
URLs in a browser, writes `.env` values at mode 0600, and sets GitHub secrets and variables through
`gh` only when a generated wizard calls those helpers. No change was needed.
