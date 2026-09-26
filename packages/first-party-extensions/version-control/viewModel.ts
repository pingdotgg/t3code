/**
 * Pure view-model for the Version Control panel (reads and mutations).
 * Owns the model the view renders over the public `t3.vcs/*`
 * contracts: staging-lane grouping from `t3.vcs/changes` porcelain flags,
 * the status stream reduction, branch/upstream/ahead-behind text, refs
 * rows, the repository-capability gate, and the mutation controls —
 * per-row/per-lane stage actions, the commit plan, ref create/switch
 * gating, and the single-flight mutation state.
 *
 * Types come from the SDK catalogue; the private wire shapes and client-runtime atoms
 * stay host-side.
 */
import type {
  PrsProviderKind,
  VcsActionKind,
  VcsActionPhase,
  VcsActionProgressEvent,
  VcsActionPublishResult,
  VcsActionResult,
  VcsActionRunInput,
  VcsCapabilitiesResult,
  VcsChangeEntry,
  VcsListRefsResult,
  VcsListRemotesResult,
  VcsRefEntry,
  VcsStatusLocal,
  VcsStatusRemote,
  VcsStatusStreamEvent,
} from "@t3tools/extension-sdk/catalogue";

/* ---------------- staging lanes ---------------- */

/**
 * Staging lanes rendered by the panel. `staged` and `changes` are
 * membership sets, not a partition: porcelain `MM` puts one path in both.
 * `conflicted` is exclusive by contract construction (the host parser
 * reports UU/AA/DD with all other flags false); `untracked` (`??`)
 * carries neither index flag.
 */
export type ChangeLane = "conflicted" | "staged" | "changes" | "untracked";

export const CHANGE_LANES: readonly ChangeLane[] = ["conflicted", "staged", "changes", "untracked"];

export interface LaneGroups {
  readonly conflicted: readonly VcsChangeEntry[];
  readonly staged: readonly VcsChangeEntry[];
  readonly changes: readonly VcsChangeEntry[];
  readonly untracked: readonly VcsChangeEntry[];
}

export const EMPTY_LANES: LaneGroups = {
  conflicted: [],
  staged: [],
  changes: [],
  untracked: [],
};

/** Group change entries into display lanes, preserving host order. */
export function lanesFromChanges(entries: readonly VcsChangeEntry[]): LaneGroups {
  const groups: {
    conflicted: VcsChangeEntry[];
    staged: VcsChangeEntry[];
    changes: VcsChangeEntry[];
    untracked: VcsChangeEntry[];
  } = { conflicted: [], staged: [], changes: [], untracked: [] };
  for (const entry of entries) {
    if (entry.conflicted) groups.conflicted.push(entry);
    if (entry.staged) groups.staged.push(entry);
    if (entry.unstaged) groups.changes.push(entry);
    if (entry.untracked) groups.untracked.push(entry);
    // A contract-valid entry always sets at least one flag; an entry with
    // none would vanish from every lane, so keep it visible under changes
    // rather than silently dropping a reported path.
    if (!entry.conflicted && !entry.staged && !entry.unstaged && !entry.untracked)
      groups.changes.push(entry);
  }
  return groups;
}

export function laneTitle(lane: ChangeLane): string {
  switch (lane) {
    case "conflicted":
      return "Merge conflicts";
    case "staged":
      return "Staged changes";
    case "changes":
      return "Changes";
    case "untracked":
      return "Untracked files";
  }
}

export function laneCount(lanes: LaneGroups): number {
  return (
    lanes.conflicted.length + lanes.staged.length + lanes.changes.length + lanes.untracked.length
  );
}

/** State flags of one entry as a short label, e.g. "staged, modified". */
export function describeEntry(entry: VcsChangeEntry): string {
  if (entry.conflicted) return "conflicted";
  if (entry.untracked) return "untracked";
  if (entry.staged && entry.unstaged) return "staged, also modified";
  if (entry.staged) return "staged";
  if (entry.unstaged) return "modified";
  return "changed";
}

/* ---------------- mutation controls ---------------- */

/**
 * The mutation operations this slice invokes. `stage`/`unstage`/`commit`
 * map to `t3.vcs/changes` methods, `ref-create`/`ref-switch` to
 * `t3.vcs/refs` methods, and `pull`/`push`/`fetch`/`init`/worktree ops to
 * `t3.vcs/repository` — all `effect:"write"` under `t3.vcs/mutate`.
 * `stacked` and `publish` ride `t3.vcs/actions` under the same grant
 * (publish additionally chain-checks `t3.prs/write` server-side).
 */
export type MutationOp =
  | "stage"
  | "unstage"
  | "commit"
  | "stacked"
  | "ref-create"
  | "ref-switch"
  | "pull"
  | "push"
  | "fetch"
  | "init"
  | "publish"
  | "worktree-create"
  | "worktree-remove";

/** The contract's vcsPathsInput bound — stage/unstage chunk to it, commit cannot exceed it. */
export const VCS_PATHS_MAX = 100;

export interface LaneMutation {
  readonly op: "stage" | "unstage";
  readonly label: string;
}

/**
 * The bulk action a lane header offers (native parity: the lanes exist so
 * the index is real state). `conflicted` offers none — the contract has
 * no conflict-resolution operation and staging a conflicted path would
 * mark it resolved silently.
 */
export function laneMutation(lane: ChangeLane): LaneMutation | null {
  switch (lane) {
    case "staged":
      return { op: "unstage", label: "Unstage all" };
    case "changes":
    case "untracked":
      return { op: "stage", label: "Stage all" };
    case "conflicted":
      return null;
  }
}

/** The per-row action inside a lane; conflicted rows offer none. */
export function entryMutation(lane: ChangeLane): LaneMutation | null {
  const bulk = laneMutation(lane);
  if (bulk === null) return null;
  return { ...bulk, label: bulk.op === "stage" ? "Stage" : "Unstage" };
}

export interface CommitPlan {
  /** Why the commit control is disabled; null when it may run. */
  readonly disabled: string | null;
  /** Button label, e.g. "Commit staged (2)" or "Commit all changes". */
  readonly label: string;
  /**
   * `paths` to hand `changes.commit` — the staged lane when one exists
   * (native's selected-subset semantics), undefined for commit-all
   * (`add -A`, native's all-selected default).
   */
  readonly paths: readonly string[] | undefined;
}

/**
 * Commit planning. The conflicted lane hard-blocks: the contract's
 * prepare step is `reset` + `add -A`, which mid-merge clears unmerged
 * index entries and stages conflict markers — native cannot see
 * conflicted state to block it, this panel can and does. A staged set
 * over the 100-path input bound also blocks: a commit cannot be chunked
 * like stage/unstage, so the button would be a fake affordance — the
 * honest out is unstaging down or unstaging all to commit-all.
 */
export function planCommit(lanes: LaneGroups, message: string): CommitPlan {
  if (lanes.conflicted.length > 0) {
    return {
      disabled: "Resolve merge conflicts before committing",
      label: "Commit",
      paths: undefined,
    };
  }
  const staged = lanes.staged.map((entry) => entry.path);
  if (staged.length > VCS_PATHS_MAX) {
    return {
      disabled: `Over ${VCS_PATHS_MAX} staged paths — unstage some, or unstage all to commit every change`,
      label: `Commit staged (${staged.length})`,
      paths: undefined,
    };
  }
  if (laneCount(lanes) === 0) {
    return { disabled: "No changes to commit", label: "Commit", paths: undefined };
  }
  if (message.trim().length === 0) {
    const label = staged.length > 0 ? `Commit staged (${staged.length})` : "Commit all changes";
    return { disabled: "Enter a commit message", label, paths: undefined };
  }
  if (staged.length > 0) {
    return {
      disabled: null,
      label: `Commit staged (${staged.length})`,
      paths: staged,
    };
  }
  return { disabled: null, label: "Commit all changes", paths: undefined };
}

/**
 * Where the mutation's transient receipt is delivered. "notification" means
 * a live `t3.ui/notifications` toast carries it; "inline" paints the panel's
 * mutation row. The channel is recorded on the phase — not on adapter
 * liveness — so a mutation that began before the capability probe resolved
 * keeps its inline row even when toasts come up mid-flight.
 */
export type MutationReceipt = "inline" | "notification";

/** Single-flight mutation phase — one op at a time, like native's serialized VCS actions. */
export type MutationPhase =
  | { readonly kind: "idle" }
  | {
      readonly kind: "running";
      readonly op: MutationOp;
      readonly label: string;
      readonly receipt: MutationReceipt;
    }
  | {
      readonly kind: "succeeded";
      readonly op: MutationOp;
      readonly detail: string;
      readonly receipt: MutationReceipt;
    }
  | {
      readonly kind: "failed";
      readonly op: MutationOp;
      readonly detail: string;
      readonly receipt: MutationReceipt;
    };

export const IDLE_MUTATION: MutationPhase = { kind: "idle" };

/**
 * Begin a mutation. Returns null when one is already running — the view
 * disables all mutation controls on `running`, so a null here is also the
 * guard against a raced second click. `receipt` names the channel the
 * caller already secured: a begun toast or the inline fallback.
 */
export function startMutation(
  phase: MutationPhase,
  op: MutationOp,
  label: string,
  receipt: MutationReceipt,
): MutationPhase | null {
  if (phase.kind === "running") return null;
  return { kind: "running", op, label, receipt };
}

/** Settle the running op: rejection detail (the named error) or a success line. */
export function settleMutation(
  phase: MutationPhase,
  op: MutationOp,
  result: { readonly ok: boolean; readonly detail: string },
): MutationPhase {
  const receipt = phase.kind !== "idle" && phase.op === op ? phase.receipt : "inline";
  return result.ok
    ? { kind: "succeeded", op, detail: result.detail, receipt }
    : { kind: "failed", op, detail: result.detail, receipt };
}

/**
 * Toast delivery for `op` failed after it began — a rejected `notify`, an
 * unapplied `update`, or a dismissed loading toast. The phase keeps its
 * detail but the receipt channel returns to the inline row; the mutation
 * outcome must never silently vanish.
 */
export function releaseMutationReceipt(op: MutationOp): (phase: MutationPhase) => MutationPhase {
  return (phase) =>
    phase.kind !== "idle" && phase.op === op && phase.receipt === "notification"
      ? { ...phase, receipt: "inline" }
      : phase;
}

/** One-line rendering of the mutation phase for the panel status line. */
export function describeMutation(phase: MutationPhase): string | null {
  switch (phase.kind) {
    case "idle":
      return null;
    case "running":
      return `${phase.label}…`;
    case "succeeded":
      return phase.detail;
    case "failed":
      return phase.detail;
  }
}

/** Branch-create plan: trimmed non-empty, no duplicate local name. */
export function planRefCreate(
  input: string,
  rows: readonly RefRow[],
): { readonly refName: string | null; readonly disabled: string | null } {
  const refName = input.trim();
  if (refName.length === 0) return { refName: null, disabled: "Enter a branch name" };
  if (rows.some((row) => row.remote === null && row.name === refName)) {
    return { refName: null, disabled: `Branch ${refName} already exists` };
  }
  return { refName, disabled: null };
}

/**
 * Whether a ref row may be switched to. Current rows render no control at
 * all; a ref checked out in a worktree is disabled by name — native
 * retargets the thread to that worktree, which the project-scope panel
 * has no contract for, and git would refuse the checkout anyway. A remote
 * row whose tracking target is the current branch is a no-op, so it gets
 * the reason instead of a dead button.
 */
export function refSwitchState(
  row: RefRow,
  currentBranch: string | null,
): {
  readonly ok: boolean;
  readonly reason: string | null;
} {
  if (row.current) return { ok: false, reason: null };
  if (row.worktreePath !== null) return { ok: false, reason: "Checked out in a worktree" };
  if (row.remote !== null && row.name === currentBranch) {
    return { ok: false, reason: "Remote of the current branch" };
  }
  return { ok: true, reason: null };
}

/**
 * The `refs.switch` wire name for a row: remote refs must go out
 * remote-qualified (`origin/main`) — the driver resolves
 * `refs/remotes/<refName>` for its tracking-checkout matrix, and a bare
 * name would check out a same-named LOCAL branch instead.
 */
export function refSwitchTarget(row: RefRow): string {
  return row.remote === null ? row.name : `${row.remote}/${row.name}`;
}

/* ---------------- repository sync ops ---------------- */

export interface SyncControlState {
  /** Why the control is disabled; null when it may run. */
  readonly disabled: string | null;
  readonly label: string;
}

/**
 * Pull gating mirrors the native quick action (GitActionsControl.logic.ts):
 * `pull --ff-only` only exists when the branch tracks an upstream, and a
 * diverged branch can never fast-forward — native disables sync with a
 * rebase/merge hint rather than offering a pull that must fail.
 */
export function pullState(
  local: VcsStatusLocal | null,
  remote: VcsStatusRemote | null,
): SyncControlState {
  if (local === null) return { disabled: "Repository status pending", label: "Pull" };
  if (local.refName === null)
    return { disabled: "Detached HEAD — checkout a ref before pulling", label: "Pull" };
  if (remote === null) return { disabled: "Upstream status pending", label: "Pull" };
  if (!remote.hasUpstream) return { disabled: "No upstream configured", label: "Pull" };
  if (remote.behindCount > 0 && remote.aheadCount > 0)
    return { disabled: "Diverged from upstream — rebase or merge first", label: "Pull" };
  if (remote.behindCount === 0) return { disabled: "Already up to date", label: "Pull" };
  return { disabled: null, label: `Pull ↓${remote.behindCount}` };
}

/**
 * Push gating mirrors the native menu item's disabled reasons in the same
 * order (GitActionsControl.logic.ts): detached HEAD, dirty tree, behind or
 * diverged upstream, then the no-upstream cases — no pushable remote at all
 * (the `publishOffer` surface below covers native's "Publish repository"
 * path) versus the ahead-of-base case, where the driver's `push -u`
 * publish path is exactly what native's push action runs. `aheadCount`
 * without an upstream counts
 * against the base branch, so the same number labels the button.
 */
export function pushState(
  local: VcsStatusLocal | null,
  remote: VcsStatusRemote | null,
): SyncControlState {
  if (local === null) return { disabled: "Repository status pending", label: "Push" };
  if (local.refName === null)
    return { disabled: "Detached HEAD — checkout a ref before pushing", label: "Push" };
  if (local.hasWorkingTreeChanges)
    return { disabled: "Commit local changes before pushing", label: "Push" };
  if (remote === null) return { disabled: "Upstream status pending", label: "Push" };
  if (remote.behindCount > 0)
    return {
      disabled:
        remote.aheadCount > 0
          ? "Diverged from upstream — rebase or merge first"
          : "Behind upstream — pull first",
      label: "Push",
    };
  if (!remote.hasUpstream && !local.hasPrimaryRemote)
    return { disabled: 'Add an "origin" remote before pushing', label: "Push" };
  if (remote.aheadCount === 0) return { disabled: "No local commits to push", label: "Push" };
  return { disabled: null, label: `Push ↑${remote.aheadCount}` };
}

/* ---------------- stacked actions (t3.vcs/actions) ---------------- */

/**
 * The composite-action surface — `t3.vcs/actions.run` runs the native
 * stacked action (commit → push → create-PR phases) under a server-minted
 * actionId; progress arrives on the `actionProgress` stream. The offer
 * set mirrors the native menu/quick-action gating
 * (GitActionsControl.logic.ts): commit needs a dirty tree or a feature
 * branch to create, push needs a branch that is not behind with an
 * upstream or primary remote, and the PR phase additionally needs no
 * open PR and a delta over the default branch. Conflicted trees block
 * every commit-including action for the same reason `planCommit` does —
 * the composite's commit phase is `add -A` and would stage conflict
 * markers.
 */
export interface StackedActionOffer {
  readonly action: VcsActionKind;
  readonly label: string;
  /** Why the offer is disabled; null when it may run. */
  readonly disabled: string | null;
}

export function stackedActionLabel(action: VcsActionKind): string {
  switch (action) {
    case "commit":
      return "Commit";
    case "push":
      return "Push";
    case "create_pr":
      return "Push & create PR";
    case "commit_push":
      return "Commit & push";
    case "commit_push_pr":
      return "Commit, push & create PR";
  }
}

const STACKED_ACTION_ORDER: readonly VcsActionKind[] = [
  "commit",
  "commit_push",
  "commit_push_pr",
  "push",
  "create_pr",
];

export function stackedActionOffers(
  local: VcsStatusLocal | null,
  remote: VcsStatusRemote | null,
  lanes: LaneGroups,
  featureBranch: boolean,
): readonly StackedActionOffer[] {
  const offer = (action: VcsActionKind, disabled: string | null): StackedActionOffer => ({
    action,
    label: stackedActionLabel(action),
    disabled,
  });
  if (local === null) {
    return STACKED_ACTION_ORDER.map((action) => offer(action, "Repository status pending"));
  }
  const hasBranch = local.refName !== null;
  const hasChanges = local.hasWorkingTreeChanges || featureBranch;
  const hasOpenPr = remote?.pr?.state === "open";
  const isBehind = (remote?.behindCount ?? 0) > 0;
  const hasDefaultDelta =
    (remote?.aheadOfDefaultCount ?? remote?.aheadCount ?? 0) > 0 || hasChanges;
  const conflicts =
    lanes.conflicted.length > 0 ? "Resolve merge conflicts before committing" : null;
  const tooManyStaged =
    lanes.staged.length > VCS_PATHS_MAX
      ? `Over ${VCS_PATHS_MAX} staged paths — unstage some first`
      : null;
  const commitBlocked =
    conflicts ??
    tooManyStaged ??
    (!hasChanges ? "No changes to commit" : null) ??
    (!hasBranch && !featureBranch ? "Detached HEAD — checkout a ref first" : null);
  const remotePending = remote === null ? "Upstream status pending" : null;
  const remoteBehind =
    remote !== null && isBehind
      ? remote.aheadCount > 0
        ? "Diverged from upstream — rebase or merge first"
        : "Behind upstream — pull first"
      : null;
  const remoteMissing =
    remote !== null && !remote.hasUpstream && !local.hasPrimaryRemote
      ? 'Add an "origin" remote before pushing'
      : null;
  /**
   * The standalone push block — dirty tree and nothing-ahead included.
   * Composite offers don't inherit these two: their commit phase produces
   * the commits, so they only need the push FEASIBLE checks.
   */
  const pushBlocked =
    (!hasBranch ? "Detached HEAD — checkout a ref first" : null) ??
    (local.hasWorkingTreeChanges ? "Commit local changes before pushing" : null) ??
    remotePending ??
    remoteBehind ??
    remoteMissing ??
    (remote !== null && remote.aheadCount === 0 ? "No local commits to push" : null);
  const pushPhaseBlocked =
    (!hasBranch ? "Detached HEAD — checkout a ref first" : null) ??
    remotePending ??
    remoteBehind ??
    remoteMissing;
  // An open PR is named before push feasibility — native's reason order.
  const openPrBlocked = hasOpenPr ? "A pull request is already open for this branch" : null;
  const prDeltaBlocked = !hasDefaultDelta ? "No commits over the default branch" : null;
  /**
   * `create_pr` needs push FEASIBILITY but not outstanding commits —
   * native's canCreatePr only asks for a clean tree, a default-branch
   * delta, no open PR and a reachable remote; GitManager skips the push
   * phase when the upstream is already current. Requiring aheadCount > 0
   * would strand the ordinary already-pushed branch.
   */
  const createPrBlocked =
    openPrBlocked ??
    (local.hasWorkingTreeChanges ? "Commit local changes first" : null) ??
    pushPhaseBlocked ??
    prDeltaBlocked;
  return [
    offer("commit", commitBlocked),
    offer("commit_push", commitBlocked ?? pushPhaseBlocked),
    offer("commit_push_pr", commitBlocked ?? openPrBlocked ?? pushPhaseBlocked ?? prDeltaBlocked),
    offer("push", pushBlocked),
    offer("create_pr", createPrBlocked),
  ];
}

/**
 * The one action native's quick-action button would pick right now —
 * `resolveQuickAction` reduced to the run_action kinds this contract
 * carries (pull and publish are separate surfaces; open-PR lives in the
 * pull-request view). Returns null when no stacked action is the honest
 * suggestion.
 */
export function stackedActionSuggestion(
  local: VcsStatusLocal | null,
  remote: VcsStatusRemote | null,
): VcsActionKind | null {
  if (local === null || local.refName === null) return null;
  const hasChanges = local.hasWorkingTreeChanges;
  const hasOpenPr = remote?.pr?.state === "open";
  const isAhead = (remote?.aheadCount ?? 0) > 0;
  const hasDefaultDelta = (remote?.aheadOfDefaultCount ?? remote?.aheadCount ?? 0) > 0;
  const isBehind = (remote?.behindCount ?? 0) > 0;
  const isDiverged = isAhead && isBehind;
  const pushable = remote?.hasUpstream === true || local.hasPrimaryRemote;

  if (hasChanges) {
    if (!pushable) return "commit";
    return hasOpenPr || local.isDefaultRef ? "commit_push" : "commit_push_pr";
  }
  if (!pushable || isDiverged || isBehind) return null;
  if (isAhead) return hasOpenPr || local.isDefaultRef ? "push" : "create_pr";
  if (hasDefaultDelta && !local.isDefaultRef && !hasOpenPr) return "create_pr";
  return null;
}

/**
 * Which actions carry a commit phase — GitManager's `isCommitAction`.
 * `featureBranch` is only meaningful there: the service rejects it on
 * push-only or PR-only requests, and a fresh ref off the default branch
 * has nothing to push or open a PR from until the commit phase lands.
 */
export function stackedActionCommits(action: VcsActionKind): boolean {
  return action === "commit" || action === "commit_push" || action === "commit_push_pr";
}

/**
 * The request payload for `actions.run`. `featureBranch` and `paths`
 * ride along only when the action has a commit phase — sending either
 * on a push-only or PR-only action gets the request rejected.
 */
export function stackedActionInput(input: {
  readonly action: VcsActionKind;
  /** Trimmed; "" keeps native leave-blank auto-generate semantics. */
  readonly commitMessage: string;
  readonly featureBranch: boolean;
  readonly stagedPaths: readonly string[];
}): VcsActionRunInput {
  const commits = stackedActionCommits(input.action);
  return {
    action: input.action,
    ...(input.commitMessage === "" ? {} : { commitMessage: input.commitMessage }),
    ...(commits && input.featureBranch ? { featureBranch: true } : {}),
    ...(commits && input.stagedPaths.length > 0 ? { paths: input.stagedPaths } : {}),
  };
}

/**
 * The reason beside the stacked chooser's Run. A blocked offer names its
 * own; a receipt follow-up clicked while another mutation holds the
 * single-flight runner selects its action without running, so the chooser
 * says why until that mutation settles.
 */
export function stackedChooserReason(
  offer: StackedActionOffer,
  deferredFollowUp: VcsActionKind | null,
  busy: boolean,
): string | null {
  if (offer.disabled !== null) return offer.disabled;
  return busy && deferredFollowUp === offer.action
    ? "Another action is running — run this once it finishes"
    : null;
}

/**
 * Native's `requiresDefaultBranchConfirmation` — every action except a
 * plain commit needs an explicit continue/feature-ref decision before it
 * runs on the default ref. Picking "new feature branch" IS the native
 * alternative, so a checked featureBranch already answers the prompt —
 * but only where a commit phase can use it; a stale flag on a push-only
 * or PR-only pick answers nothing.
 */
export function stackedActionNeedsConfirm(
  action: VcsActionKind,
  local: VcsStatusLocal | null,
  featureBranch: boolean,
): boolean {
  if (local?.isDefaultRef !== true || action === "commit") return false;
  return !(featureBranch && stackedActionCommits(action));
}

/** Live composite progress, folded from `actionProgress` events. */
export interface StackedActionProgress {
  readonly action: VcsActionKind | null;
  readonly phases: readonly VcsActionPhase[];
  /** Phases reported started — the last entry is the one in flight. */
  readonly started: readonly { readonly phase: VcsActionPhase; readonly label: string }[];
  readonly hook: { readonly name: string | null; readonly lastLine: string | null } | null;
  readonly result: VcsActionResult | null;
  readonly failure: { readonly phase: VcsActionPhase | null; readonly message: string } | null;
  readonly closed: "overflow" | "authorization-revoked" | null;
}

export const IDLE_STACKED_PROGRESS: StackedActionProgress = {
  action: null,
  phases: [],
  started: [],
  hook: null,
  result: null,
  failure: null,
  closed: null,
};

export function applyStackedEvent(
  model: StackedActionProgress,
  event: VcsActionProgressEvent,
): StackedActionProgress {
  switch (event.kind) {
    case "action_started":
      return { ...IDLE_STACKED_PROGRESS, action: event.action, phases: event.phases };
    case "phase_started":
      return {
        ...model,
        started: [...model.started, { phase: event.phase, label: event.label }],
      };
    case "hook_started":
      return { ...model, hook: { name: event.hookName, lastLine: null } };
    case "hook_output": {
      const lastLine = event.text.trimEnd().split("\n").pop() ?? null;
      return {
        ...model,
        hook: { name: event.hookName ?? model.hook?.name ?? null, lastLine },
      };
    }
    case "hook_finished":
      return model.hook === null ? model : { ...model, hook: null };
    case "action_finished":
      return { ...model, result: event.result };
    case "action_failed":
      return { ...model, failure: { phase: event.phase, message: event.message } };
    case "closed":
      return { ...model, closed: event.reason };
  }
}

/** One-line rendering of in-flight composite progress for the panel. */
export function describeStackedProgress(model: StackedActionProgress): string {
  const current = model.started[model.started.length - 1] ?? null;
  const tail = model.hook?.lastLine ?? current?.label ?? "Starting";
  return `${model.action === null ? "Action" : stackedActionLabel(model.action)} — ${tail}`;
}

/**
 * The settled line for the mutation status row. Success leads with the
 * composite's own toast title; provenance markers name who wrote the text —
 * `generated` means the host composed the message/body, `existing` an
 * already-open PR's words.
 */
export function describeStackedResult(result: VcsActionResult): string {
  const parts = [result.toast.title];
  if (result.commit.messageSource === "generated") parts.push("generated commit message");
  if (result.pr.status === "created" && result.pr.url !== undefined) parts.push(result.pr.url);
  if (result.pr.status === "opened_existing" && result.pr.url !== undefined)
    parts.push(`existing PR ${result.pr.url}`);
  return parts.join(" — ");
}

/* ---------------- publish repository (t3.vcs/actions) ---------------- */

/** The providers `actions.publishRepository` accepts — `unknown` is never offered. */
export type PublishProviderKind = Exclude<PrsProviderKind, "unknown">;

export interface PublishProviderOption {
  readonly value: PublishProviderKind;
  readonly label: string;
  /** The repository-path placeholder native shows per provider. */
  readonly pathPlaceholder: string;
}

/**
 * The publish offer's provider set — `open_publish`'s picker mirrored.
 * Native orders these by a readiness probe (`sourceControl.*` discovery)
 * that no contract exposes, so every concrete provider stays offered and
 * an unconfigured one fails by name at invoke time rather than hiding.
 */
export const PUBLISH_PROVIDERS: readonly PublishProviderOption[] = [
  { value: "github", label: "GitHub", pathPlaceholder: "owner/repo" },
  { value: "gitlab", label: "GitLab", pathPlaceholder: "group/project" },
  { value: "azure-devops", label: "Azure DevOps", pathPlaceholder: "project/repository" },
  { value: "bitbucket", label: "Bitbucket", pathPlaceholder: "workspace/repository" },
  { value: "forgejo", label: "Forgejo / Gitea", pathPlaceholder: "owner/repo" },
];

export function publishProviderOption(kind: PrsProviderKind): PublishProviderOption {
  return PUBLISH_PROVIDERS.find((option) => option.value === kind) ?? PUBLISH_PROVIDERS[0];
}

export interface PublishOffer {
  /** Whether the affordance renders — native's `!hasPrimaryRemote` menu condition. */
  readonly offered: boolean;
  /** Why the offer is blocked; null when it may run. */
  readonly disabled: string | null;
}

/**
 * The publish offer state. The affordance exists whenever the workspace
 * is a repository without an "origin" remote — native's menu-item
 * condition — but a detached HEAD disables rather than hides: publish
 * creates the host repository and wires the remote *before* pushing, so
 * a run that cannot push still leaves those effects behind, and the
 * offer names its blocker instead of letting the click do the damage.
 */
export function publishOffer(local: VcsStatusLocal | null): PublishOffer {
  if (local === null || !local.isRepo || local.hasPrimaryRemote) {
    return { offered: false, disabled: null };
  }
  if (local.refName === null) {
    return { offered: true, disabled: "Detached HEAD — checkout a ref before publishing" };
  }
  return { offered: true, disabled: null };
}

export interface PublishPlan {
  /** Why submit is disabled; null when the input may be sent. */
  readonly disabled: string | null;
  /** Trimmed repository path — null while the input is invalid. */
  readonly repository: string | null;
  /** Trimmed remote name; "origin" when left blank (native's default). */
  readonly remoteName: string;
}

/**
 * Publish-submit validation, mirroring the native dialog's gate: the
 * repository must parse as `<owner>/<name>` — everything after the first
 * `/` is the name, so nested groups resolve the way the host provider
 * expects.
 */
export function planPublish(input: {
  readonly repository: string;
  readonly remoteName: string;
}): PublishPlan {
  const remoteName = input.remoteName.trim() || "origin";
  const parts = input.repository.trim().split("/");
  const owner = parts[0]?.trim() ?? "";
  const name = parts.slice(1).join("/").trim();
  if (owner.length === 0 || name.length === 0) {
    return { disabled: "Enter a repository as owner/name", repository: null, remoteName };
  }
  return { disabled: null, repository: input.repository.trim(), remoteName };
}

/**
 * The settled publish line. `remote_added` is the empty-repo partial —
 * the host repository and remote exist but nothing was pushed, so the
 * line says what remains rather than claiming a publish.
 */
export function describePublishResult(result: VcsActionPublishResult): string {
  const target = `${result.repository.nameWithOwner} (${result.repository.url})`;
  return result.status === "pushed"
    ? `Published ${target} — pushed ${result.branch} to ${result.remoteName}`
    : `Created ${target} — remote "${result.remoteName}" added; commit and push to share code`;
}

/* ---------------- remotes + worktrees ---------------- */

export interface RemoteRow {
  readonly name: string;
  readonly url: string;
  readonly isPrimary: boolean;
}

export function remoteRows(result: VcsListRemotesResult | null): readonly RemoteRow[] {
  return (result?.remotes ?? []).map((remote) => ({
    name: remote.name,
    url: remote.url,
    isPrimary: remote.isPrimary,
  }));
}

export interface WorktreeRow {
  readonly refName: string;
  readonly path: string;
}

/**
 * Worktree rows are derived from `refs.list` `worktreePath` — the same
 * field native's branch selector uses; there is no separate worktree-list
 * RPC. The current checkout's own row is excluded (a worktree cannot
 * remove itself). A detached-HEAD worktree maps to no ref and is
 * invisible, matching native's branch-based listing.
 */
export function worktreeRows(rows: readonly RefRow[]): readonly WorktreeRow[] {
  return rows.flatMap((row) =>
    row.worktreePath !== null && !row.current
      ? [{ refName: row.name, path: row.worktreePath }]
      : [],
  );
}

/**
 * Whether a ref may be checked out in a new worktree: local only, not the
 * current checkout, and not already checked out elsewhere (git refuses
 * the same branch in two worktrees). No control renders otherwise — the
 * ref row already names the worktree/busy state.
 */
export function canWorktreeRef(row: RefRow): boolean {
  return row.remote === null && !row.current && row.worktreePath === null;
}

/**
 * Plan for "new worktree on a new branch" — the native thread-bootstrap
 * shape (`refName` = start point, `newRefName` = the branch to create,
 * `baseRefName` = merge-base bookkeeping). The host assigns the path
 * (`path: null`), so no picker is needed. On a detached HEAD the start
 * point is HEAD itself; baseRefName is omitted since it names a branch.
 */
export function planWorktreeCreate(
  input: string,
  rows: readonly RefRow[],
  currentBranch: string | null,
): {
  readonly branch: string | null;
  readonly refName: string | null;
  readonly baseRefName: string | null;
  readonly disabled: string | null;
} {
  const branch = input.trim();
  const none = { branch: null, refName: null, baseRefName: null } as const;
  if (branch.length === 0) return { ...none, disabled: "Enter a branch name" };
  if (rows.some((row) => row.remote === null && row.name === branch)) {
    return { ...none, disabled: `Branch ${branch} already exists` };
  }
  return {
    branch,
    refName: currentBranch ?? "HEAD",
    baseRefName: currentBranch,
    disabled: null,
  };
}

/* ---------------- selection ---------------- */

export interface ChangeSelection {
  readonly path: string;
  readonly lane: ChangeLane;
}

/**
 * Keep a selection across refreshes: same lane when the path stayed, the
 * first lane (in CHANGE_LANES order) when it moved — e.g. a file staged
 * outside the panel — and null once the path is clean.
 */
export function retainSelection(
  selection: ChangeSelection | null,
  lanes: LaneGroups,
): ChangeSelection | null {
  if (selection === null) return null;
  if (lanes[selection.lane].some((entry) => entry.path === selection.path)) return selection;
  for (const lane of CHANGE_LANES) {
    if (lanes[lane].some((entry) => entry.path === selection.path)) {
      return { path: selection.path, lane };
    }
  }
  return null;
}

/* ---------------- status stream model ---------------- */

export interface StatusModel {
  readonly local: VcsStatusLocal | null;
  readonly remote: VcsStatusRemote | null;
  readonly stream: "connecting" | "live" | "ended";
  readonly detail: string | null;
  /**
   * Bumped on every local-carrying frame (snapshot, localUpdated). The
   * changes/refs lists re-read on it — the host stream is the freshness
   * signal, the panel never polls.
   */
  readonly localRevision: number;
}

export const CONNECTING_STATUS: StatusModel = {
  local: null,
  remote: null,
  stream: "connecting",
  detail: null,
  localRevision: 0,
};

/**
 * Fold a `t3.vcs/status` stream event into the displayed model — the same
 * merge the native client applies (shared/git.ts applyGitStatusStreamEvent)
 * re-derived over the public `kind`-tagged event shape.
 */
export function applyStatusEvent(model: StatusModel, event: VcsStatusStreamEvent): StatusModel {
  switch (event.kind) {
    case "snapshot":
      return {
        local: event.local,
        remote: event.remote,
        stream: "live",
        detail: null,
        localRevision: model.localRevision + 1,
      };
    case "localUpdated":
      return {
        ...model,
        local: event.local,
        stream: "live",
        localRevision: model.localRevision + 1,
      };
    case "remoteUpdated":
      return { ...model, remote: event.remote };
    case "closed":
      return {
        ...model,
        stream: "ended",
        detail:
          event.reason === "overflow"
            ? "The status stream overflowed its event queue."
            : "The status stream reported a status error.",
      };
  }
}

export function branchLabel(local: VcsStatusLocal): string {
  return local.refName ?? "detached HEAD";
}

/** Upstream sync text for the header (incl. the default-ref fallback). */
export function syncLabel(remote: VcsStatusRemote | null): string {
  if (remote === null) return "upstream pending";
  if (!remote.hasUpstream) {
    const ahead = remote.aheadOfDefaultCount;
    return ahead !== undefined && ahead > 0 ? `↑${ahead} vs default branch` : "no upstream";
  }
  if (remote.aheadCount === 0 && remote.behindCount === 0) return "in sync with upstream";
  const parts: string[] = [];
  if (remote.aheadCount > 0) parts.push(`↑${remote.aheadCount}`);
  if (remote.behindCount > 0) parts.push(`↓${remote.behindCount}`);
  return parts.join(" ") + " vs upstream";
}

/** Working-tree summary, e.g. "3 files changed (+12 −4)" or "clean". */
export function workingTreeLabel(local: VcsStatusLocal): string {
  const tree = local.workingTree;
  if (!local.hasWorkingTreeChanges && tree.files.length === 0) return "clean";
  const count = tree.files.length;
  const stat = `+${tree.insertions} −${tree.deletions}`;
  return `${count} file${count === 1 ? "" : "s"} changed (${stat})${tree.truncated ? ", list truncated" : ""}`;
}

/** Per-path numstat from the status payload, when the host reported one. */
export function numstatFor(
  local: VcsStatusLocal | null,
  path: string,
): { readonly insertions: number; readonly deletions: number } | null {
  const file = local?.workingTree.files.find((entry) => entry.path === path);
  return file ? { insertions: file.insertions, deletions: file.deletions } : null;
}

/** One-line status for the footer/header, honest about every panel state. */
export function describeStatus(model: StatusModel): string {
  if (model.stream === "ended") return `Status updates ended — ${model.detail ?? "stream closed"}`;
  if (model.local === null) return "Reading repository status…";
  if (!model.local.isRepo) return "This workspace is not a repository";
  const pr = model.remote?.pr;
  const parts = [branchLabel(model.local), syncLabel(model.remote), workingTreeLabel(model.local)];
  if (pr) parts.push(`PR #${pr.number} ${pr.state}`);
  return parts.join(" — ");
}

/* ---------------- refs ---------------- */

export interface RefRow {
  readonly name: string;
  readonly current: boolean;
  readonly isDefault: boolean;
  readonly remote: string | null;
  readonly worktreePath: string | null;
}

/** Project the refs payload to display rows; remote refs carry `remote/name`. */
export function refRows(result: VcsListRefsResult | null): readonly RefRow[] {
  if (result === null) return [];
  return result.refs.map((ref: VcsRefEntry) => ({
    name: ref.name,
    current: ref.current,
    isDefault: ref.isDefault,
    remote: ref.isRemote ? (ref.remoteName ?? "remote") : null,
    worktreePath: ref.worktreePath,
  }));
}

/** Trailing badges for one ref row, e.g. "current · worktree". */
export function describeRef(row: RefRow): string {
  const badges: string[] = [];
  if (row.current) badges.push("current");
  if (row.isDefault) badges.push("default");
  if (row.remote !== null) badges.push(row.remote);
  if (row.worktreePath !== null) badges.push("worktree");
  return badges.join(" · ");
}

/* ---------------- repository capability gate ---------------- */

export type RepositoryState =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable"; readonly detail: string }
  | { readonly kind: "no-repository"; readonly detail: string | null }
  | { readonly kind: "unsupported"; readonly driverKind: string; readonly detail: string }
  | { readonly kind: "ready"; readonly capabilities: VcsCapabilitiesResult };

/**
 * The honesty gate: `repository.getCapabilities` decides whether the panel
 * renders real state, a real empty state, or a named unsupported driver —
 * never a fabricated clean repo. A detected driver must serve the four
 * reads this slice consumes before the panel calls itself ready.
 */
export function repositoryState(
  capabilities: VcsCapabilitiesResult | null,
  error: string | null,
): RepositoryState {
  if (error !== null) return { kind: "unavailable", detail: error };
  if (capabilities === null) return { kind: "loading" };
  if (!capabilities.detected) {
    return { kind: "no-repository", detail: capabilities.detail };
  }
  const ops = capabilities.operations;
  const required = ["status.get", "status.subscribe", "changes.list", "refs.list"] as const;
  if (required.some((operation) => !ops[operation])) {
    const kind = capabilities.kind ?? "unknown";
    return {
      kind: "unsupported",
      driverKind: kind,
      detail: `The detected ${kind} driver does not serve every status/changes/refs read this panel needs.`,
    };
  }
  return { kind: "ready", capabilities };
}

// ---------------------------------------------------------------------------
// t3.ui/theme consumption
// ---------------------------------------------------------------------------

/**
 * The roles this panel consumes, each republished as a
 * `--t3-version-control-*` custom property on the view root. Component
 * styles chain `var(--t3-version-control-x, …)` onto their pre-contract
 * fallbacks, so a host that cannot serve the contract (ungranted or
 * provider-less) renders exactly what it rendered before adoption. Roles
 * absent here stay theme-independent on purpose: `--info` and `--success`
 * are host constants outside the contract's role set, and the `font-*`
 * vars are not color tokens.
 */
export const VC_THEME_VARS = {
  mutedForeground: "--t3-version-control-muted-foreground",
  border: "--t3-version-control-border",
  error: "--t3-version-control-error",
  warning: "--t3-version-control-warning",
  text: "--t3-version-control-text",
  canvas: "--t3-version-control-canvas",
  accentSurface: "--t3-version-control-accent-surface",
  muted: "--t3-version-control-muted",
} as const;

/**
 * `getTokens` output → root-level custom properties. Each override carries
 * the contract's advertised var name with the resolved value as its
 * fallback, so the panel tracks `--app-theme-*` paints live and still gets
 * the right color on hosts that answer the contract without painting those
 * variables. A role missing from `tokens` is skipped entirely rather than
 * overridden with a lie.
 */
export function themeVarOverrides(
  tokens: Readonly<Record<string, string>>,
  cssVars: Readonly<Record<string, string>>,
): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const [role, property] of Object.entries(VC_THEME_VARS)) {
    const value = tokens[role];
    if (value === undefined) continue;
    const contractVar = cssVars[role];
    overrides[property] = contractVar ? `var(${contractVar}, ${value})` : value;
  }
  return overrides;
}

/**
 * The override map the panel publishes after a theme read. A resolved read
 * repaints fresh `--t3-version-control-*` vars; every loss — a rejected
 * `getTokens`, a closed or errored `subscribeState` stream — clears the map
 * entirely so the panel returns to its legacy `var()` chain. Publishing the
 * last resolved map after the contract stops serving it would paint a theme
 * the host no longer vouches for (the no-stale-fallback rule).
 */
export function nextThemeVars(
  read:
    | {
        readonly ok: true;
        readonly tokens: Readonly<Record<string, string>>;
        readonly cssVars: Readonly<Record<string, string>>;
      }
    | { readonly ok: false },
): Record<string, string> | null {
  return read.ok ? themeVarOverrides(read.tokens, read.cssVars) : null;
}

// ---------------------------------------------------------------------------
// t3.ui/notifications consumption
// ---------------------------------------------------------------------------

/**
 * The toast lifecycle for one mutation — the panel's mirror of native
 * GitActionsControl receipts: `loading` opens on start and the same
 * notification updates to `success` or `error` on settle. A success
 * receipt dismisses after MUTATION_TOAST_DISMISS_MS of *seen* time,
 * matching native's `dismissAfterVisibleMs` — the contract's `update`
 * carries no duration, so the adapter schedules `dismiss` itself on a
 * pause/resume clock that never runs while the receipt can't be read.
 * Errors stay pinned until the user dismisses them, matching native
 * failure toasts.
 */
export const MUTATION_TOAST_DISMISS_MS = 10_000;

/**
 * Whether an `update`/`dismiss` rejection is the notification having been
 * dismissed rather than a delivery failure. Provider codes reach the plugin
 * as the leading segment of the bridged error message (`"code: detail"`);
 * `notification-expired` means the toast is already gone — overwhelmingly
 * user dismissal of the loading toast — so the adapter stays live and the
 * mutation's receipt returns to the inline row. Anything else is treated
 * as delivery loss and latches the adapter dead.
 */
export function isNotificationDismissal(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("notification-expired");
}

/**
 * What the receipt-dismiss clock reads: `seen()` reports whether the
 * receipt can actually be read right now — the view is shown and the
 * document is visible and focused, the native
 * ThreadToastVisibleAutoDismiss predicate — and `onChange` fires on every
 * transition so the accumulator can pause/resume.
 */
export interface ReceiptSeenSource {
  readonly seen: () => boolean;
  readonly onChange: (listener: () => void) => () => void;
  readonly signal: AbortSignal;
}

/**
 * `dismiss` after `windowMs` of *seen* time — a pause/resume accumulator
 * mirroring native ThreadToastVisibleAutoDismiss (toast.tsx). Hidden spans
 * pause the clock rather than expiring the receipt, so a success that
 * settled while its thread was inactive — or while the document was
 * backgrounded/unfocused — still gets its full readable window after the
 * user returns. The abort signal ends the watch without firing.
 */
export function dismissReceiptAfterSeen(
  source: ReceiptSeenSource,
  windowMs: number,
  dismiss: () => void,
): void {
  let remainingMs = windowMs;
  let startedAtMs: number | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let done = false;
  let off: () => void = () => {};

  const clearTimer = () => {
    if (timeoutId === null) return;
    clearTimeout(timeoutId);
    timeoutId = null;
  };
  const finish = () => {
    if (done) return;
    done = true;
    clearTimer();
    off();
    source.signal.removeEventListener("abort", onAbort);
    dismiss();
  };
  const pause = () => {
    if (startedAtMs === null) return;
    remainingMs = Math.max(0, remainingMs - (Date.now() - startedAtMs));
    startedAtMs = null;
    clearTimer();
  };
  const start = () => {
    if (done || startedAtMs !== null) return;
    if (remainingMs <= 0) {
      finish();
      return;
    }
    startedAtMs = Date.now();
    timeoutId = setTimeout(() => {
      startedAtMs = null;
      remainingMs = 0;
      finish();
    }, remainingMs);
  };
  const sync = () => {
    if (source.seen()) start();
    else pause();
  };
  const onAbort = () => {
    done = true;
    pause();
    off();
  };
  off = source.onChange(sync);
  source.signal.addEventListener("abort", onAbort, { once: true });
  sync();
}

export function mutationToastStart(label: string): {
  readonly severity: "loading";
  readonly title: string;
} {
  return { severity: "loading", title: `${label}…` };
}

/** The `update` patch for a settled mutation; failures split the named error into the body. */
export function mutationToastSettle(
  label: string,
  result: { readonly ok: boolean; readonly detail: string },
): {
  readonly severity: "success" | "error";
  readonly title: string;
  readonly body?: string;
} {
  return result.ok
    ? { severity: "success", title: result.detail }
    : { severity: "error", title: `${label} failed`, body: result.detail };
}

/**
 * A success receipt's follow-up button — native's toast CTA. Clicking it
 * re-enters the stacked runner with `action`, like native's
 * `runGitActionWithToast({ action })`.
 */
export interface MutationFollowUp {
  readonly label: string;
  readonly action: VcsActionKind;
}

/**
 * Native's post-commit CTA (GitManager `cta`): a created commit offers Push
 * with no further condition — whether the push can go through is the push
 * run's own answer, as it is natively.
 */
export const COMMIT_FOLLOW_UP: MutationFollowUp = { label: "Push", action: "push" };

/**
 * The server-decided CTA on a stacked result — the same `toast.cta` native
 * renders (Push after a commit, Create PR after a push). `open_pr` needs a
 * link-opening seam the plugin does not have, so it offers nothing.
 */
export function stackedFollowUp(result: VcsActionResult): MutationFollowUp | null {
  const cta = result.toast.cta;
  return cta.kind === "run_action" ? { label: cta.label, action: cta.action.kind } : null;
}

export const FOLLOW_UP_ACTION_ID = "follow-up";

/** The slice of `t3.ui/notifications` a follow-up receipt needs. */
export interface FollowUpNotifications {
  readonly notify: (input: {
    readonly severity: "success";
    readonly title: string;
    readonly actions: readonly {
      readonly id: string;
      readonly label: string;
      readonly variant: "primary";
    }[];
  }) => Promise<{ readonly notificationId: string }>;
  readonly dismiss: (notificationId: string) => Promise<void>;
  readonly awaitAction: (
    notificationId: string,
  ) => Promise<{ readonly actionId: string } | { readonly dismissed: true }>;
}

/**
 * Settles a loading toast into a receipt that carries a follow-up button.
 * `update` cannot add actions, so the receipt is a fresh `notify`; the
 * loading toast is retracted only once the receipt is fully armed, so any
 * failure — a rejected post, a throwing hook or `awaitAction`, or a loading
 * dismiss that did not land — retracts the receipt and leaves the caller
 * its in-place `update` path (resolves false). Never rejects. Resolves true
 * once the receipt alone is up; `run` fires if the user clicks its button.
 */
export async function postFollowUpReceipt(
  notifications: FollowUpNotifications,
  loadingId: string,
  detail: string,
  followUp: MutationFollowUp,
  hooks: {
    readonly onPosted: (receiptId: string) => void;
    readonly run: (action: VcsActionKind) => void;
  },
): Promise<boolean> {
  let receiptId: string;
  try {
    ({ notificationId: receiptId } = await notifications.notify({
      severity: "success",
      title: detail,
      actions: [{ id: FOLLOW_UP_ACTION_ID, label: followUp.label, variant: "primary" }],
    }));
  } catch {
    return false;
  }
  try {
    void notifications.awaitAction(receiptId).then(
      (outcome) => {
        if ("actionId" in outcome && outcome.actionId === FOLLOW_UP_ACTION_ID)
          hooks.run(followUp.action);
      },
      () => {},
    );
    hooks.onPosted(receiptId);
    // A user-dismissed loading toast is already gone — that is the goal.
    await notifications.dismiss(loadingId).catch((error: unknown) => {
      if (!isNotificationDismissal(error)) throw error;
    });
    return true;
  } catch {
    // Retract the receipt so the in-place update is the only outcome shown.
    try {
      await notifications.dismiss(receiptId);
    } catch {}
    return false;
  }
}
