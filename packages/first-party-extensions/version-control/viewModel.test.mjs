import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import {
  COMMIT_FOLLOW_UP,
  FOLLOW_UP_ACTION_ID,
  PUBLISH_PROVIDERS,
  describePublishResult,
  planPublish,
  postFollowUpReceipt,
  publishOffer,
  publishProviderOption,
  stackedChooserReason,
  stackedFollowUp,
  CHANGE_LANES,
  CONNECTING_STATUS,
  EMPTY_LANES,
  IDLE_MUTATION,
  IDLE_STACKED_PROGRESS,
  applyStackedEvent,
  applyStatusEvent,
  branchLabel,
  describeEntry,
  describeMutation,
  describeRef,
  describeStackedProgress,
  describeStackedResult,
  describeStatus,
  entryMutation,
  laneCount,
  laneMutation,
  laneTitle,
  lanesFromChanges,
  numstatFor,
  planCommit,
  planRefCreate,
  planWorktreeCreate,
  pullState,
  pushState,
  refRows,
  refSwitchState,
  refSwitchTarget,
  remoteRows,
  repositoryState,
  retainSelection,
  settleMutation,
  stackedActionCommits,
  stackedActionInput,
  stackedActionLabel,
  stackedActionNeedsConfirm,
  stackedActionOffers,
  stackedActionSuggestion,
  startMutation,
  syncLabel,
  canWorktreeRef,
  dismissReceiptAfterSeen,
  isNotificationDismissal,
  mutationToastSettle,
  mutationToastStart,
  nextThemeVars,
  releaseMutationReceipt,
  themeVarOverrides,
  workingTreeLabel,
  worktreeRows,
} from "./viewModel.ts";

const change = (path, flags) => ({
  path,
  staged: false,
  unstaged: false,
  untracked: false,
  conflicted: false,
  ...flags,
});

const local = (overrides = {}) => ({
  isRepo: true,
  hasPrimaryRemote: false,
  isDefaultRef: false,
  refName: "main",
  hasWorkingTreeChanges: true,
  workingTree: { files: [], insertions: 0, deletions: 0, truncated: false },
  ...overrides,
});

const remote = (overrides = {}) => ({
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
  ...overrides,
});

const caps = (overrides = {}) => ({
  detected: true,
  kind: "git",
  detail: null,
  driver: {
    kind: "git",
    supportsWorktrees: true,
    supportsBookmarks: false,
    supportsAtomicSnapshot: false,
    supportsPushDefaultRemote: false,
    ignoreClassifier: "native",
  },
  operations: {
    "status.get": true,
    "status.refresh": true,
    "status.subscribe": true,
    "refs.list": true,
    "refs.create": true,
    "refs.switch": true,
    "changes.list": true,
    "changes.stage": true,
    "changes.unstage": true,
    "changes.commit": true,
    "diff.getPreview": true,
    "diff.getFileContents": true,
    "repository.pull": true,
    "repository.init": true,
    "repository.createWorktree": true,
    "repository.removeWorktree": true,
    "repository.push": true,
    "repository.fetch": true,
    "repository.listRemotes": true,
  },
  ...overrides,
});

NodeTest.describe("vcs view model — staging lanes", () => {
  NodeTest.it("assigns staged/unstaged/untracked/conflicted lanes from porcelain flags", () => {
    const lanes = lanesFromChanges([
      change("a.txt", { unstaged: true }), // modified, unstaged ( M)
      change("b.txt", { staged: true }), // staged new file (A )
      change("c.txt", { untracked: true }), // ??
      change("d.txt", { conflicted: true }), // UU
      change("e.txt", { staged: true, unstaged: true }), // MM — partially staged
    ]);
    NodeAssert.deepEqual(
      lanes.staged.map((e) => e.path),
      ["b.txt", "e.txt"],
    );
    NodeAssert.deepEqual(
      lanes.changes.map((e) => e.path),
      ["a.txt", "e.txt"],
    );
    NodeAssert.deepEqual(
      lanes.untracked.map((e) => e.path),
      ["c.txt"],
    );
    NodeAssert.deepEqual(
      lanes.conflicted.map((e) => e.path),
      ["d.txt"],
    );
    NodeAssert.equal(laneCount(lanes), 6); // e.txt counts in both lanes
  });

  NodeTest.it("keeps a flagless anomaly visible instead of dropping it", () => {
    const lanes = lanesFromChanges([change("odd.txt")]);
    NodeAssert.deepEqual(
      lanes.changes.map((e) => e.path),
      ["odd.txt"],
    );
  });

  NodeTest.it("labels lanes and describes entry state", () => {
    NodeAssert.equal(laneTitle("conflicted"), "Merge conflicts");
    NodeAssert.equal(laneTitle("staged"), "Staged changes");
    NodeAssert.equal(laneTitle("changes"), "Changes");
    NodeAssert.equal(laneTitle("untracked"), "Untracked files");
    NodeAssert.equal(
      describeEntry(change("a", { staged: true, unstaged: true })),
      "staged, also modified",
    );
    NodeAssert.equal(describeEntry(change("b", { staged: true })), "staged");
    NodeAssert.equal(describeEntry(change("c", { unstaged: true })), "modified");
    NodeAssert.equal(describeEntry(change("d", { untracked: true })), "untracked");
    NodeAssert.equal(describeEntry(change("e", { conflicted: true })), "conflicted");
    NodeAssert.equal(laneCount(EMPTY_LANES), 0);
    NodeAssert.deepEqual(CHANGE_LANES, ["conflicted", "staged", "changes", "untracked"]);
  });
});

NodeTest.describe("vcs view model — selection", () => {
  const lanes = lanesFromChanges([
    change("a.txt", { unstaged: true }),
    change("b.txt", { staged: true }),
    change("c.txt", { staged: true, unstaged: true }),
  ]);

  NodeTest.it("keeps a selection whose path stays in its lane", () => {
    const sel = { path: "a.txt", lane: "changes" };
    NodeAssert.equal(retainSelection(sel, lanes), sel);
    NodeAssert.equal(retainSelection(null, lanes), null);
  });

  NodeTest.it("re-points a selection when the path moves lanes", () => {
    // c.txt was selected under changes, then fully staged elsewhere.
    const moved = lanesFromChanges([change("c.txt", { staged: true })]);
    NodeAssert.deepEqual(retainSelection({ path: "c.txt", lane: "changes" }, moved), {
      path: "c.txt",
      lane: "staged",
    });
  });

  NodeTest.it("drops a selection whose path is clean", () => {
    NodeAssert.equal(retainSelection({ path: "gone.txt", lane: "changes" }, lanes), null);
    NodeAssert.equal(retainSelection({ path: "a.txt", lane: "changes" }, EMPTY_LANES), null);
  });
});

NodeTest.describe("vcs view model — status stream", () => {
  NodeTest.it("seeds from snapshot and bumps the local revision", () => {
    const model = applyStatusEvent(CONNECTING_STATUS, {
      kind: "snapshot",
      local: local(),
      remote: remote(),
    });
    NodeAssert.equal(model.stream, "live");
    NodeAssert.equal(model.local?.refName, "main");
    NodeAssert.equal(model.localRevision, 1);
  });

  NodeTest.it("localUpdated keeps the remote half and bumps the revision", () => {
    const seeded = applyStatusEvent(CONNECTING_STATUS, {
      kind: "snapshot",
      local: local({ refName: "main" }),
      remote: remote({ aheadCount: 2 }),
    });
    const next = applyStatusEvent(seeded, {
      kind: "localUpdated",
      local: local({ refName: "topic" }),
    });
    NodeAssert.equal(next.local?.refName, "topic");
    NodeAssert.equal(next.remote?.aheadCount, 2);
    NodeAssert.equal(next.localRevision, 2);
  });

  NodeTest.it("remoteUpdated keeps the local half without bumping the revision", () => {
    const seeded = applyStatusEvent(CONNECTING_STATUS, {
      kind: "snapshot",
      local: local(),
      remote: null,
    });
    const next = applyStatusEvent(seeded, {
      kind: "remoteUpdated",
      remote: remote({ behindCount: 3 }),
    });
    NodeAssert.equal(next.remote?.behindCount, 3);
    NodeAssert.equal(next.local?.refName, "main");
    NodeAssert.equal(next.localRevision, 1);
  });

  NodeTest.it("closed ends the stream with a named reason", () => {
    const seeded = applyStatusEvent(CONNECTING_STATUS, {
      kind: "snapshot",
      local: local(),
      remote: null,
    });
    const ended = applyStatusEvent(seeded, { kind: "closed", reason: "overflow" });
    NodeAssert.equal(ended.stream, "ended");
    NodeAssert.match(ended.detail ?? "", /overflowed/);
    const errored = applyStatusEvent(seeded, { kind: "closed", reason: "status-error" });
    NodeAssert.match(errored.detail ?? "", /status error/);
  });
});

NodeTest.describe("vcs view model — status text", () => {
  NodeTest.it("renders branch, sync and working-tree state", () => {
    const model = applyStatusEvent(CONNECTING_STATUS, {
      kind: "snapshot",
      local: local({
        workingTree: {
          files: [{ path: "a.txt", insertions: 5, deletions: 2 }],
          insertions: 5,
          deletions: 2,
          truncated: false,
        },
      }),
      remote: remote({ aheadCount: 2, behindCount: 1 }),
    });
    NodeAssert.equal(describeStatus(model), "main — ↑2 ↓1 vs upstream — 1 file changed (+5 −2)");
  });

  NodeTest.it("renders ahead/behind, no-upstream, and ahead-of-default honestly", () => {
    NodeAssert.equal(syncLabel(remote({ aheadCount: 0, behindCount: 0 })), "in sync with upstream");
    NodeAssert.equal(syncLabel(remote({ aheadCount: 4, behindCount: 0 })), "↑4 vs upstream");
    NodeAssert.equal(syncLabel(remote({ aheadCount: 0, behindCount: 7 })), "↓7 vs upstream");
    NodeAssert.equal(syncLabel(remote({ hasUpstream: false })), "no upstream");
    NodeAssert.equal(
      syncLabel(remote({ hasUpstream: false, aheadOfDefaultCount: 3 })),
      "↑3 vs default branch",
    );
    NodeAssert.equal(syncLabel(null), "upstream pending");
  });

  NodeTest.it("renders detached HEAD, clean tree, truncation, and PR badge", () => {
    NodeAssert.equal(branchLabel(local({ refName: null })), "detached HEAD");
    NodeAssert.equal(workingTreeLabel(local({ hasWorkingTreeChanges: false })), "clean");
    NodeAssert.equal(
      workingTreeLabel(
        local({
          workingTree: {
            files: [{ path: "a", insertions: 0, deletions: 1 }],
            insertions: 0,
            deletions: 1,
            truncated: true,
          },
        }),
      ),
      "1 file changed (+0 −1), list truncated",
    );
    const model = applyStatusEvent(CONNECTING_STATUS, {
      kind: "snapshot",
      local: local({ hasWorkingTreeChanges: false }),
      remote: remote({
        pr: {
          number: 42,
          title: "Ship it",
          url: "https://example.test/pr/42",
          baseRef: "main",
          headRef: "topic",
          state: "open",
        },
      }),
    });
    NodeAssert.match(describeStatus(model), /PR #42 open/);
  });

  NodeTest.it("reports connecting, ended, and non-repo states", () => {
    NodeAssert.equal(describeStatus(CONNECTING_STATUS), "Reading repository status…");
    NodeAssert.equal(
      describeStatus(
        applyStatusEvent(CONNECTING_STATUS, { kind: "closed", reason: "status-error" }),
      ),
      "Status updates ended — The status stream reported a status error.",
    );
    const notRepo = applyStatusEvent(CONNECTING_STATUS, {
      kind: "snapshot",
      local: local({ isRepo: false, refName: null }),
      remote: null,
    });
    NodeAssert.equal(describeStatus(notRepo), "This workspace is not a repository");
  });

  NodeTest.it("joins per-path numstat from the status payload", () => {
    const withStats = local({
      workingTree: {
        files: [
          { path: "a.txt", insertions: 5, deletions: 2 },
          { path: "b.txt", insertions: 0, deletions: 9 },
        ],
        insertions: 5,
        deletions: 11,
        truncated: false,
      },
    });
    NodeAssert.deepEqual(numstatFor(withStats, "b.txt"), { insertions: 0, deletions: 9 });
    NodeAssert.equal(numstatFor(withStats, "missing.txt"), null);
    NodeAssert.equal(numstatFor(null, "a.txt"), null);
  });
});

NodeTest.describe("vcs view model — mutation controls", () => {
  NodeTest.it("maps lanes to bulk stage/unstage actions; conflicted offers none", () => {
    NodeAssert.deepEqual(laneMutation("changes"), { op: "stage", label: "Stage all" });
    NodeAssert.deepEqual(laneMutation("untracked"), { op: "stage", label: "Stage all" });
    NodeAssert.deepEqual(laneMutation("staged"), { op: "unstage", label: "Unstage all" });
    NodeAssert.equal(laneMutation("conflicted"), null);
  });

  NodeTest.it("maps rows to per-file stage/unstage; conflicted rows offer none", () => {
    NodeAssert.equal(entryMutation("changes")?.label, "Stage");
    NodeAssert.equal(entryMutation("untracked")?.label, "Stage");
    NodeAssert.equal(entryMutation("staged")?.label, "Unstage");
    NodeAssert.equal(entryMutation("conflicted"), null);
    NodeAssert.equal(entryMutation("staged")?.op, "unstage");
  });
});

NodeTest.describe("vcs view model — commit plan", () => {
  const cleanLanes = EMPTY_LANES;
  const stagedOnly = lanesFromChanges([change("a.txt", { staged: true })]);
  const unstagedOnly = lanesFromChanges([
    change("a.txt", { unstaged: true }),
    change("b.txt", { untracked: true }),
  ]);
  const conflicted = lanesFromChanges([
    change("a.txt", { staged: true }),
    change("conflict.txt", { conflicted: true }),
  ]);

  NodeTest.it("commits the staged set when a staged lane exists", () => {
    const plan = planCommit(stagedOnly, "ship it");
    NodeAssert.equal(plan.disabled, null);
    NodeAssert.equal(plan.label, "Commit staged (1)");
    NodeAssert.deepEqual(plan.paths, ["a.txt"]);
  });

  NodeTest.it("commits all changes when nothing is staged (native default)", () => {
    const plan = planCommit(unstagedOnly, "ship it");
    NodeAssert.equal(plan.disabled, null);
    NodeAssert.equal(plan.label, "Commit all changes");
    NodeAssert.equal(plan.paths, undefined);
  });

  NodeTest.it("blocks without a message — the contract requires one", () => {
    NodeAssert.equal(planCommit(stagedOnly, "").disabled, "Enter a commit message");
    NodeAssert.equal(planCommit(unstagedOnly, "   ").disabled, "Enter a commit message");
    NodeAssert.equal(planCommit(stagedOnly, "").label, "Commit staged (1)");
  });

  NodeTest.it("hard-blocks while the conflicted lane is non-empty", () => {
    const plan = planCommit(conflicted, "resolve and commit");
    NodeAssert.equal(plan.disabled, "Resolve merge conflicts before committing");
    NodeAssert.equal(plan.paths, undefined);
  });

  NodeTest.it("blocks on a clean tree", () => {
    NodeAssert.equal(planCommit(cleanLanes, "msg").disabled, "No changes to commit");
  });

  NodeTest.it("blocks a staged set over the 100-path input bound — a commit cannot chunk", () => {
    const bigStaged = lanesFromChanges(
      Array.from({ length: 101 }, (_, index) => change(`f${index}.txt`, { staged: true })),
    );
    const plan = planCommit(bigStaged, "msg");
    NodeAssert.match(plan.disabled ?? "", /Over 100 staged paths/);
    NodeAssert.equal(plan.paths, undefined);
    NodeAssert.equal(plan.label, "Commit staged (101)");
    // 100 staged paths is still committable.
    const atBound = lanesFromChanges(
      Array.from({ length: 100 }, (_, index) => change(`f${index}.txt`, { staged: true })),
    );
    NodeAssert.equal(planCommit(atBound, "msg").disabled, null);
    NodeAssert.equal(planCommit(atBound, "msg").paths?.length, 100);
  });
});

NodeTest.describe("vcs view model — mutation phase machine", () => {
  NodeTest.it("idle -> running -> succeeded/failed; running refuses a second op", () => {
    const running = startMutation(IDLE_MUTATION, "stage", "Staging 2 paths", "inline");
    NodeAssert.deepEqual(running, {
      kind: "running",
      op: "stage",
      label: "Staging 2 paths",
      receipt: "inline",
    });
    NodeAssert.equal(startMutation(running, "commit", "Committing", "inline"), null);
    const ok = settleMutation(running, "stage", { ok: true, detail: "Staged 2 paths" });
    NodeAssert.deepEqual(ok, {
      kind: "succeeded",
      op: "stage",
      detail: "Staged 2 paths",
      receipt: "inline",
    });
    const failed = settleMutation(running, "stage", {
      ok: false,
      detail: "Staging failed: denied",
    });
    NodeAssert.deepEqual(failed, {
      kind: "failed",
      op: "stage",
      detail: "Staging failed: denied",
      receipt: "inline",
    });
    NodeAssert.notEqual(startMutation(ok, "unstage", "Unstaging", "inline"), null);
    NodeAssert.notEqual(startMutation(failed, "unstage", "Unstaging", "inline"), null);
  });

  NodeTest.it("keeps the receipt channel across settle, on either channel", () => {
    // A mutation that began before the capability probe resolved records
    // "inline" and keeps the row after settling — a probe landing
    // mid-mutation must not hide a receipt that never had a toast.
    const inline = startMutation(IDLE_MUTATION, "push", "Pushing", "inline");
    NodeAssert.equal(
      settleMutation(inline, "push", { ok: true, detail: "Pushed main" }).receipt,
      "inline",
    );
    const toasted = startMutation(IDLE_MUTATION, "push", "Pushing", "notification");
    NodeAssert.equal(
      settleMutation(toasted, "push", { ok: true, detail: "Pushed main" }).receipt,
      "notification",
    );
    NodeAssert.equal(
      settleMutation(toasted, "push", { ok: false, detail: "rejected" }).receipt,
      "notification",
    );
  });

  NodeTest.it("releaseMutationReceipt returns a lost toast receipt to the row", () => {
    const running = startMutation(IDLE_MUTATION, "push", "Pushing", "notification");
    NodeAssert.equal(releaseMutationReceipt("push")(running).receipt, "inline");
    // The mapper is op-scoped: a different or already-inline phase is
    // untouched, and idle stays idle.
    NodeAssert.equal(releaseMutationReceipt("pull")(running), running);
    NodeAssert.equal(releaseMutationReceipt("push")(IDLE_MUTATION), IDLE_MUTATION);
    const inline = startMutation(IDLE_MUTATION, "push", "Pushing", "inline");
    NodeAssert.equal(releaseMutationReceipt("push")(inline), inline);
  });

  NodeTest.it("describes every phase for the status line", () => {
    NodeAssert.equal(describeMutation(IDLE_MUTATION), null);
    NodeAssert.equal(
      describeMutation({
        kind: "running",
        op: "commit",
        label: "Committing",
        receipt: "inline",
      }),
      "Committing…",
    );
    NodeAssert.equal(
      describeMutation({
        kind: "succeeded",
        op: "commit",
        detail: "Committed abc on main",
        receipt: "inline",
      }),
      "Committed abc on main",
    );
    NodeAssert.equal(
      describeMutation({
        kind: "failed",
        op: "stage",
        detail: "Stage failed: denied",
        receipt: "inline",
      }),
      "Stage failed: denied",
    );
  });
});

NodeTest.describe("vcs view model — ref create/switch gating", () => {
  // Remote rows carry the wire shape refRows produces: bare name + remote.
  const rows = [
    { name: "main", current: true, isDefault: true, remote: null, worktreePath: null },
    { name: "topic", current: false, isDefault: false, remote: null, worktreePath: null },
    { name: "wt", current: false, isDefault: false, remote: null, worktreePath: "/wt/wt" },
    { name: "main", current: false, isDefault: false, remote: "origin", worktreePath: null },
    { name: "feature", current: false, isDefault: false, remote: "origin", worktreePath: null },
  ];
  const currentBranch = rows.find((r) => r.current && r.remote === null)?.name ?? null;

  NodeTest.it("trims input, rejects empty and duplicate local names", () => {
    NodeAssert.deepEqual(planRefCreate("  feature/x  ", rows), {
      refName: "feature/x",
      disabled: null,
    });
    NodeAssert.equal(planRefCreate("   ", rows).refName, null);
    NodeAssert.equal(planRefCreate("   ", rows).disabled, "Enter a branch name");
    NodeAssert.equal(planRefCreate("main", rows).refName, null);
    NodeAssert.match(planRefCreate("main", rows).disabled ?? "", /already exists/);
    // A remote ref origin/main must not block creating local "main" —
    // check against a remote-only row set:
    NodeAssert.equal(
      planRefCreate("main", [rows[3]]).refName,
      "main",
      "remote origin/main does not collide with local main",
    );
  });

  NodeTest.it("gates switch by current/worktree/remote-of-current state", () => {
    NodeAssert.deepEqual(refSwitchState(rows[0], currentBranch), {
      ok: false,
      reason: null,
    }); // current: no control
    NodeAssert.deepEqual(refSwitchState(rows[1], currentBranch), { ok: true, reason: null });
    NodeAssert.deepEqual(refSwitchState(rows[2], currentBranch), {
      ok: false,
      reason: "Checked out in a worktree",
    });
    // origin/main while on main: the tracking checkout lands where we
    // already are — a no-op gets the reason, not a button.
    NodeAssert.deepEqual(refSwitchState(rows[3], currentBranch), {
      ok: false,
      reason: "Remote of the current branch",
    });
    NodeAssert.deepEqual(refSwitchState(rows[4], currentBranch), { ok: true, reason: null });
  });

  NodeTest.it("sends remote refs remote-qualified on the wire", () => {
    // The driver resolves refs/remotes/<refName> — a bare name would
    // check out a same-named LOCAL branch instead of tracking the remote.
    NodeAssert.equal(refSwitchTarget(rows[1]), "topic");
    NodeAssert.equal(refSwitchTarget(rows[3]), "origin/main");
    NodeAssert.equal(refSwitchTarget(rows[4]), "origin/feature");
  });
});

NodeTest.describe("vcs view model — refs", () => {
  NodeTest.it("projects refs to rows with current/default/worktree/remote badges", () => {
    const rows = refRows({
      isRepo: true,
      hasPrimaryRemote: true,
      nextCursor: null,
      totalCount: 3,
      refs: [
        { name: "main", current: true, isDefault: true, worktreePath: null },
        { name: "topic", current: false, isDefault: false, worktreePath: "/wt/topic" },
        {
          name: "main",
          isRemote: true,
          remoteName: "origin",
          current: false,
          isDefault: false,
          worktreePath: null,
        },
      ],
    });
    NodeAssert.equal(rows.length, 3);
    NodeAssert.equal(describeRef(rows[0]), "current · default");
    NodeAssert.equal(describeRef(rows[1]), "worktree");
    NodeAssert.equal(describeRef(rows[2]), "origin");
    NodeAssert.equal(rows[2].remote, "origin");
    NodeAssert.deepEqual(refRows(null), []);
  });
});

NodeTest.describe("vcs view model — repository gate", () => {
  NodeTest.it("gates loading, error, no-repo, unsupported and ready", () => {
    NodeAssert.deepEqual(repositoryState(null, null), { kind: "loading" });
    NodeAssert.deepEqual(repositoryState(null, "grant denied"), {
      kind: "unavailable",
      detail: "grant denied",
    });
    NodeAssert.deepEqual(
      repositoryState(caps({ detected: false, kind: null, detail: "no .git" }), null),
      { kind: "no-repository", detail: "no .git" },
    );
    const nonGit = caps({
      kind: "jj",
      operations: {
        "status.get": false,
        "status.refresh": false,
        "status.subscribe": false,
        "refs.list": false,
        "refs.create": false,
        "refs.switch": false,
        "changes.list": false,
        "changes.stage": false,
        "changes.unstage": false,
        "changes.commit": false,
        "diff.getPreview": false,
        "diff.getFileContents": false,
        "repository.pull": false,
        "repository.init": false,
        "repository.createWorktree": false,
        "repository.removeWorktree": false,
        "repository.push": false,
        "repository.fetch": false,
        "repository.listRemotes": false,
      },
    });
    const unsupported = repositoryState(nonGit, null);
    NodeAssert.equal(unsupported.kind, "unsupported");
    NodeAssert.equal(unsupported.driverKind, "jj");
    NodeAssert.equal(repositoryState(caps(), null).kind, "ready");
  });
});

NodeTest.describe("vcs view model — pull gating", () => {
  const onMain = local({ hasWorkingTreeChanges: false });

  NodeTest.it("requires a branch, an upstream, and a fast-forwardable behind count", () => {
    NodeAssert.equal(pullState(null, remote()).disabled, "Repository status pending");
    NodeAssert.equal(
      pullState(local({ refName: null }), remote()).disabled,
      "Detached HEAD — checkout a ref before pulling",
    );
    NodeAssert.equal(pullState(onMain, null).disabled, "Upstream status pending");
    NodeAssert.equal(
      pullState(onMain, remote({ hasUpstream: false })).disabled,
      "No upstream configured",
    );
    NodeAssert.equal(pullState(onMain, remote({ behindCount: 0 })).disabled, "Already up to date");
    // Diverged can never fast-forward — native shows the same rebase hint.
    NodeAssert.equal(
      pullState(onMain, remote({ behindCount: 2, aheadCount: 1 })).disabled,
      "Diverged from upstream — rebase or merge first",
    );
  });

  NodeTest.it("enables with the behind count in the label", () => {
    const plan = pullState(onMain, remote({ behindCount: 3 }));
    NodeAssert.equal(plan.disabled, null);
    NodeAssert.equal(plan.label, "Pull ↓3");
  });
});

NodeTest.describe("vcs view model — push gating", () => {
  const clean = local({ hasWorkingTreeChanges: false });

  NodeTest.it("mirrors native's disabled reasons in order", () => {
    NodeAssert.equal(pushState(null, remote()).disabled, "Repository status pending");
    NodeAssert.equal(
      pushState(local({ refName: null, hasWorkingTreeChanges: false }), remote()).disabled,
      "Detached HEAD — checkout a ref before pushing",
    );
    NodeAssert.equal(
      pushState(local({ hasWorkingTreeChanges: true }), remote()).disabled,
      "Commit local changes before pushing",
    );
    NodeAssert.equal(pushState(clean, null).disabled, "Upstream status pending");
    NodeAssert.equal(
      pushState(clean, remote({ behindCount: 2, aheadCount: 0 })).disabled,
      "Behind upstream — pull first",
    );
    NodeAssert.equal(
      pushState(clean, remote({ behindCount: 1, aheadCount: 2 })).disabled,
      "Diverged from upstream — rebase or merge first",
    );
  });

  NodeTest.it("publishes via the driver's -u path when a primary remote exists", () => {
    // No upstream, no remote at all: native's "Publish repository" dialog —
    // deferred, so the panel names the missing remote instead.
    NodeAssert.equal(
      pushState(clean, remote({ hasUpstream: false, aheadCount: 2 })).disabled,
      'Add an "origin" remote before pushing',
    );
    // No upstream but a remote and commits ahead of base: native's push
    // action, which lands on the driver's push -u publish path.
    const publish = pushState(
      local({ hasWorkingTreeChanges: false, hasPrimaryRemote: true }),
      remote({ hasUpstream: false, aheadCount: 2 }),
    );
    NodeAssert.equal(publish.disabled, null);
    NodeAssert.equal(publish.label, "Push ↑2");
    // Nothing ahead of base → the native "No local commits to push" hint.
    NodeAssert.equal(
      pushState(
        local({ hasWorkingTreeChanges: false, hasPrimaryRemote: true }),
        remote({ hasUpstream: false, aheadCount: 0 }),
      ).disabled,
      "No local commits to push",
    );
  });

  NodeTest.it("enables ahead-of-upstream pushes with the count in the label", () => {
    const plan = pushState(clean, remote({ aheadCount: 2 }));
    NodeAssert.equal(plan.disabled, null);
    NodeAssert.equal(plan.label, "Push ↑2");
    NodeAssert.equal(
      pushState(clean, remote({ aheadCount: 0 })).disabled,
      "No local commits to push",
    );
  });
});

NodeTest.describe("vcs view model — publish repository", () => {
  NodeTest.it("offers publish on a repository with no primary remote", () => {
    NodeAssert.deepEqual(publishOffer(local({ hasPrimaryRemote: false })), {
      offered: true,
      disabled: null,
    });
  });

  NodeTest.it("hides the offer once an origin remote exists — native's menu condition", () => {
    NodeAssert.deepEqual(publishOffer(local({ hasPrimaryRemote: true })), {
      offered: false,
      disabled: null,
    });
  });

  NodeTest.it("hides the offer on a non-repository or before status arrives", () => {
    NodeAssert.equal(publishOffer(null).offered, false);
    NodeAssert.equal(publishOffer(local({ isRepo: false, refName: null })).offered, false);
  });

  NodeTest.it(
    "disables rather than hides on detached HEAD — the push half would strand a created repo",
    () => {
      NodeAssert.deepEqual(publishOffer(local({ refName: null })), {
        offered: true,
        disabled: "Detached HEAD — checkout a ref before publishing",
      });
    },
  );

  NodeTest.it(
    "still offers publish with a dirty tree — publish pushes commits, not the working tree",
    () => {
      NodeAssert.equal(publishOffer(local({ hasWorkingTreeChanges: true })).disabled, null);
    },
  );

  NodeTest.it("offers every concrete provider; unknown is never a publish target", () => {
    NodeAssert.deepEqual(
      PUBLISH_PROVIDERS.map((option) => option.value),
      ["github", "gitlab", "azure-devops", "bitbucket", "forgejo"],
    );
    NodeAssert.equal(publishProviderOption("github").label, "GitHub");
    // An out-of-catalogue kind still resolves to an option rather than crashing the form.
    NodeAssert.equal(publishProviderOption("unknown").value, "github");
  });

  NodeTest.it("parses owner/name like the native dialog — nested groups keep the tail", () => {
    NodeAssert.deepEqual(planPublish({ repository: "owner/repo", remoteName: "origin" }), {
      disabled: null,
      repository: "owner/repo",
      remoteName: "origin",
    });
    NodeAssert.deepEqual(
      planPublish({ repository: "  group/sub/repo  ", remoteName: "upstream" }),
      { disabled: null, repository: "group/sub/repo", remoteName: "upstream" },
    );
  });

  NodeTest.it("blocks submit until the repository parses as owner/name", () => {
    for (const repository of ["", "   ", "noslash", "/repo", "owner/", "owner/  "]) {
      const plan = planPublish({ repository, remoteName: "origin" });
      NodeAssert.equal(plan.repository, null, repository);
      NodeAssert.equal(plan.disabled, "Enter a repository as owner/name");
    }
  });

  NodeTest.it("defaults a blank remote name to origin, matching native", () => {
    const plan = planPublish({ repository: "owner/repo", remoteName: "   " });
    NodeAssert.equal(plan.disabled, null);
    NodeAssert.equal(plan.remoteName, "origin");
  });

  NodeTest.it("describes a pushed publish with the real remote and branch", () => {
    NodeAssert.equal(
      describePublishResult({
        repository: {
          provider: "github",
          nameWithOwner: "octo/hello",
          url: "https://github.com/octo/hello",
          sshUrl: "git@github.com:octo/hello.git",
        },
        remoteName: "origin",
        remoteUrl: "git@github.com:octo/hello.git",
        branch: "main",
        upstreamBranch: "origin/main",
        status: "pushed",
      }),
      "Published octo/hello (https://github.com/octo/hello) — pushed main to origin",
    );
  });

  NodeTest.it("describes remote_added as the partial it is — nothing pushed yet", () => {
    NodeAssert.equal(
      describePublishResult({
        repository: {
          provider: "gitlab",
          nameWithOwner: "grp/proj",
          url: "https://gitlab.com/grp/proj",
          sshUrl: "git@gitlab.com:grp/proj.git",
        },
        remoteName: "origin-1",
        remoteUrl: "git@gitlab.com:grp/proj.git",
        branch: "main",
        status: "remote_added",
      }),
      'Created grp/proj (https://gitlab.com/grp/proj) — remote "origin-1" added; commit and push to share code',
    );
  });
});

NodeTest.describe("vcs view model — remotes and worktrees", () => {
  const rows = [
    { name: "main", current: true, isDefault: true, remote: null, worktreePath: null },
    { name: "topic", current: false, isDefault: false, remote: null, worktreePath: null },
    { name: "wt", current: false, isDefault: false, remote: null, worktreePath: "/wt/wt" },
    { name: "main", current: false, isDefault: false, remote: "origin", worktreePath: null },
  ];

  NodeTest.it("projects listRemotes into display rows", () => {
    NodeAssert.deepEqual(
      remoteRows({
        isRepo: true,
        remotes: [
          { name: "origin", url: "/r/origin.git", pushUrl: null, isPrimary: true },
          { name: "fork", url: "/r/fork.git", pushUrl: "/r/fork-push.git", isPrimary: false },
        ],
      }),
      [
        { name: "origin", url: "/r/origin.git", isPrimary: true },
        { name: "fork", url: "/r/fork.git", isPrimary: false },
      ],
    );
    NodeAssert.deepEqual(remoteRows(null), []);
  });

  NodeTest.it(
    "derives worktree rows from refs worktreePath, excluding the current checkout",
    () => {
      NodeAssert.deepEqual(worktreeRows(rows), [{ refName: "wt", path: "/wt/wt" }]);
    },
  );

  NodeTest.it("gates per-ref worktree creation to non-current local refs", () => {
    NodeAssert.equal(canWorktreeRef(rows[0]), false); // current checkout
    NodeAssert.equal(canWorktreeRef(rows[1]), true); // free local branch
    NodeAssert.equal(canWorktreeRef(rows[2]), false); // already in a worktree
    NodeAssert.equal(canWorktreeRef(rows[3]), false); // remote ref
  });

  NodeTest.it("plans new-branch worktrees off the current branch", () => {
    const plan = planWorktreeCreate("  feature/x ", rows, "main");
    NodeAssert.deepEqual(plan, {
      branch: "feature/x",
      refName: "main",
      baseRefName: "main",
      disabled: null,
    });
    NodeAssert.equal(planWorktreeCreate("", rows, "main").disabled, "Enter a branch name");
    NodeAssert.match(planWorktreeCreate("topic", rows, "main").disabled ?? "", /already exists/);
    // Detached HEAD: start point is HEAD itself, no base branch to name.
    NodeAssert.deepEqual(planWorktreeCreate("fix", rows, null), {
      branch: "fix",
      refName: "HEAD",
      baseRefName: null,
      disabled: null,
    });
  });
});

NodeTest.describe("vcs view model — stacked actions", () => {
  const lanes = (overrides = {}) => ({
    conflicted: [],
    staged: [],
    changes: [change("a.ts", { unstaged: true })],
    untracked: [],
    ...overrides,
  });
  const offerOf = (offers, action) => offers.find((o) => o.action === action);

  NodeTest.it("labels every stacked action kind", () => {
    NodeAssert.equal(stackedActionLabel("commit"), "Commit");
    NodeAssert.equal(stackedActionLabel("commit_push"), "Commit & push");
    NodeAssert.equal(stackedActionLabel("commit_push_pr"), "Commit, push & create PR");
    NodeAssert.equal(stackedActionLabel("push"), "Push");
    NodeAssert.equal(stackedActionLabel("create_pr"), "Push & create PR");
  });

  NodeTest.it("offers the full composite set for a dirty pushable branch", () => {
    const offers = stackedActionOffers(
      local({ hasWorkingTreeChanges: true }),
      remote(),
      lanes(),
      false,
    );
    NodeAssert.deepEqual(
      offers.map((o) => o.action),
      ["commit", "commit_push", "commit_push_pr", "push", "create_pr"],
    );
    // commit phases can run; standalone push/create_pr can't (dirty tree, nothing ahead).
    NodeAssert.equal(offerOf(offers, "commit").disabled, null);
    NodeAssert.equal(offerOf(offers, "commit_push").disabled, null);
    NodeAssert.equal(offerOf(offers, "commit_push_pr").disabled, null);
    NodeAssert.match(offerOf(offers, "push").disabled ?? "", /Commit local changes/);
    NodeAssert.match(offerOf(offers, "create_pr").disabled ?? "", /Commit local changes/);
  });

  NodeTest.it("blocks every commit-including action on conflicts", () => {
    const conflicted = lanes({ conflicted: [change("x.ts", { conflicted: true })] });
    const offers = stackedActionOffers(local(), remote(), conflicted, false);
    for (const action of ["commit", "commit_push", "commit_push_pr"]) {
      NodeAssert.match(offerOf(offers, action).disabled ?? "", /conflicts/);
    }
    // Standalone push keeps its own reason, not the conflict one.
    NodeAssert.match(offerOf(offers, "push").disabled ?? "", /Commit local changes/);
  });

  NodeTest.it("blocks clean-tree commit offers but allows push when ahead", () => {
    const offers = stackedActionOffers(
      local({ hasWorkingTreeChanges: false }),
      remote({ aheadCount: 2 }),
      EMPTY_LANES,
      false,
    );
    NodeAssert.match(offerOf(offers, "commit").disabled ?? "", /No changes/);
    NodeAssert.match(offerOf(offers, "commit_push").disabled ?? "", /No changes/);
    NodeAssert.equal(offerOf(offers, "push").disabled, null);
    NodeAssert.equal(offerOf(offers, "create_pr").disabled, null);
  });

  NodeTest.it("blocks PR-including actions when a PR is already open", () => {
    const openPr = remote({ aheadCount: 1, pr: { state: "open", number: 7 } });
    const offers = stackedActionOffers(local(), openPr, lanes(), false);
    NodeAssert.match(offerOf(offers, "commit_push_pr").disabled ?? "", /already open/);
    NodeAssert.match(offerOf(offers, "create_pr").disabled ?? "", /already open/);
    NodeAssert.equal(offerOf(offers, "commit_push").disabled, null);
  });

  NodeTest.it("offers create_pr on an already-pushed branch with a default delta", () => {
    // Clean feature branch, upstream current (ahead 0), commits over the
    // default ref — native's canCreatePr needs push feasibility, not
    // outstanding commits: GitManager skips the push phase when the
    // upstream is already current.
    const offers = stackedActionOffers(
      local({ hasWorkingTreeChanges: false }),
      remote({ aheadCount: 0, aheadOfDefaultCount: 2 }),
      EMPTY_LANES,
      false,
    );
    NodeAssert.equal(offerOf(offers, "create_pr").disabled, null);
    NodeAssert.equal(
      stackedActionSuggestion(
        local({ hasWorkingTreeChanges: false }),
        remote({ aheadCount: 0, aheadOfDefaultCount: 2 }),
      ),
      "create_pr",
    );
    // Its own rules still stand: dirty tree, open PR, no delta.
    NodeAssert.match(
      offerOf(
        stackedActionOffers(
          local({ hasWorkingTreeChanges: true }),
          remote({ aheadCount: 0, aheadOfDefaultCount: 2 }),
          lanes(),
          false,
        ),
        "create_pr",
      ).disabled ?? "",
      /Commit local changes/,
    );
    NodeAssert.match(
      offerOf(
        stackedActionOffers(
          local({ hasWorkingTreeChanges: false }),
          remote({ aheadCount: 0, aheadOfDefaultCount: 2, pr: { state: "open", number: 9 } }),
          EMPTY_LANES,
          false,
        ),
        "create_pr",
      ).disabled ?? "",
      /already open/,
    );
    NodeAssert.match(
      offerOf(
        stackedActionOffers(
          local({ hasWorkingTreeChanges: false }),
          remote({ aheadCount: 0, aheadOfDefaultCount: 0 }),
          EMPTY_LANES,
          false,
        ),
        "create_pr",
      ).disabled ?? "",
      /default branch/,
    );
  });

  NodeTest.it("requires the default-branch confirmation for every action but commit", () => {
    const onDefault = local({ isDefaultRef: true, refName: "main" });
    NodeAssert.equal(stackedActionNeedsConfirm("commit", onDefault, false), false);
    for (const action of ["push", "create_pr", "commit_push", "commit_push_pr"]) {
      NodeAssert.equal(stackedActionNeedsConfirm(action, onDefault, false), true);
    }
    // A checked feature-branch choice IS the native alternative — no prompt.
    NodeAssert.equal(stackedActionNeedsConfirm("commit_push_pr", onDefault, true), false);
    // Off the default ref nothing needs the prompt.
    NodeAssert.equal(stackedActionNeedsConfirm("commit_push_pr", local(), false), false);
    NodeAssert.equal(stackedActionNeedsConfirm("push", null, false), false);
  });

  NodeTest.it(
    "lets a stale featureBranch flag skip the prompt only where a commit phase exists",
    () => {
      const onDefault = local({ isDefaultRef: true, refName: "main" });
      // Commit-capable actions accept the flag as the feature-ref answer.
      for (const action of ["commit_push", "commit_push_pr"]) {
        NodeAssert.equal(stackedActionNeedsConfirm(action, onDefault, true), false);
      }
      // push/create_pr cannot carry a feature branch — a checked flag
      // answers nothing and the prompt still stands.
      for (const action of ["push", "create_pr"]) {
        NodeAssert.equal(stackedActionNeedsConfirm(action, onDefault, true), true);
      }
    },
  );

  NodeTest.it("never sends featureBranch or scoped paths on push/PR-only actions", () => {
    for (const action of ["push", "create_pr"]) {
      NodeAssert.equal(stackedActionCommits(action), false);
      NodeAssert.deepEqual(
        stackedActionInput({
          action,
          commitMessage: "msg",
          featureBranch: true,
          stagedPaths: ["a.ts"],
        }),
        { action, commitMessage: "msg" },
      );
    }
  });

  NodeTest.it("keeps featureBranch and scoped paths on commit-capable actions", () => {
    for (const action of ["commit", "commit_push", "commit_push_pr"]) {
      NodeAssert.equal(stackedActionCommits(action), true);
      NodeAssert.deepEqual(
        stackedActionInput({
          action,
          commitMessage: "msg",
          featureBranch: true,
          stagedPaths: ["a.ts"],
        }),
        { action, commitMessage: "msg", featureBranch: true, paths: ["a.ts"] },
      );
    }
    // Blank message is omitted — native leave-blank auto-generate.
    NodeAssert.deepEqual(
      stackedActionInput({
        action: "commit_push",
        commitMessage: "",
        featureBranch: false,
        stagedPaths: [],
      }),
      { action: "commit_push" },
    );
  });

  NodeTest.it("lets a feature branch run with a clean tree and no branch delta", () => {
    const offers = stackedActionOffers(
      local({ hasWorkingTreeChanges: false, isDefaultRef: true }),
      remote(),
      EMPTY_LANES,
      true,
    );
    NodeAssert.equal(offerOf(offers, "commit").disabled, null);
    NodeAssert.equal(offerOf(offers, "commit_push_pr").disabled, null);
  });

  NodeTest.it("reports pending status when local is unknown", () => {
    const offers = stackedActionOffers(null, null, EMPTY_LANES, false);
    NodeAssert.ok(offers.every((o) => o.disabled === "Repository status pending"));
  });

  NodeTest.it("suggests the native quick action per status", () => {
    // Dirty on a pushable non-default branch: the full composite.
    NodeAssert.equal(stackedActionSuggestion(local(), remote()), "commit_push_pr");
    // Dirty with an open PR or on the default ref: commit & push only.
    NodeAssert.equal(
      stackedActionSuggestion(local(), remote({ pr: { state: "open", number: 1 } })),
      "commit_push",
    );
    NodeAssert.equal(
      stackedActionSuggestion(local({ isDefaultRef: true }), remote()),
      "commit_push",
    );
    // Dirty without a push path: commit only.
    NodeAssert.equal(
      stackedActionSuggestion(local({ hasPrimaryRemote: false }), remote({ hasUpstream: false })),
      "commit",
    );
    // Clean + ahead + no open PR: create_pr; open PR: plain push.
    NodeAssert.equal(
      stackedActionSuggestion(local({ hasWorkingTreeChanges: false }), remote({ aheadCount: 1 })),
      "create_pr",
    );
    NodeAssert.equal(
      stackedActionSuggestion(
        local({ hasWorkingTreeChanges: false }),
        remote({ aheadCount: 1, pr: { state: "open", number: 2 } }),
      ),
      "push",
    );
    // Behind/diverged: nothing honest to suggest.
    NodeAssert.equal(
      stackedActionSuggestion(
        local({ hasWorkingTreeChanges: false }),
        remote({ aheadCount: 1, behindCount: 1 }),
      ),
      null,
    );
    NodeAssert.equal(
      stackedActionSuggestion(local({ hasWorkingTreeChanges: false }), remote()),
      null,
    );
  });

  NodeTest.it("reduces actionProgress events into the live model", () => {
    let model = IDLE_STACKED_PROGRESS;
    model = applyStackedEvent(model, {
      kind: "action_started",
      action: "commit_push_pr",
      phases: ["commit", "push", "pr"],
    });
    model = applyStackedEvent(model, {
      kind: "phase_started",
      action: "commit_push_pr",
      phase: "commit",
      label: "Committing changes",
    });
    NodeAssert.equal(
      describeStackedProgress(model),
      "Commit, push & create PR — Committing changes",
    );
    model = applyStackedEvent(model, {
      kind: "hook_started",
      action: "commit_push_pr",
      hookName: "pre-commit",
    });
    model = applyStackedEvent(model, {
      kind: "hook_output",
      action: "commit_push_pr",
      hookName: "pre-commit",
      stream: "stdout",
      text: "lint ok\ntest ok\n",
    });
    NodeAssert.equal(describeStackedProgress(model), "Commit, push & create PR — test ok");
    model = applyStackedEvent(model, {
      kind: "hook_finished",
      action: "commit_push_pr",
      hookName: "pre-commit",
      exitCode: 0,
      durationMs: 10,
    });
    NodeAssert.equal(model.hook, null);
    model = applyStackedEvent(model, {
      kind: "action_failed",
      action: "commit_push_pr",
      phase: "push",
      message: "rejected: non-fast-forward",
    });
    NodeAssert.deepEqual(model.failure, {
      phase: "push",
      message: "rejected: non-fast-forward",
    });
  });

  NodeTest.it("carries the post-service revocation closed event by name", () => {
    let model = IDLE_STACKED_PROGRESS;
    model = applyStackedEvent(model, {
      kind: "action_started",
      action: "push",
      phases: ["push"],
    });
    model = applyStackedEvent(model, {
      kind: "action_finished",
      action: "push",
      result: {
        action: "push",
        branch: { status: "skipped_not_requested" },
        commit: { status: "skipped_no_changes", messageSource: "not_applicable" },
        push: { status: "pushed", branch: "feat" },
        pr: { status: "skipped_not_requested", contentSource: "not_applicable" },
        toast: { title: "Pushed", cta: { kind: "none" } },
      },
    });
    // The phase terminal arrived — the detached post-check can still
    // append a named denial after it.
    model = applyStackedEvent(model, { kind: "closed", reason: "authorization-revoked" });
    NodeAssert.equal(model.closed, "authorization-revoked");
    NodeAssert.notEqual(model.result, null);
  });

  NodeTest.it("describes the settled result with provenance markers", () => {
    const result = {
      action: "commit_push_pr",
      branch: { status: "skipped_not_requested" },
      commit: { status: "created", commitSha: "abc", messageSource: "generated" },
      push: { status: "pushed", branch: "feat" },
      pr: {
        status: "created",
        url: "https://github.com/o/r/pull/9",
        contentSource: "generated",
      },
      toast: { title: "Created PR", cta: { kind: "none" } },
    };
    NodeAssert.equal(
      describeStackedResult(result),
      "Created PR — generated commit message — https://github.com/o/r/pull/9",
    );
    const existing = {
      ...result,
      commit: { status: "created", commitSha: "abc", messageSource: "caller" },
      pr: {
        status: "opened_existing",
        url: "https://github.com/o/r/pull/9",
        contentSource: "existing",
      },
    };
    NodeAssert.equal(
      describeStackedResult(existing),
      "Created PR — existing PR https://github.com/o/r/pull/9",
    );
  });
});

NodeTest.describe("themeVarOverrides", () => {
  const cssVars = {
    mutedForeground: "--app-theme-muted-foreground",
    border: "--app-theme-border",
    error: "--app-theme-error",
    warning: "--app-theme-warning",
    text: "--app-theme-text",
    canvas: "--app-theme-canvas",
    accentSurface: "--app-theme-accent-surface",
    muted: "--app-theme-muted",
  };

  NodeTest.it("republishes contract tokens as panel-scoped vars", () => {
    const overrides = themeVarOverrides(
      {
        mutedForeground: "#98a2b3",
        border: "#eaecf0",
        error: "#f04438",
        warning: "#dc6803",
        text: "#101828",
        canvas: "#ffffff",
        accentSurface: "#e8eef7",
        muted: "#f4f5f7",
      },
      cssVars,
    );
    NodeAssert.deepEqual(overrides, {
      "--t3-version-control-muted-foreground": "var(--app-theme-muted-foreground, #98a2b3)",
      "--t3-version-control-border": "var(--app-theme-border, #eaecf0)",
      "--t3-version-control-error": "var(--app-theme-error, #f04438)",
      "--t3-version-control-warning": "var(--app-theme-warning, #dc6803)",
      "--t3-version-control-text": "var(--app-theme-text, #101828)",
      "--t3-version-control-canvas": "var(--app-theme-canvas, #ffffff)",
      "--t3-version-control-accent-surface": "var(--app-theme-accent-surface, #e8eef7)",
      "--t3-version-control-muted": "var(--app-theme-muted, #f4f5f7)",
    });
  });

  NodeTest.it("skips roles the host did not resolve rather than overriding them", () => {
    const overrides = themeVarOverrides({ text: "#101828" }, cssVars);
    NodeAssert.deepEqual(overrides, {
      "--t3-version-control-text": "var(--app-theme-text, #101828)",
    });
  });

  NodeTest.it("falls back to the resolved value when no css var is advertised", () => {
    const overrides = themeVarOverrides({ mutedForeground: "#98a2b3" }, {});
    NodeAssert.deepEqual(overrides, {
      "--t3-version-control-muted-foreground": "#98a2b3",
    });
  });

  NodeTest.it("ignores unrelated roles the contract does not publish to this panel", () => {
    const overrides = themeVarOverrides(
      { mutedForeground: "#98a2b3", terminalBackground: "#000000", chrome: "#111" },
      { ...cssVars, terminalBackground: "--app-theme-terminal-background" },
    );
    NodeAssert.deepEqual(Object.keys(overrides), ["--t3-version-control-muted-foreground"]);
  });
});

NodeTest.describe("nextThemeVars — no stale fallback", () => {
  const cssVars = { text: "--app-theme-text" };

  NodeTest.it("clears the published map on any read loss, even after a good read", () => {
    // A resolved read followed by a failed refresh or a lost subscription
    // must not leave the last theme painted — the map returns to null so
    // the legacy var() chain renders.
    const published = nextThemeVars({ ok: true, tokens: { text: "#111" }, cssVars });
    NodeAssert.deepEqual(published, {
      "--t3-version-control-text": "var(--app-theme-text, #111)",
    });
    NodeAssert.equal(nextThemeVars({ ok: false }), null);
    NodeAssert.equal(nextThemeVars({ ok: false }), null);
  });

  NodeTest.it("recovers on the next resolved read, including hosts without css vars", () => {
    NodeAssert.equal(nextThemeVars({ ok: false }), null);
    const republished = nextThemeVars({ ok: true, tokens: { text: "#222" }, cssVars: {} });
    NodeAssert.deepEqual(republished, { "--t3-version-control-text": "#222" });
  });
});

NodeTest.describe("mutation toasts", () => {
  NodeTest.it("opens a loading toast with the running label", () => {
    NodeAssert.deepEqual(mutationToastStart("Pushing"), {
      severity: "loading",
      title: "Pushing…",
    });
  });

  NodeTest.it("settles success as the receipt detail on the same toast", () => {
    NodeAssert.deepEqual(mutationToastSettle("Pushing", { ok: true, detail: "Pushed main" }), {
      severity: "success",
      title: "Pushed main",
    });
  });

  NodeTest.it("settles failure as a named title with the error in the body", () => {
    NodeAssert.deepEqual(
      mutationToastSettle("Pushing", { ok: false, detail: "rejected: non-fast-forward" }),
      {
        severity: "error",
        title: "Pushing failed",
        body: "rejected: non-fast-forward",
      },
    );
  });
});

// Native's commit toast offers Push (GitManager cta); the plugin's receipts
// carry the same follow-up and run it through the stacked runner.
NodeTest.describe("mutation follow-ups", () => {
  const result = (cta) => ({ toast: { title: "t", cta } });

  NodeTest.it("offers native's server-decided run_action CTA, nothing else", () => {
    NodeAssert.deepEqual(COMMIT_FOLLOW_UP, { label: "Push", action: "push" });
    NodeAssert.deepEqual(
      stackedFollowUp(result({ kind: "run_action", label: "Push", action: { kind: "push" } })),
      { label: "Push", action: "push" },
    );
    NodeAssert.deepEqual(
      stackedFollowUp(
        result({ kind: "run_action", label: "Create PR", action: { kind: "create_pr" } }),
      ),
      { label: "Create PR", action: "create_pr" },
    );
    NodeAssert.equal(stackedFollowUp(result({ kind: "none" })), null);
    NodeAssert.equal(
      stackedFollowUp(result({ kind: "open_pr", label: "View PR", url: "https://x/1" })),
      null,
    );
  });

  const fakeNotifications = (outcome, options = {}) => {
    const calls = [];
    return {
      calls,
      api: {
        notify: (input) => {
          calls.push(["notify", input]);
          return options.rejectNotify
            ? Promise.reject(new Error("denied"))
            : Promise.resolve({ notificationId: "receipt" });
        },
        dismiss: (id) => {
          calls.push(["dismiss", id]);
          const failure = options.rejectDismiss?.(id);
          return failure === undefined ? Promise.resolve() : Promise.reject(failure);
        },
        awaitAction: (id) => {
          calls.push(["awaitAction", id]);
          if (options.throwAwaitAction) throw new Error("bridge gone");
          return Promise.resolve(outcome);
        },
      },
    };
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  NodeTest.it(
    "replaces the loading toast with a receipt whose button runs the action",
    async () => {
      const { calls, api } = fakeNotifications({ actionId: FOLLOW_UP_ACTION_ID });
      const posted = [];
      const ran = [];
      const replaced = await postFollowUpReceipt(
        api,
        "loading",
        "Committed abc",
        COMMIT_FOLLOW_UP,
        {
          onPosted: (id) => posted.push(id),
          run: (action) => ran.push(action),
        },
      );
      await flush();
      NodeAssert.equal(replaced, true);
      NodeAssert.deepEqual(calls, [
        [
          "notify",
          {
            severity: "success",
            title: "Committed abc",
            actions: [{ id: FOLLOW_UP_ACTION_ID, label: "Push", variant: "primary" }],
          },
        ],
        ["awaitAction", "receipt"],
        ["dismiss", "loading"],
      ]);
      NodeAssert.deepEqual(posted, ["receipt"]);
      NodeAssert.deepEqual(ran, ["push"]);
    },
  );

  NodeTest.it("a dismissed receipt runs nothing", async () => {
    const { api } = fakeNotifications({ dismissed: true });
    const ran = [];
    await postFollowUpReceipt(api, "loading", "Committed abc", COMMIT_FOLLOW_UP, {
      onPosted: () => {},
      run: (action) => ran.push(action),
    });
    await flush();
    NodeAssert.deepEqual(ran, []);
  });

  NodeTest.it("a failed post keeps the loading toast for the in-place update", async () => {
    const { calls, api } = fakeNotifications({ dismissed: true }, { rejectNotify: true });
    const replaced = await postFollowUpReceipt(api, "loading", "Committed abc", COMMIT_FOLLOW_UP, {
      onPosted: () => NodeAssert.fail("no receipt was posted"),
      run: () => NodeAssert.fail("nothing to run"),
    });
    NodeAssert.equal(replaced, false);
    NodeAssert.deepEqual(
      calls.map(([method]) => method),
      ["notify"],
    );
  });
});

NodeTest.describe("postFollowUpReceipt — guarded failures", () => {
  const recorder = (options) => {
    const calls = [];
    return {
      calls,
      api: {
        notify: () => Promise.resolve({ notificationId: "receipt" }),
        dismiss: (id) => {
          calls.push(id);
          const failure = options.rejectDismiss?.(id);
          return failure === undefined ? Promise.resolve() : Promise.reject(failure);
        },
        awaitAction: () => {
          if (options.throwAwaitAction) throw new Error("bridge gone");
          return new Promise(() => {});
        },
      },
    };
  };
  const post = (api, onPosted = () => {}) =>
    postFollowUpReceipt(api, "loading", "Committed abc", COMMIT_FOLLOW_UP, {
      onPosted,
      run: () => NodeAssert.fail("nothing to run"),
    });

  NodeTest.it("a failed loading dismiss retracts the receipt for the in-place update", async () => {
    const { calls, api } = recorder({
      rejectDismiss: (id) => (id === "loading" ? new Error("transport lost") : undefined),
    });
    NodeAssert.equal(await post(api), false);
    NodeAssert.deepEqual(calls, ["loading", "receipt"]);
  });

  NodeTest.it("a loading toast the user already dismissed still counts as replaced", async () => {
    const { calls, api } = recorder({
      rejectDismiss: (id) => (id === "loading" ? new Error("notification-expired") : undefined),
    });
    NodeAssert.equal(await post(api), true);
    NodeAssert.deepEqual(calls, ["loading"]);
  });

  NodeTest.it("a throwing onPosted keeps the loading toast and retracts the receipt", async () => {
    const { calls, api } = recorder({});
    const replaced = await post(api, () => {
      throw new Error("timer failed");
    });
    NodeAssert.equal(replaced, false);
    NodeAssert.deepEqual(calls, ["receipt"]);
  });

  NodeTest.it(
    "a throwing awaitAction invoke keeps the loading toast and retracts the receipt",
    async () => {
      const { calls, api } = recorder({ throwAwaitAction: true });
      NodeAssert.equal(
        await post(api, () => NodeAssert.fail("an unarmed receipt is not posted")),
        false,
      );
      NodeAssert.deepEqual(calls, ["receipt"]);
    },
  );

  NodeTest.it("a failed receipt retraction still resolves false instead of rejecting", async () => {
    const { calls, api } = recorder({ rejectDismiss: () => new Error("transport lost") });
    NodeAssert.equal(await post(api), false);
    NodeAssert.deepEqual(calls, ["loading", "receipt"]);
  });
});

NodeTest.describe("stackedChooserReason", () => {
  const open = { action: "push", label: "Push", disabled: null };
  NodeTest.it("a blocked offer names its own reason", () => {
    const blocked = { ...open, disabled: "Behind upstream — pull first" };
    NodeAssert.equal(stackedChooserReason(blocked, "push", true), "Behind upstream — pull first");
  });
  NodeTest.it("a follow-up held back by an in-flight mutation says why", () => {
    NodeAssert.equal(
      stackedChooserReason(open, "push", true),
      "Another action is running — run this once it finishes",
    );
  });
  NodeTest.it("says nothing once the mutation settles or for another action", () => {
    NodeAssert.equal(stackedChooserReason(open, "push", false), null);
    NodeAssert.equal(stackedChooserReason(open, "commit_push", true), null);
    NodeAssert.equal(stackedChooserReason(open, null, true), null);
  });
});

NodeTest.describe("isNotificationDismissal", () => {
  NodeTest.it("recognizes the bridged notification-expired code as user dismissal", () => {
    NodeAssert.equal(
      isNotificationDismissal(
        new Error("notification-expired: The notification is unknown or expired."),
      ),
      true,
    );
    NodeAssert.equal(isNotificationDismissal("notification-expired"), true);
  });

  NodeTest.it("treats every other rejection as delivery loss, not dismissal", () => {
    NodeAssert.equal(
      isNotificationDismissal(new Error("notification-owner-mismatch: not yours")),
      false,
    );
    NodeAssert.equal(isNotificationDismissal(new Error("client-provider-unavailable")), false);
    NodeAssert.equal(isNotificationDismissal(new Error("View is inactive")), false);
    NodeAssert.equal(isNotificationDismissal({ reason: "nope" }), false);
  });
});

NodeTest.describe("dismissReceiptAfterSeen", () => {
  const stubSource = (seen) => {
    const controller = new AbortController();
    const source = {
      seenNow: seen,
      signal: controller.signal,
      listeners: /** @type {Set<() => void>} */ (new Set()),
      seen() {
        return source.seenNow;
      },
      onChange(listener) {
        source.listeners.add(listener);
        return () => source.listeners.delete(listener);
      },
      setSeen(next) {
        source.seenNow = next;
        for (const listener of source.listeners) listener();
      },
    };
    return source;
  };

  NodeTest.it("dismisses after the window when seen throughout", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
    const source = stubSource(true);
    let dismissed = 0;
    dismissReceiptAfterSeen(source, 10_000, () => dismissed++);
    t.mock.timers.tick(9_999);
    NodeAssert.equal(dismissed, 0);
    t.mock.timers.tick(1);
    NodeAssert.equal(dismissed, 1);
    NodeAssert.equal(source.listeners.size, 0, "watch torn down on fire");
  });

  NodeTest.it("a settle while unseen keeps its full window after returning", (t) => {
    // The mutation completed while another thread was active or the
    // document was backgrounded — the clock must not run while unseen,
    // and returning must not dismiss without a readable interval.
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
    const source = stubSource(false);
    let dismissed = 0;
    dismissReceiptAfterSeen(source, 10_000, () => dismissed++);
    t.mock.timers.tick(120_000);
    NodeAssert.equal(dismissed, 0, "no clock while unseen");
    source.setSeen(true);
    NodeAssert.equal(dismissed, 0, "returning does not dismiss on the spot");
    t.mock.timers.tick(9_999);
    NodeAssert.equal(dismissed, 0);
    t.mock.timers.tick(1);
    NodeAssert.equal(dismissed, 1, "full readable window after return");
  });

  NodeTest.it("pauses and resumes across hidden spans instead of restarting", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
    const source = stubSource(true);
    let dismissed = 0;
    dismissReceiptAfterSeen(source, 10_000, () => dismissed++);
    t.mock.timers.tick(4_000);
    source.setSeen(false);
    t.mock.timers.tick(60_000);
    NodeAssert.equal(dismissed, 0, "hidden span does not burn the window");
    source.setSeen(true);
    t.mock.timers.tick(5_999);
    NodeAssert.equal(dismissed, 0);
    t.mock.timers.tick(1);
    NodeAssert.equal(dismissed, 1, "the remaining 6 s resume, not a fresh 10 s");
  });

  NodeTest.it("gives up without firing when the session dies mid-window", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
    const source = stubSource(true);
    let dismissed = 0;
    dismissReceiptAfterSeen(source, 10_000, () => dismissed++);
    t.mock.timers.tick(2_000);
    source.signal.dispatchEvent(new Event("abort"));
    NodeAssert.equal(source.listeners.size, 0);
    t.mock.timers.tick(60_000);
    NodeAssert.equal(dismissed, 0);
  });
});
