# @t3tools/extension-version-control

The first-party Version Control panel (`t3.version-control`) as an
installable SDK extension — reads, mutations and repository ops on the
`t3.vcs/*` contracts (repository at 1.2.0, changes at 1.1.0),
plus a pull-request browser on `t3.prs/read@^1.0.0` with comment and
review-thread writes on `t3.prs/write@^1.0.0`.

The PR browser consumes the `t3.prs/read` grant:

- a PR list (open/closed/merged/all, `all`/`reviewing`/`authored`
  involvement, debounced search, `limit`-paged "Load more") keyed on
  `prs.list` rows — state/decision/checks/labels/branches per row;
- a detail pane (`prs.summary` + `prs.detail`): title/body, state,
  author, branches, checks with verdict, review decision. The checks glyph
  on a row and in the header opens native's checks popover (a row reads its
  checks only when opened, and keyboard focus moves into it and on past it
  as native's does); the list rollup wins only when its row is the newer
  snapshot, ordered as native orders them (merged, update time, the host's
  `observedAt` read time from `t3.prs/read@1.1.0`, then arrival), and then
  marks the detail's checks as out of date;
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
- the PR's stack via `prs.stack`, shown as a Stack section with its base
  and layers when the host supports it, plus native's Merge stack: this
  layer and every unmerged layer below it, pinned to the heads the reader
  saw (`runAction` `merge` with `stackNumber`/`expectedStackHeads`), offered
  only when the host does stack actions, host and viewer may merge, the
  repository allows a method, and the stack read is fresh — confirmed in
  native's centred modal dialog (the host floating layer's `Dialog`; older
  hosts get it against its opener) before it runs, with the merge method
  chosen beside it. Merge methods resolve as native's do: this PR's pick,
  the project's setting (`preferredMergeMethod` on `prs.detail@1.1.0`) or
  the project's legacy client-local override, then the last pick, which
  lives in the host's `pullRequestPreferences` — native's own stored
  choice — or, on hosts without them, for the panel's lifetime. Native's
  Rebase stack rides the same write
  (`update-branch`, `rebase`) through the top layer with every unmerged head
  pinned, offered when the viewer may rebase the stack. While a stack lookup
  is pending, failed, or finds a stack, the single-PR merge and auto-merge
  are held back as native does;
- labels and review requests can be added or removed from their metadata rows.
  The pickers read repository candidates only when opened and search the returned
  list locally. Provider support, account permissions and read/write grants gate
  editing; refused writes restore the previous selection;
- `prs.listStats` remains unwired — nothing in the panel needs it yet;
- the head branch chip copies its branch, as native's does, including on
  remote clients served over plain HTTP;
- open-on-host links for the repository, the PR number, each branch (a ↗
  beside its chip) and each commit, handed to the reader's own client through
  `t3.ui/external` (`t3.ui/external.open` grant); a refusal or a denied
  grant is named under the header rather than swallowed;
- Check out (`t3.vcs/actions` `preparePullRequestThread`, offered only when
  the workspace's driver reports it): native's menu — "In a separate
  worktree" or "In this repository" — with native's loading toast settling
  to where the checkout landed, a stale checkout, or the host's own refusal.
  Stack merges and rebases report only their result, as one toast; without
  a toast provider (or when delivery is lost) the same words show inline.
  Where the host offers `handoffPullRequest` (`t3.vcs/actions@1.1.0`, the
  `t3.vcs/handoff` grant), both options run as native's do: the host opens
  a thread, checks out (`mode` names where), runs the setup script, and
  points the thread at the checkout, so the worktree option reads "Its own
  folder and thread". The host shows native's toasts for it, which stay on
  screen on the new thread; the pack reports only a call the host refused.
  Without it, the pack checks out alone and the worktree option promises
  only the folder;
- Resolve conflicts (the same handoff, on an open pull request that
  conflicts with its base): the pack names the task and the host writes
  native's prompt into a composer — beside a thread, that thread's; otherwise
  a new thread on a fresh worktree checkout. Nothing is sent;
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
- Discard on the Changes lane and Delete on the Untracked lane
  (`t3.vcs/changes` `discard`): the button only arms an inline
  confirmation naming the paths; the destructive call fires from its
  confirm button, never on a timer. Changes revert to the index (staged
  work survives), untracked paths are deleted. The host refuses the whole
  request — touching nothing — if any path is conflicted or has no
  working-tree change, and the refusal surfaces as a failed receipt,
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
  while the workspace has no `origin` remote and a provider is ready — native's menu condition —
  and disables by name on a detached HEAD, since the op creates the host
  repository and wires the remote _before_ pushing. The form mirrors the
  native dialog's inputs (provider, `owner/name` path, visibility,
  remote name, protocol); `remote_added` reports as the partial it is
  rather than claiming a publish.

Clone repository opens a Git URL or ready-provider flow. Provider discovery
and lookup use `t3.source-control/discovery@1.0.0` with `t3.source-control/read`;
Discovery runs once per mounted session; Rescan providers refreshes readiness
without polling or clearing the last result. Unready providers show setup hints.
The repository picker caches each source until Rescan providers or remount and
shows at most 20 recent repositories and marks partial lists; another
repository can be entered directly. Azure DevOps uses the CLI's configured project.

`t3.projects/clone@1.0.0` requires the separate `t3.projects/create` grant,
not `t3.vcs/mutate`. The environment assigns the project identity and clones
into the environment’s Add Project base directory, or the host home directory
when none is configured, using the same native destination rule. Confirm the name and protocol,
then start the clone; native project creation, progress, cancellation and
retry remain owned by the host. Progress is installation-scoped and bounded
to 16 entries / 48 KiB. Failed and cancelled clones offer Retry clone.
Directory names must be single segments and cannot end in `.git`.
Provider repository identifiers use the provider’s owner/name path; GitLab
subgroups and Azure’s configured-project repository names are supported.
Progress subscriptions and pending discovery/list reads stop when the panel is
hidden or closed; completed discovery and listings remain cached until rescan
or remount.

Remotes render from `t3.vcs/repository` `listRemotes` (a read-granted
call) — name, URL, and primary marker, with per-remote Fetch.

Every control renders only when `operations["<method>"]` is supported by
the detected driver; mutation rejections (grant denials,
`VcsUnsupportedOperationError`, git failures) surface by name in the
panel status line. Stage/unstage are index-only changes the status stream
does not fingerprint — the panel re-reads `changes.list`/`refs.list`
after each settled mutation instead of editing lanes locally.

The manifest requires `t3.vcs/repository` and `t3.vcs/changes` at
`^1.0.0` — the frozen floor — so the panel still loads against a 1.0.0
host; later additions (push/fetch/listRemotes, discard) gate on
`operations` keys an older host never reports and simply hide.

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
stash (no native binding exists to mirror), branch rename/delete
(internal driver methods only), working-tree diff rendering (the Diff
panel's `t3.vcs/diff` surface), AI commit text (no contract), and
checkpoints — restore is `t3.orchestration/control` `checkpoint.revert`,
adopted by the Diff and Agents panels; capture/delete are turn-lifecycle
internals with no user command natively either.

```sh
pnpm --filter @t3tools/extension-version-control test
pnpm --filter @t3tools/extension-version-control build
pnpm --filter @t3tools/extension-version-control check
pnpm --filter @t3tools/extension-version-control audit
```
