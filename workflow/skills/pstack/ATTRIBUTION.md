# Third-party skill attribution

The skills in this directory, and the one agent in `plugin/agents/`, are vendored from
**pstack**, a Cursor plugin by Lauren Tan, published at
<https://github.com/cursor/plugins/tree/main/pstack> and licensed under the MIT License. The
full license text is kept alongside this file as `LICENSE.pstack`.

## What was taken

Twenty `principle-*` skills (twenty-three upstream, three removed after review; see below), plus `architect`, `arena`, `automate-me`, `benchmark-checklist`,
`blast-radius`, `bro`, `correct`, `create-verification-skill`, `explain-work`, `figure-it-out`, `how`, `interrogate`,
`maintain-verification-skill`, `no-comments`, `recall`, `reflect`, `show-me-your-work`, `swarm`,
`technical-writing`, `typescript-best-practices`, `unslop`, `why`, `in-your-own-words`, `sharpen`,
`ketchup`, `ketchup-video`, and `statechart`. The `comment-sicko` agent
came across too, since `no-comments` spawns it.

## What was left behind

- `poteto-mode` and its 40-odd playbooks. The largest thing upstream ships and the one with the
  most to port: it depends on the separate `cursor-team-kit` plugin for `deslop`, `control-ui`,
  and `control-cli`, routes every subagent through a `poteto-agent` wrapper, and its Autonomy
  section grants blanket approval for external actions ("use any MCP tool", team chat and ticket
  updates proceed without asking). That last part is a policy decision rather than a porting
  problem, and it was made deliberately: this plugin does not ship a blanket grant over external
  systems. The parts of poteto-mode worth having are its principles index and its playbook
  routing, and the `principle-*` skills carry the first of those on their own.
- `setup-pstack`. Its entire job is writing a global always-applied rule that pins each role to a
  model slug. Every slug it knows about belongs to a different vendor's catalog, and the skills
  that read it have been ported to Claude Code model tiers, so there is nothing left for it to
  configure.
- `poteto-help`. Every answer it gives routes to `poteto-mode`, `setup-pstack`, the
  `~/.cursor/rules/pstack-models.mdc` rule, or the pstack guide on GitHub, none of which exist here.
  Porting it would mean rewriting it from scratch, and `ak-help` already does that job for this
  plugin.
- `make-bot-ui`. It builds pages that wake a Grok Bot over a webhook, a product this plugin has
  no counterpart for.
- `principle-never-block-on-the-human`. It instructs the agent to act first and explain
  afterwards, which conflicts with ordinary change-control expectations.
- `tdd`. The vendored Matt Pocock set has a fuller one under the same name.
- `create-formal-verification-skill` and `maintain-formal-verification-skill`. Left out when
  `ketchup` and `sharpen` came across, by the owner's choice.
- The `benny` automations. A Slack-to-pull-request pipeline that needs its own security review
  before anyone points it at a real workspace.
- `poteto-mode/scripts/`. Installs npm dependencies at run time and drives force-push and
  worktree-deletion flows. The one script that did come across is
  `show-me-your-work/scripts/log.sh`, reviewed separately below.

## Local modifications

- `how` and `why` end with one `**Related:**` line pointing at `explain-work`.
- `bro` absorbed Matt Pocock's `wait-what`: one added sentence asking for a little context and the
  repo's `GLOSSARY.md` terms.

Everything vendored got the same two ports where it needed them. Third-party model slugs
(`grok-*`, `gpt-*`) became Claude Code model tiers, and Cursor paths (`.cursor/skills/`,
`~/.cursor/rules/`, `~/.cursor/projects/<slug>/agent-transcripts/`) became their `.claude/`
equivalents. Where a skill got reviewer or candidate diversity by mixing model vendors, that
diversity now comes from an assigned lens or a distinct starting constraint, because one vendor
is all this plugin has. Beyond that:

- `interrogate` follows upstream's rewrite: adversaries run through `arena`'s Phase A steps 3 and 4
  and Phase B, and only findings proven by a run survive. Its four reference files went with the
  old reviewer flow. Adversaries spawn as `general-purpose`, and the `pstack-models.mdc` role line
  is gone.
- `architect` had its Phase B rewritten. It ran through `arena` with an uncapped runner list;
  it now spawns three runners directly, each with a different starting constraint and its own
  output path. Its Phase A called `why` to recover the rationale behind an existing shape; it now
  names concrete sources (git history, the PRs that introduced the files, ADRs) and says to flag
  what it cannot find rather than assume it away.
- `arena` and `swarm` were capped. Upstream took N from the user with no ceiling and no cost
  disclosure. `arena` defaults to three runners, `swarm` caps at twelve workers, and both have to
  state N and the reason when they go higher. `swarm` also lost `environment: "cloud"`, which has
  no Claude Code equivalent, so its workers run locally.
- `automate-me` was ported off Cursor's built-in `create-skill`, which has no Claude Code
  equivalent. Authoring routes to `writing-for-agents` in the vendored Matt Pocock set.
  `AskQuestion` became `AskUserQuestion` (`allow_multiple` became `multiSelect`, four options
  rather than six), and the worked example changed from `poteto-mode` to this plugin's `caveman`.
- `reflect` was ported the same way, including its skill-detection paths, and its substantive-edit
  branch now hands off to `writing-for-agents` instead of `create-skill`.
- `why` carries an untrusted-input guard. Upstream has no instruction to treat what it reads in
  commits, PRs, and other sources as data. The reviewer prompts in `reflect` already carried that
  guard; `why` now matches them, as one sentence since upstream cut `why` to a single paragraph.
- `figure-it-out` lost its citation of `principle-never-block-on-the-human` and its instruction to
  read poteto-mode's principles index, which point at things not vendored here.
- `teach` was renamed `explain-work`. Its job is explaining a body of work in this codebase, which
  is a different job from the `teach` in the Matt Pocock set, and two skills cannot share a name.
- `comment-sicko`'s agent name was lowercased to `comment-sicko` so `subagent_type` resolves.
- `show-me-your-work`'s transcript audit moved to `~/.claude/projects/<project-slug>/`, and its
  mandatory cross-model review became a reviewer with an assigned skeptic's lens.

- The principles were reviewed after the migration. Four stay visible so the agent reaches for
  them on its own: `test-behavior-not-implementation`, `prove-it-works`, `fix-root-causes`, and
  `laziness-protocol`. The other sixteen keep upstream's `disable-model-invocation: true`, so they
  cost nothing in every session's skill list. Skills read them as files instead: every
  "the **x** principle skill" citation of a hidden principle reads "the **x** principle
  (`~/.agents/skills/principle-x/SKILL.md`)", a path every provider can open, subagents included.
  `figure-it-out` reads the matching `principle-*` folders there. Skills in the other groups cite
  them the same way (`maestro-worker`, `diff-review`, `diagnosing-bugs`, `tdd`, `implement`,
  `codebase-design`, `retro`, `to-spec`), as do `architect`, `benchmark-checklist`, and `swarm` here.
- `principle-exhaust-the-design-space` was deleted: its body was one fragment, and `arena`,
  `architect`, and `codebase-design/DESIGN-IT-TWICE.md` carry the procedure. `architect` now says
  "design-it-twice". `principle-migrate-callers-then-delete-legacy-apis` was deleted and its one
  rule folded into `principle-outcome-oriented-execution` as a guardrail. Skip both when syncing.
- The subtract-before-you-add principle skill was deleted and its one line not already in
  `principle-laziness-protocol` (add no speculative validators or guards beyond the spec) moved
  there as a "Subtract before you add" bullet. `validate-change` and `architect` cite
  `laziness-protocol` instead. Skip it when syncing.
- Every other vendored skill had `disable-model-invocation` removed. Upstream ships most of them as
  user-invoked only. Here the agent should reach for them on its own: a skill helps when the
  situation it describes comes up, not when someone remembers to type its name, and the decision
  trail from `show-me-your-work` is most valuable on exactly the long unattended runs where nobody
  is around to ask for it. `automate-me` still tells the mode skills it writes to set the flag,
  because those are a user's personal register and should not switch on by themselves.
- `how` and `why` follow upstream down to one file each. `how` spawns one read-only explainer and
  `why` reads the record itself, so their `references/` folders are gone, and `architect`,
  `blast-radius`, `no-comments`, `recall`, and `explain-work` no longer point into them.
- `no-comments` spawned `subagent_type: "Comment Sicko"`, which never resolved after the agent was
  renamed. It now spawns `ak:comment-sicko`.
- `reflect` routed new skills and description tuning to Cursor's `create-skill`. Both now go to
  `writing-for-agents`.
- `ketchup-video` keeps `disable-model-invocation: true` because rendering a video is too costly to
  start unasked. `ketchup` lost its references to `/visualize`, a skill from another plugin, and
  just asks for a chart.
- `swarm` lost its last two references to Cursor's cloud workers.
- `correct` also keeps `disable-model-invocation: true`. It reads the
  history, then commits lint rules, CI checks, type changes, and edits to the agent instruction file,
  one commit per mistake class. That is too much change to start on the model's own judgment, so
  it runs only when the user types `/correct`.
- `benchmark-checklist` lost its references to the **Opening a PR**, **Perf issue**, and
  **Hillclimb** playbooks, which live in `poteto-mode` and were not vendored. Its closing section
  existed only to map it onto those playbooks and was dropped.
- `architect`'s runner prompt told each runner it ran on a different model. The runners here share
  one vendor, so it now tells each runner it holds a different starting constraint.

- Related skills now call each other under a clear condition, each a sentence or two:
  - `architect` judges depth with `codebase-design`'s terms and deletion test, and
    `principle-minimize-reader-load` points its layer bullets there. `blast-radius` hands a big and
    wide change to `interrogate`. `figure-it-out` points at `swarm`, `to-tickets`, `maestro`, and
    `wayfinder` when it fans out, and at `validate-change` and `full-send` for code to merge.
    `swarm` sends shipping code to `to-tickets` and competing attempts to `arena`.
  - `recall`, `reflect`, `automate-me`, and `show-me-your-work` share one history-scope rule from
    `recall`. `recall` routes a single chat to `takeover`, this chat to `ketchup`, and counts a
    `handoff` document as a state capsule; its description now says "across chats". `automate-me`
    leaves prose style to `writing-for-agents`. `show-me-your-work` briefs its reviewer as
    `second-opinion` does.
  - `explain-work` drops the sentence rules `unslop` already owns, and its heading no longer says
    "Teach". `technical-writing` drops the short-word rule and the passive-voice clause that
    `unslop` already covers.
  - `correct` judges tests by `principle-test-behavior-not-implementation`.

### `statechart`

Taken byte-identical at `bf0c7cd`, minus `agents/openai.yaml`, which upstream does not ship for this
skill. About 3.9 MB across 408 files, most of it recorded TLC output under `scripts/test/corpus/`.
Nothing in it names a harness's tools, so the wording needed no port. One local decision:
`disable-model-invocation: true` stays, like `correct` and `ketchup-video`. The first run installs
Java and TLC through mise and downloads from the network, which is too much to start on the
model's own judgment. `vite.config.ts` lints and formats nothing under `workflow/skills/pstack/**`,
since upstream's test files break this repo's lint rules and the files stay as upstream wrote them.

Its scripts were reviewed before they came across:

- `scripts/statechart` (the `sh` launcher), `statechart.ts`, `worker.ts`, and `run.ts` are the only
  files that run anything. The launcher picks `node`, `bun`, or `deno` and runs `statechart.ts`
  with it. It spawns a worker in its own process group with a fresh temp folder as `TMPDIR`, and a
  janitor shell that kills that group by the PID it captured and deletes the stage and temp
  folders it created. The output folder must be new or empty, the result lands there by one
  `rename`, and nothing is written outside it and the temp folders.
- `run.ts` finds TLC. With `TLA2TOOLS` set it uses that jar and `JAVA`. Otherwise it runs
  `mise install java@temurin-25` and `mise install` of `tla2tools` 1.7.4, which mise downloads from
  the `tlaplus/tlaplus` GitHub release `v1.7.4` and checks against a pinned SHA-256. mise keeps
  both in its own data directory, so they are the only thing written outside the output folder
  and `os.tmpdir()`, and they are a tool cache. It then runs `java` on that jar with
  `-Djava.io.tmpdir` pointed at a per-run folder. It runs no shell with user text interpolated:
  every child gets an argv array.
- The user's `--view` module is loaded with `import()`. That runs user code by design, and the
  user wrote it, as with any build config.
- `ir.ts`, `pipeline.ts`, `passes/`, `frontends/`, and `backends/` are pure: they parse TLC text
  and build Mermaid. They import no `node:` module at all, so they cannot touch the
  filesystem, the network, or a process.
- `scripts/test/` is not run by the skill. It needs `TLA2TOOLS` set, and `render.test.ts`
  installs `pele`, `mermaid`, and `jsdom` with `npm install` into `~/.cache/statechart`.
  `corpus/` holds recorded TLC and SANY output as fixtures. Its only URLs are two in comments of
  recorded TLC output.
- Nothing runs as root, uses `sudo`, edits shell profiles, or reads credentials.

## Upstream sync

Last synced against `cursor/plugins` commit `bf0c7cd` (2026-11-14). Earlier syncs were taken at
`ae5650f` (2026-10-31), `ccb5507` (2026-10-06), `12d587d` (2026-09-23), and the first import at `63d938c` (2026-08-13). Each sync is a three-way merge per file with the previous sync commit as
the base, so local ports survive and upstream prose changes come across. Upstream changes that only
touch model slugs, the `pstack-models.mdc` rule, or Cursor's Task tool are dropped in the merge,
since the ports above already replace them.

## The one vendored script

`show-me-your-work/scripts/log.sh` was reviewed line by line and exercised against crafted input.
It runs no commands, reaches no network, and passes every value through `printf '%s'` rather than
interpolating it, so shell metacharacters, format specifiers, and embedded newlines are all stored
as literal text. Tabs and newlines collapse to spaces, which is what stops a crafted cell from
forging an extra row in an append-only log.

One hole was found and fixed. Upstream prefixes any cell starting with `=`, `+`, `-`, or `@` with
an apostrophe so a reviewer opening the log in a spreadsheet cannot trigger formula execution.
That check ran against the raw cell, so a value with a leading space (`" =1+1"`) slipped through
while a spreadsheet still parsed it as a formula. The check now ignores leading blanks.

Any further script coming across from upstream gets the same treatment before it lands.
- `create-verification-skill` and `maintain-verification-skill` had their em dashes removed, the
  one rule from `unslop` that upstream does not apply to itself everywhere. No wording beyond the
  punctuation changed.

### Move into T3 Code's `workflow/`

These skills now run under every provider T3 Code drives, not only Claude Code, so the Claude Code
ports above were replaced with provider-neutral wording:

- `recall`, `reflect`, `automate-me`, and `show-me-your-work` read history through T3 Code's thread
  tools (`t3_thread_list`, `t3_thread_search`, `t3_thread_read`) instead of
  `~/.claude/projects/<slug>/*.jsonl`. They cite thread ids instead of transcript UUIDs, and the
  project-scope guard now forbids searching across all projects instead of globbing across
  `~/.claude/projects/*/`. The three `reflect` reviewer prompts take a thread id in place of a
  transcript path, and count a skill as used when its `SKILL.md` was read or it was invoked by name.
- `reflect` edits skill sources in `workflow/skills/<group>/<skill>/`, puts new skills in
  `workflow/skills/ak/`, records vendored edits in the group's `ATTRIBUTION.md`, and runs
  `vp run workflow:link` afterwards. It no longer copies skills into `.claude/skills/` or
  `~/.claude/skills/`.
- `automate-me` looks for and writes mode skills in `workflow/skills/ak/<handle>-mode/` and runs
  `vp run workflow:link` once the skill lands in the main checkout. Its `AskUserQuestion` calls
  became "ask the user, as a structured question if your harness offers one", and its `caveman`
  pointer names `workflow/skills/ak/`.
- `architect`, `arena`, `blast-radius`, `how`, `interrogate`, `ketchup`,
  `maintain-verification-skill`, `reflect`, `show-me-your-work`, `swarm`, `why`,
  `principle-build-the-lever`, and `principle-guard-the-context-window` dropped the Agent tool's
  `subagent_type` (`Explore`, `general-purpose`) and `run_in_background` for "delegate to a
  subagent (in T3 Code: `delegate_task`)", briefed read-only where `Explore` was used. Worktree
  candidates and workers point at `delegate_task`'s `isolation: "worktree"`.
- Claude model tiers became roles: `opus` is "your strongest model", `sonnet` "mid-tier", `haiku`
  "a fast, cheap model". Where `fable` was the runner or reviewer that argues differently, it is
  now "a different strong model, ideally another provider's", since T3 Code can delegate across
  providers. That restores the vendor diversity upstream got from mixing models.
- `no-comments` delegates to a subagent that follows the `comment-sicko` skill instead of spawning
  the `ak:comment-sicko` agent, and names `how`, `why`, and `architect` as skills instead of slash
  commands.
- `recall`'s shared-record sweep, which upstream now spells out inline instead of borrowing `why`'s
  investigators, delegates its investigators as general subagents (in T3 Code: `delegate_task`)
  instead of Cursor's agent-mode Task spawns.
- `create-verification-skill` and `maintain-verification-skill` write and find `verify-<app>/` in
  whichever project skill folder the repo already uses (`.agents/skills/` or `.claude/skills/`)
  instead of always `.claude/skills/`.
