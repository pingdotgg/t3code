---
name: audit
description: Audit one or more specific pull requests the user names — PR numbers, `#N`, or GitHub URLs (e.g. "/audit 2101", "/audit #2101 #2093", "/audit https://github.com/alchemy-run/alchemy/pull/2101"). Works through them one at a time: check out, merge main, resolve conflicts, audit tests and JSDoc, run the suites, rewrite the PR description as DX snippets, and stop with a merge-or-close recommendation. Use when the user hands you the PRs rather than a search criteria (for that, use pr-queue); also for "also audit #N", "skip #N" or "next" while an audit is running.
metadata:
  internal: true
---

# Pull request audit

The user names the PRs — one or many. Audit them one at a time: fix each, push
it, and ask the user to merge or close it. The user merges; you never do.

## 1. Take the list

Accept any mix of `2101`, `#2101` and PR URLs, separated by spaces, commas or
newlines. Dedupe. A URL for another repository (e.g. `alchemy-run/distilled`)
is audited with `-R <owner>/<repo>` on every `gh` call, in that repository's
checkout (`submodules/distilled`).

```sh
gh pr view <n> --json number,title,author,state,isDraft,mergeable,additions,deletions,changedFiles,updatedAt,isCrossRepository,maintainerCanModify,headRefName,baseRefName,url
```

Say up front which PRs are already merged, closed or don't exist, and drop
them. Drafts, PRs waiting on the author's answer to an earlier question, and
forks we can't push to (`maintainerCanModify: false`) stay — the user asked
for them — but say so; on an unpushable fork, fixes go to the author as a
standalone comment or a follow-up PR.

**One PR:** no table. Go straight to §2 and end with the
[§7 report](procedure.md#7-report-and-ask).

**Several PRs:** print a table —
`# | PR (link) | Author | Size | Behind main | What it does | Audit notes`,
with ✅/❌ against the standards in
[procedure.md §3](procedure.md#3-review-the-code) — and annotate:

- **stacks** — a PR whose `baseRefName` is another listed PR's branch
  (`base #N ← child #M`); the base goes first
- **overlaps** — PRs fixing the same issue or touching the same files; plan a
  merge order and which ones to close

Keep the user's order otherwise; if they gave none, easiest first (clean
merge, small diff, tests already in the right shape, single concern). Track
status (`todo` / `in progress` / `ready → merge?` / `close?` / `merged` /
`closed` / `parked`) and re-print the table whenever it changes.

## 2–7. Audit each PR

Work through the list with the shared per-PR procedure in
[procedure.md](procedure.md): check out and merge main, review the code,
update JSDoc, run the tests, push and rewrite the description, then report
and ask. Read it in full before the first PR.

## 8. Keep the list moving

Follow [procedure.md §8](procedure.md#8-keep-the-list-moving), plus:

- On "also audit #N": fetch it as in §1, add it to the table (respecting
  stacks and overlaps), and finish the current PR first.
- When every listed PR is `merged`, `closed` or `parked`, print the final
  table and stop. Don't search for more PRs — that's pr-queue.
