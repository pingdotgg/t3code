# @t3tools/extension-version-control

The first-party Version Control panel (`t3.version-control`) as an
installable SDK extension — reads, mutations and repository ops on the
`t3.vcs/*` contracts (repository at 1.1.0),
plus a pull-request browser on `t3.prs/read@^1.0.0` with comment and
review-thread writes on `t3.prs/write@^1.0.0`.

The PR browser consumes the `t3.prs/read` grant:

- a PR list (open/closed/merged/all, `all`/`reviewing`/`authored`
  involvement, debounced search, `limit`-paged "Load more") keyed on
  `prs.list` rows — state/decision/checks/labels/branches per row;
- a detail pane (`prs.summary` + `prs.detail`): title/body, state,
  author, branches, checks with verdict, review decision;
- review threads and comments via `prs.activity`, with
  `prs.threadComments` paging when a thread arrives truncated;
- linked orchestration threads via `prs.linkedThreads` (display only —
  no thread-navigation capability exists on `ClientHost`);
- a verified PR diff via `prs.streamDiff` — the manifest/chunk/complete
  frames are folded and verified (ordered chunk counts, declared byte
  length, per-source hash, terminal `payloadSha256`) before any patch
  text reaches the renderer; continuation frames use `nextCursor`;
- freshness via `prs.subscribeRefreshes` and an explicit Refresh that
  calls `prs.invalidate` then re-reads the list;
- `prs.stack`/`prs.reviewerCandidates`/`prs.labelCandidates`/`prs.listStats`
  remain unwired — nothing in the panel needs them yet;
- PR writes via `t3.prs/write`: comments, review-thread replies, and
  thread resolve/unresolve, each gated on the write capability probe's
  per-operation flags.

The capability gate (`prs.getCapabilities`) renders every named
unavailable state — no configured host, `cli-missing`,
`cli-unauthenticated`, `provider-unsupported` — and each section falls
back to a named note when its `operations` flag is false, so an
unsupported provider never masquerades as an empty list. PR mutations
beyond comment/reply/resolve (reviews, merge, state changes) are
deferred, and the panel says so rather than rendering dead controls.

Repository reads consume the `t3.vcs/read` grant:

- repository capability gate via `t3.vcs/repository.getCapabilities`
  (detected driver, per-operation support — no fabricated clean state),
- branch/upstream/ahead-behind status via `t3.vcs/status`
  (`get`/`refresh`/`subscribe`; the stream drives freshness, no polling),
- staging lanes via `t3.vcs/changes.list` — the per-path
  staged/unstaged/untracked/conflicted state the private status payload
  drops,
- refs via `t3.vcs/refs.list` (current/default/worktree/remote rows).

Mutations need the `t3.vcs/mutate` grant at install time:

- per-row and per-lane Stage/Unstage (`t3.vcs/changes` `stage`/`unstage`),
- commit with a required message (`t3.vcs/changes` `commit`; staged set
  when a staged lane exists, all changes otherwise — conflicted lanes
  block the button outright),
- branch create-and-switch (`t3.vcs/refs` `create` with `switchRef`) and
  per-ref Switch (`t3.vcs/refs` `switch`; refs checked out in a worktree
  are disabled by name),
- sync controls (`t3.vcs/repository` `pull`/`push`/`fetch`): Pull gates on
  an upstream with a fast-forwardable behind count; Push mirrors native's
  disabled reasons (detached HEAD, dirty tree, behind/diverged, no remote)
  and lands the driver's `push -u` publish path for an unpushed branch on a
  configured remote; Fetch runs per remote or all at once,
- repository init on the no-repository state (`t3.vcs/repository` `init`;
  the capability gate is re-read so the panel transitions on real
  detection),
- worktrees (`t3.vcs/repository` `createWorktree`/`removeWorktree`): a
  per-ref Worktree action, a new-branch worktree form with the host
  assigning the path, and per-worktree Remove with a force retry that only
  appears after a real refusal; the worktree list is derived from
  `refs.list` `worktreePath`, matching native's branch-selector data,
- publish repository (`t3.vcs/actions` `publishRepository`; also
  chain-checked against `t3.prs/write` server-side): the offer renders
  while the workspace has no `origin` remote — native's menu condition —
  and disables by name on a detached HEAD, since the op creates the host
  repository and wires the remote _before_ pushing. The form mirrors the
  native dialog's inputs (provider, `owner/name` path, visibility,
  remote name, protocol); `remote_added` reports as the partial it is
  rather than claiming a publish.

Remotes render from `t3.vcs/repository` `listRemotes` (a read-granted
call) — name, URL, and primary marker, with per-remote Fetch.

Every control renders only when `operations["<method>"]` is supported by
the detected driver; mutation rejections (grant denials,
`VcsUnsupportedOperationError`, git failures) surface by name in the
panel status line. Stage/unstage are index-only changes the status stream
does not fingerprint — the panel re-reads `changes.list`/`refs.list`
after each settled mutation instead of editing lanes locally.

The manifest requires `t3.vcs/repository` at `^1.0.0` — the frozen floor —
so the panel still loads against a 1.0.0 host; the 1.1.0 additions
(push/fetch/listRemotes) gate on `operations` keys a 1.0.0 host never
reports and simply hide.

The panel adopts the `t3.ui/*` client contracts the native surface uses:

- `t3.ui/theme@^1.0.0` — under the `t3.ui/theme.read` grant: `getTokens`
  resolves the host's effective theme (stored preference, session overlay,
  or external preview — the provider folds them) and `subscribeState`
  re-reads on every transition. Resolved values land on the view root as
  `--t3-version-control-*` variables ahead of each style's legacy `var()`
  chain, so an installation without the grant — or a host that never
  connects a theme provider — renders the pre-contract appearance
  unchanged. A failed read or a lost subscription clears the published
  overrides rather than retaining them: painting last-known values after
  the contract stops serving them would lie about what the host paints.
  `--success`, `--info`, and the `font-*` vars stay on the host
  constants: they sit outside the contract's color-role set.
- `t3.ui/notifications@^1.0.0` — under the `t3.ui/notify` grant: every
  repository mutation opens a thread-anchored `loading` toast that updates
  to `success` or `error` on settle, matching native `GitActionsControl`
  receipts. The receipt channel is recorded on the mutation itself: the
  inline row renders unless that mutation actually started a toast, so a
  capability probe resolving mid-mutation never hides a receipt that has
  none. A success receipt dismisses after the native 10 s window, counting
  only time the receipt can actually be read — the view shown and the
  document visible and focused — pausing across hidden spans like native's
  `dismissAfterVisibleMs`; an unseen receipt never expires in the
  background. Errors stay pinned until dismissed.
  Every delivery loss — a denied `notify`, a rejected or unapplied
  `update`, a user-dismissed loading toast — returns that mutation's
  receipt to the inline row; only non-dismissal failures latch the
  adapter dead. Non-mutation statuses (refs/changes/remotes read errors,
  selection, branch-create notes) stay inline because native keeps them
  inline too.

The surface registers no `t3.ui/keybindings` commands — the native panel
has no dedicated shortcuts (its inputs keep plain Enter/Escape handlers,
mirrored here) — and makes no `t3.ui/panels` calls, since nothing in the
native surface opens or closes panels programmatically.
`SurfaceDescriptor.capabilities` stays empty: the field gates mounting on
required host services, and `t3.ui/*` contracts are opportunistic
client-provider APIs, not mount requirements.

Still deferred: PR mutations beyond comment/reply/resolve,
clone/discovery flows (no remote-creation/discovery contract —
`sourceControl.*` provisioning is host-side), stash (no native binding
exists to mirror), branch rename/delete (internal driver methods only),
working-tree diff rendering (the Diff panel's `t3.vcs/diff` surface), AI
commit text (no contract), discard/revert and checkpoint diffs
(orchestration contracts).

```sh
pnpm --filter @t3tools/extension-version-control test
pnpm --filter @t3tools/extension-version-control build
pnpm --filter @t3tools/extension-version-control check
pnpm --filter @t3tools/extension-version-control audit
```
