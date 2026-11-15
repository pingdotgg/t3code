---
name: pr-queue
description: Run a pull-request (or issue) queue for an area of alchemy — search GitHub for open PRs/issues matching a criteria (e.g. "cloudflare", "docker", "aws/rds", an author, a label), shortlist the top 10 ordered by ease of fixing, then launch each one as its own detached top-level T3 thread (`t3_thread_launch`, `workspaceStrategy: "worktree"`): each thread checks out, merges main, resolves conflicts, audits tests and JSDoc, runs the suites, rewrites the PR description as DX snippets, and asks the user directly to merge or close it, while this thread keeps the status table. Use for "start working on a pull request queue for cloudflare", "PR queue for docker", "triage open PRs for X", "work through the open fix(aws) PRs", "next PR" while a queue is running.
metadata:
  internal: true
---

# Pull request queue

This thread is the coordinator. Build the catalog once, then launch one
**detached top-level thread** per PR or issue, each in its own worktree. Each
thread owns its item end to end: it fixes it, pushes it, watches CI, and asks
the user to merge or close it. The user merges; no thread ever does.

Item threads MUST be top-level threads from `t3_thread_launch`, never
subagent threads from `delegate_task`. A subagent thread can't watch CI,
reports only back to the coordinator, and routes every user answer through
it. A top-level thread sits in the sidebar on its own, the user talks to it
directly, and it carries its PR to merge-ready without the coordinator.

## 1. Build the catalog and shortlist

Turn the user's criteria into a search. An area like `docker` or `cloudflare`
matches conventional-commit scopes (`feat(docker)`, `fix(cloudflare/r2)!`) and
PRs that touch that provider's paths.

```sh
gh pr list --state open --limit 300 --json number,title,author,isDraft,mergeable,additions,deletions,changedFiles,updatedAt,isCrossRepository,maintainerCanModify,headRefName,baseRefName,url \
  > /tmp/pr-queue.json
# scope match: ^\w+!?\((<area>)(/[^)]*)?\)!?:   (case-insensitive)
# path match for anything the title missed:
gh pr view <n> --json files --jq '.files[].path' | grep -i '<Area>/'
```

For issues use `gh issue list --state open --search "<area> in:title,body"`.
Free-form criteria map onto `--author`, `--label`, `--search`. Leave out the
user's own PRs unless asked, and honor any exclusions they give (e.g. "ignore
the container PRs").

Print the **catalog**, grouped by theme when it's large:
`PR (link) | Author | Size | Behind main | What it does | Audit notes`, with
✅/❌ against the standards in
[audit/procedure.md §3](../audit/procedure.md#3-review-the-code). Annotate:

- **stacks** — a PR whose `baseRefName` is another PR's branch
  (`base #N ← child #M`)
- **overlaps** — PRs fixing the same issue or touching the same files; plan a
  merge order and which ones to close
- drafts, and PRs waiting on the author's answer to an earlier question

Then the **shortlist: top 10, easiest first** —
`# | PR (link) | Author | Size | Tests now | Likely work`. Rank by clean merge,
small diff, tests already in the right shape, single concern. Exclude drafts,
PRs waiting on the author, and forks we can't push to
(`maintainerCanModify: false`). PRs needing a test rewrite go on a separate
**rework list**. If fewer than 10 match, say it's the whole list.

Keep the shortlist as a status table with a thread link per row
(`[title](t3-thread://v1/<threadId>)`) and a status (`todo` / `ready → merge?` /
`close?` / `merged` / `closed` / `parked`), and re-print it whenever it changes.

## 2. Launch one thread per item

Start each item with `t3_thread_launch`:

```ts
t3_thread_launch({
  title: "#<N> <short title>",
  workspaceStrategy: { type: "worktree", baseRef: "origin/main" }, // its own checkout
  message: "<contents of /tmp/pr-queue/brief-<N>.md>",
})
```

Keep each returned thread `link` in the status table. Launch the whole
shortlist; there is no cap on running threads. Send the launches in batches
of about 3: each one cuts a worktree, and cutting many at once in the same
repo contends for git's locks. The brief checks out the PR branch (or a new
`fix/…` branch for an issue) itself.

A PR's brief starts with `/audit <N>`; an issue's says to fix it per
[audit/procedure.md](../audit/procedure.md) and open a PR ending in
`Fixes #<N>`. Every brief adds: `pnpm install` first, no subagents of its
own, one live suite at a time with `--concurrency 8`, `link_pull_request` on
every PR, for features post the proposed API and wait before building, after
each push `watch_pull_request` the PR and end the turn, and leave the PR with
every CI check passing on its final head
([audit/procedure.md §6](../audit/procedure.md#6-push-and-update-the-pr))
before asking the user to merge per
[audit/procedure.md §7](../audit/procedure.md#7-report-and-ask).

If a thread fails in preparation, launch a fresh one; don't relaunch into the
same branch by hand.

## 3. Coordinate

Don't do an item's work here, and don't poll threads (`sleep`,
`t3_thread_wait`). Item threads report to the user, not to this thread. When
the user asks for status, `t3_thread_read` each thread, update the table, and
re-print it. Answers and merge decisions go to the item's own thread, not
through here. On "enqueue more", re-run the §1 search and launch the next
batch.
