# Third-party skill attribution

The skills in this directory are vendored from **tstack**, by Theo Browne, published at
<https://github.com/t3dotgg/tstack> and licensed under the MIT License. The full license text is
kept alongside this file as `LICENSE.tstack`.

## What was taken

All nine skills in upstream's `skills/`: `babysit-pr` (with `scripts/pr-wait`), `council`,
`file-pr`, `full-send`, `full-stop`, `leaving-pr-comments`, `modernize`, `sol-loop`, and
`takeover`.

## What was left behind

- Each skill's `agents/openai.yaml`. It configures another vendor's agent and nothing here reads it.
- Upstream's `README.md`.

## Local modifications

Every file is byte-identical to upstream except these:

- `council` used to report instead of substituting when a member's model was unavailable. It now
  uses the closest strong model from a provider the council does not already have, taken from
  `orchestrator_capabilities`, and says which one stood in. It still reports when three providers
  cannot be reached.
- `sol-loop` used to report a blocker when no route ran GPT Sol, and told Claude Code users to use
  a custom subagent set up for Sol. It now falls back to the closest strong model from a different
  provider than the agent's own, says which one it used, and writes that model's name in place of
  `Sol` in the PR line. It reports the blocker only when no such model is reachable. The
  Claude Code-only sentence is gone.
- `babysit-pr` told Claude Code users to run `pr-wait` with the Monitor tool. It now says to use
  the harness's monitor tool, if it has one that wakes on each output line, with a one-hour
  timeout.
- `file-pr` replaces `mattpocock/pr`, which was removed. The two are not interchangeable:
  `pr` prescribed a body template (summary visual, evidence, merge danger), while `file-pr`
  prescribes a title and plain-language description.

- `full-send` runs this fork's `validate-change` skill (in `ak/`) right after its Prove step, one
  added line, so every full send gets the checks, simplify, test, no-comments and native-review pass
  before `sol-loop`.

- Related skills now call each other under a clear condition, each a sentence or two. `full-send`
  routes a bug to `diagnosing-bugs` and new behavior to `tdd`, says the skills that pause for
  approval (`tdd`, `verify`, `frontend-design`) are not on its ask list, names `verify` and
  `benchmark-checklist` in Proof, and keeps decisions with `show-me-your-work` on a multi-phase run.
  `council` briefs a question or design as `second-opinion` does. `file-pr` and `leaving-pr-comments`
  run their text through `technical-writing` and `unslop`. `takeover` and `modernize` run
  `validate-change` after logic changes of their own.

Otherwise `full-send` is unchanged. It names `AskUserQuestion` (Claude Code) and `request_user_input`
(Codex) and falls back to "the question tool your harness has", so it already works under every
provider. `watch_pull_request` and `unwatch_pull_request` in `babysit-pr`, `full-send`, and
`full-stop` are T3 Code's own tools.

## Upstream sync

Last synced against `t3dotgg/tstack` commit `11e37a7` (2026-11-11). To sync again, run a
three-way merge per file with the previous sync commit as the base, so local changes survive and
upstream prose comes across.

## The one vendored script

`babysit-pr/scripts/pr-wait` was read in full before it was vendored. It is a Python polling
loop over the `gh` CLI. It runs only `gh repo view`, `gh pr view`, `gh pr checks`, `gh pr diff`,
and `gh api` reads (GraphQL for the PR, REST for branch protection, rulesets, and branch
comparisons), retries transient failures with backoff, and prints one line per event. It posts,
comments, merges, and pushes nothing. Its only writes are a per-PR lock file and a state file in
`~/.local/state/pr-wait/`. It spawns no processes besides `gh` and uses no shell. No change was
needed.
