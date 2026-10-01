/**
 * Pure view-model for the pull-request browser side of the Version
 * Control panel. Owns the read-side model the PR view renders over the
 * public `t3.prs/read` contract: the capability gate's named unavailable
 * states (cli-missing / cli-unauthenticated / provider-unsupported —
 * never an empty-looking success), list inputs and row text, detail
 * projections (checks, review threads, linked threads, stack), and the
 * `streamDiff` fold → sha256 verify → patch-parse pipeline.
 *
 * The diff stream runs the `t3.vcs/diff` frame family (manifest →
 * ordered chunks → complete); the fold and terminal verification mirror
 * the diff panel's `streamPreview` machinery — nothing reaches the
 * render path before the payload hash checks out. Patch parsing reuses
 * the same vendored `@pierre/diffs` `parsePatchFiles` the diff panel
 * feeds; this file keeps the patch-faithful row model only (full-file
 * context expansion waits on `streamDiffFileContents`, a named defer).
 *
 * Writes ride `t3.prs/write`: the write gate's probe result decides
 * which affordances exist (host-declared actions, merge methods,
 * verdicts, per-op support), and a grant the installation does not
 * hold surfaces as a named unavailability rather than a dead button.
 */
import type { FileDiffMetadata } from "@pierre/diffs/types";
import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { unquoteGitPatchPath } from "@t3tools/shared/gitPatchPath";
import type {
  PrsActor,
  PrsCapabilities,
  PrsFilesViewedResult,
  PrsFileViewedState,
  PrsCheck,
  PrsDiffStreamEvent,
  PrsListEntry,
  PrsListInput,
  PrsListResult,
  PrsOperationsSupport,
  PrsOmittedFileStat,
  PrsProviderSummary,
  PrsReviewThread,
  PrsStack,
  PrsStackMembership,
  PrsWriteActionInput,
  PrsWriteActionKind,
  PrsWriteCapabilitiesResult,
  PrsWriteMergeMethod,
  PrsWriteOperationsSupport,
  PrsWriteUpdateMethod,
  PrsWriteVerdict,
  VcsActionPrepareThreadResult,
  VcsRefEntry,
} from "@t3tools/extension-sdk/catalogue";

export function prsViewedFilesEnabled(
  store: PrsCapabilities["viewedFiles"],
  operations: PrsWriteOperationsSupport | null,
): boolean {
  return store !== undefined && operations?.["prs.setFilesViewed"] === true;
}

export function prsFileViewedStates(result: PrsFilesViewedResult | null) {
  return result === null ? null : new Map(result.files.map((file) => [file.path, file.state]));
}

export function prsFileViewed(
  path: string,
  states: ReadonlyMap<string, PrsFileViewedState> | null,
  overlay: ReadonlyMap<string, boolean>,
) {
  return {
    viewed: overlay.get(path) ?? states?.get(path) === "viewed",
    stale: !overlay.has(path) && states?.get(path) === "dismissed",
  };
}

export function prsSettleViewedOverlay(
  overlay: ReadonlyMap<string, boolean>,
  states: ReadonlyMap<string, PrsFileViewedState> | null,
  pending: ReadonlySet<string>,
  answered: ReadonlySet<string>,
): ReadonlyMap<string, boolean> {
  if (states === null || overlay.size === 0) return overlay;
  const next = new Map(overlay);
  for (const [path, viewed] of overlay) {
    if (!pending.has(path) && (answered.has(path) || (states.get(path) === "viewed") === viewed)) {
      next.delete(path);
    }
  }
  return next.size === overlay.size ? overlay : next;
}

export function prsRevertViewedOverlay(
  overlay: ReadonlyMap<string, boolean>,
  owned: ReadonlySet<string>,
): ReadonlyMap<string, boolean> {
  const next = new Map(overlay);
  for (const path of owned) next.delete(path);
  return next;
}

/* ---------------- capability gate ---------------- */

export type PrsUnavailableReason = "cli-missing" | "cli-unauthenticated" | "provider-unsupported";

export type PrsGate =
  | { readonly kind: "loading" }
  /** The `getCapabilities` invoke itself failed — grant denial or broker error, surfaced verbatim. */
  | { readonly kind: "error"; readonly detail: string }
  /** The probe answered a named unavailable state; `reason` is the contract's stable machine name. */
  | {
      readonly kind: "unavailable";
      readonly reason: PrsUnavailableReason;
      readonly detail: string | null;
      readonly providers: readonly PrsProviderSummary[];
    }
  | {
      readonly kind: "ready";
      readonly providers: readonly PrsProviderSummary[];
      readonly operations: PrsOperationsSupport;
    };

/**
 * The capability gate. A successful probe still names its failure —
 * `hosted:false` or a non-null reason means reads cannot run, and the
 * panel must say which one rather than render an empty list.
 */
export function prsGate(
  capabilities: {
    readonly hosted: boolean;
    readonly reason: PrsUnavailableReason | null;
    readonly detail: string | null;
    readonly providers: readonly PrsProviderSummary[];
    readonly operations: PrsOperationsSupport;
  } | null,
  error: string | null,
): PrsGate {
  if (error !== null) return { kind: "error", detail: error };
  if (capabilities === null) return { kind: "loading" };
  if (capabilities.hosted && capabilities.reason === null) {
    return {
      kind: "ready",
      providers: capabilities.providers,
      operations: capabilities.operations,
    };
  }
  return {
    kind: "unavailable",
    reason: capabilities.reason ?? "provider-unsupported",
    detail: capabilities.detail,
    providers: capabilities.providers,
  };
}

/** Headline text for a named unavailable state — the reason, not a euphemism. */
export function prsUnavailableLabel(reason: PrsUnavailableReason): string {
  switch (reason) {
    case "cli-missing":
      return "No host CLI found for this project's pull-request provider";
    case "cli-unauthenticated":
      return "The host CLI is not authenticated";
    case "provider-unsupported":
      return "No pull-request provider for this project's repository";
  }
}

/** One-line provider summary for the list header, e.g. "github.com · github". */
export function prsProviderLabel(provider: PrsProviderSummary): string {
  const state = provider.configured ? "configured" : "not configured";
  const detail = provider.detail !== null ? ` — ${provider.detail}` : "";
  return `${provider.host} · ${provider.kind} · ${state}${detail}`;
}

/* ---------------- list inputs ---------------- */

export type PrsListState = "all" | "open" | "closed" | "merged";
export const PRS_LIST_STATES: readonly { readonly value: PrsListState; readonly label: string }[] =
  [
    { value: "open", label: "Open" },
    { value: "merged", label: "Merged" },
    { value: "closed", label: "Closed" },
    { value: "all", label: "All" },
  ];

export type PrsInvolvement = "all" | "reviewing" | "authored";
export const PRS_INVOLVEMENTS: readonly {
  readonly value: PrsInvolvement;
  readonly label: string;
}[] = [
  { value: "all", label: "All" },
  { value: "reviewing", label: "Reviewing" },
  { value: "authored", label: "Authored" },
];

/** Contract maximum for a single list page. */
export const PRS_LIST_LIMIT = 50;

/**
 * The `prs.list` input for the current controls. Search goes to the host
 * verbatim (its own search semantics answer it); an empty query is
 * simply absent — the schema rejects `""`. `cursors` is the previous
 * page's `nextCursors` passed back unchanged for "load more".
 */
export function prsListInput(
  state: PrsListState,
  involvement: PrsInvolvement,
  query: string,
  cursors?: Readonly<Record<string, string>>,
): PrsListInput {
  const trimmed = query.trim();
  return {
    state,
    involvement,
    limit: PRS_LIST_LIMIT,
    ...(trimmed.length > 0 ? { query: trimmed.slice(0, 200) } : {}),
    ...(cursors !== undefined && Object.keys(cursors).length > 0 ? { cursors } : {}),
  };
}

/** Stable identity for a change request: host + repository + number. */
export function prsRefKey(ref: {
  readonly host?: string;
  readonly repository: string;
  readonly number: number;
}): string {
  return `${ref.host ?? ""}\n${ref.repository}\n${ref.number}`;
}

/**
 * Fold a freshly read page into the displayed entries: a re-read
 * replaces rows in place by identity (state transitions must not
 * duplicate a row), a continuation page appends. Ordering stays the
 * host's — the contract's answer is already the host's ranking.
 */
export function mergePrsEntries(
  existing: readonly PrsListEntry[],
  page: readonly PrsListEntry[],
): readonly PrsListEntry[] {
  const next = [...existing];
  const index = new Map(next.map((entry, i) => [prsRefKey(entry), i]));
  for (const entry of page) {
    const at = index.get(prsRefKey(entry));
    if (at === undefined) {
      index.set(prsRefKey(entry), next.length);
      next.push(entry);
    } else {
      next[at] = entry;
    }
  }
  return next;
}

/** `prs.list` may continue when the host issued cursors for the next page. */
export function prsListHasMore(result: PrsListResult | null): boolean {
  return result !== null && Object.keys(result.nextCursors).length > 0;
}

/* ---------------- list row text ---------------- */

export function prsStateLabel(entry: {
  readonly state: "open" | "closed" | "merged";
  readonly isDraft: boolean;
}): string {
  if (entry.state === "open" && entry.isDraft) return "Draft";
  switch (entry.state) {
    case "open":
      return "Open";
    case "merged":
      return "Merged";
    case "closed":
      return "Closed";
  }
}

export function prsReviewLabel(
  decision: "approved" | "changes-requested" | "review-required" | undefined,
): string | null {
  switch (decision) {
    case "approved":
      return "Approved";
    case "changes-requested":
      return "Changes requested";
    case "review-required":
      return "Review required";
    default:
      return null;
  }
}

export function prsChecksLabel(
  state: "passing" | "failing" | "pending" | undefined,
): string | null {
  switch (state) {
    case "passing":
      return "Checks passing";
    case "failing":
      return "Checks failing";
    case "pending":
      return "Checks pending";
    default:
      return null;
  }
}

export function prsStackLabel(stack: PrsStackMembership | undefined): string | null {
  if (stack === undefined) return null;
  return `Stack ${stack.position}/${stack.size} · ${stack.base}`;
}

export function prsActorLabel(actor: PrsActor | null | undefined): string {
  return actor?.name ?? actor?.login ?? "unknown";
}

/**
 * Whether the signed-in viewer authored this entry — `viewers` maps
 * host → login exactly as the contract delivers it.
 */
export function prsAuthoredByViewer(
  entry: Pick<PrsListEntry, "host" | "author">,
  viewers: Readonly<Record<string, string>>,
): boolean {
  const viewer = viewers[entry.host];
  return viewer !== undefined && entry.author?.login === viewer;
}

/** Compact "2m ago" / "3d ago" / absolute fallback for stale or future stamps. */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const delta = now - at;
  if (delta < 45_000) return "just now";
  if (delta < 0) return new Date(at).toLocaleDateString();
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(at).toLocaleDateString();
}

/** Secondary line under a PR row — repo#number · author · stats · recency. */
export function prsRowMeta(entry: PrsListEntry, now?: number): string {
  const parts = [
    `${entry.repository}#${entry.number}`,
    entry.author !== null ? prsActorLabel(entry.author) : null,
    entry.additions + entry.deletions > 0 ? `+${entry.additions} −${entry.deletions}` : null,
    formatRelativeTime(entry.updatedAt, now),
  ];
  return parts.filter((part) => part !== null).join(" · ");
}

/* ---------------- open on host ---------------- */

const OPEN_ON_HOST_LABELS: Readonly<Record<string, string>> = {
  github: "Open on GitHub",
  gitlab: "Open on GitLab",
  forgejo: "Open on Forgejo",
  bitbucket: "Open on Bitbucket",
  "azure-devops": "Open on Azure DevOps",
};

/** Named for the host rather than "externally": the point is where you will land. */
export function prsOpenOnHostLabel(provider: string): string {
  return OPEN_ON_HOST_LABELS[provider] ?? "Open on host";
}

/** The repository root behind a change-request URL (native `changeRequestRepositoryUrl`). */
export function prsRepositoryUrl(changeRequestUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(changeRequestUrl);
  } catch {
    return null;
  }
  const path =
    /^(.*?)\/-\/merge_requests\/\d+(?:\/|$)/iu.exec(url.pathname)?.[1] ??
    /^(.*?)(?:\/pulls?\/\d+|\/pull-requests\/\d+|\/pullrequest\/\d+)(?:\/|$)/iu.exec(
      url.pathname,
    )?.[1];
  if (!path) return null;
  url.pathname = path;
  url.search = "";
  url.hash = "";
  return url.toString();
}

const branchPath = (branch: string) => branch.split("/").map(encodeURIComponent).join("/");

/**
 * Where a head branch lives: the fork's repository when the change request
 * comes from one, the base repository otherwise.
 */
export function prsHeadRepositoryUrl(
  repositoryUrl: string | null,
  repository: string,
  headRepository: string | null | undefined,
): string | null {
  if (repositoryUrl === null || !headRepository || headRepository === repository)
    return repositoryUrl;
  return repositoryUrl.endsWith(`/${repository}`)
    ? `${repositoryUrl.slice(0, -repository.length)}${headRepository}`
    : null;
}

/** A branch's page on its host; null where the host's layout is not known. */
export function prsBranchUrl(
  provider: string,
  repositoryUrl: string | null,
  branch: string,
): string | null {
  if (repositoryUrl === null) return null;
  switch (provider) {
    case "github":
      return `${repositoryUrl}/tree/${branchPath(branch)}`;
    case "forgejo":
      return `${repositoryUrl}/src/branch/${branchPath(branch)}`;
    case "gitlab":
      return `${repositoryUrl}/-/tree/${branchPath(branch)}`;
    case "bitbucket":
      return `${repositoryUrl}/branch/${branchPath(branch)}`;
    case "azure-devops":
      return `${repositoryUrl}?version=GB${encodeURIComponent(branch)}`;
    default:
      return null;
  }
}

/** A commit's page on its host; null where the host's layout is not known. */
export function prsCommitUrl(
  provider: string,
  repositoryUrl: string | null,
  oid: string,
): string | null {
  if (repositoryUrl === null) return null;
  switch (provider) {
    case "github":
    case "forgejo":
    case "azure-devops":
      return `${repositoryUrl}/commit/${encodeURIComponent(oid)}`;
    case "gitlab":
      return `${repositoryUrl}/-/commit/${encodeURIComponent(oid)}`;
    case "bitbucket":
      return `${repositoryUrl}/commits/${encodeURIComponent(oid)}`;
    default:
      return null;
  }
}

/** A `t3.ui/external` refusal, said by its closed reason. */
export function prsOpenRefusedLabel(
  reason: "invalid-url" | "scheme-not-allowed" | "opener-refused",
): string {
  switch (reason) {
    case "invalid-url":
      return "Could not open the link — the host sent an invalid address.";
    case "scheme-not-allowed":
      return "Could not open the link — only http and https links open.";
    case "opener-refused":
      return "Could not open the link — the system refused it.";
  }
}

/* ---------------- checkout ---------------- */

export type PrsCheckoutMode = "worktree" | "local";

/**
 * Native's checkout menu. The worktree option says "and thread" only where the
 * host runs the checkout as a handoff (`t3.vcs/actions#handoffPullRequest`),
 * which opens that thread; a host without it only prepares the folder.
 */
export function prsCheckoutOptions(handoff: boolean): readonly {
  readonly mode: PrsCheckoutMode;
  readonly label: string;
  readonly description: string;
}[] {
  return [
    {
      mode: "worktree",
      label: "In a separate worktree",
      description: handoff
        ? "Its own folder and thread. Nothing you have open moves."
        : "Its own folder. Nothing you have open moves.",
    },
    {
      mode: "local",
      label: "In this repository",
      description: "Switches the branch you are working in, like `gh pr checkout`.",
    },
  ];
}

export function prsCheckoutLabel(pending: boolean): string {
  return pending ? "Checking out..." : "Check out";
}

export interface PrsReceipt {
  readonly tone: "success" | "warning" | "error";
  readonly title: string;
  readonly description: string | null;
}

const STALE_CHECKOUT_RECEIPT: PrsReceipt = {
  tone: "warning",
  title: "Checked out, but the latest commits are unconfirmed",
  description:
    "The pull request's latest commits could not be confirmed or applied here, so this checkout may be behind the pull request.",
};

/** Native's checkout toasts as one receipt: where it landed, stale, or the host's own refusal. */
export function prsCheckoutReceipt(
  mode: PrsCheckoutMode,
  outcome:
    | { readonly ok: true; readonly value: VcsActionPrepareThreadResult }
    | { readonly ok: false; readonly detail: string | null },
): PrsReceipt {
  if (!outcome.ok)
    return {
      tone: "error",
      title: "Could not prepare the pull request checkout",
      description: outcome.detail,
    };
  if (!outcome.value.isOnPullRequestHead) return STALE_CHECKOUT_RECEIPT;
  return mode === "local" || outcome.value.worktreePath === null
    ? {
        tone: "success",
        title: "Checked out here",
        description: "This repository is on the pull request's branch.",
      }
    : {
        tone: "success",
        title: "Checked out",
        description: `The pull request is in its own worktree at ${outcome.value.worktreePath}.`,
      };
}

/* ---------------- host handoffs ---------------- */

/**
 * Native's Resolve conflicts button: on an open pull request that conflicts
 * with its base, reading "Preparing..." while its own handoff (`conflicts`)
 * runs and waiting while any other does.
 */
export function prsResolveConflictsControl(
  detail: {
    readonly state: "open" | "closed" | "merged";
    readonly mergeability?: "mergeable" | "conflicting" | "unknown";
  },
  handoff: string | null,
): { readonly visible: boolean; readonly label: string; readonly disabled: boolean } {
  return {
    visible: detail.state === "open" && detail.mergeability === "conflicting",
    label: handoff === "conflicts" ? "Preparing..." : "Resolve conflicts",
    disabled: handoff !== null,
  };
}

/* ---------------- detail projections ---------------- */

/**
 * Native's header branch chips: `base ← head` in mono, each name on hover,
 * the arrow named for screen readers. A stacked base says so on hover.
 */
export function prsBranchChips(
  detail: { readonly baseBranch: string; readonly headBranch: string },
  stacked: boolean,
) {
  return {
    base: {
      text: detail.baseBranch,
      tooltip: stacked ? `Stacked on ${detail.baseBranch}` : detail.baseBranch,
      stacked,
    },
    head: { text: detail.headBranch, tooltip: detail.headBranch },
    arrowLabel: "receives changes from",
  };
}

/**
 * Native's `isStackedPullRequestBase`: the base is stacked when it is not the
 * repository's default branch (a remote default drops its remote prefix).
 * No known default ref, no badge. Host stack membership is shown apart.
 */
export function prsStackedOnDefault(
  baseBranch: string,
  refs: readonly Pick<VcsRefEntry, "name" | "isDefault" | "isRemote" | "remoteName">[],
): boolean {
  const defaultRef = refs.find((ref) => ref.isDefault);
  if (defaultRef === undefined) return false;
  if (defaultRef.isRemote !== true) return defaultRef.name !== baseBranch;
  const remotePrefix = `${defaultRef.remoteName ?? defaultRef.name.split("/")[0]}/`;
  const defaultBranch = defaultRef.name.startsWith(remotePrefix)
    ? defaultRef.name.slice(remotePrefix.length)
    : defaultRef.name;
  return defaultBranch !== baseBranch;
}

export function prsMergeabilityLabel(
  mergeability: "mergeable" | "conflicting" | "unknown" | undefined,
): string {
  switch (mergeability) {
    case "mergeable":
      return "Mergeable";
    case "conflicting":
      return "Has conflicts";
    default:
      return "Mergeability unknown";
  }
}

export function prsCheckStatusLabel(status: PrsCheck["status"]): string {
  switch (status) {
    case "success":
      return "passing";
    case "failure":
      return "failing";
    case "pending":
      return "pending";
    case "action-required":
      return "action required";
    case "skipped":
      return "skipped";
    case "neutral":
      return "neutral";
    case "cancelled":
      return "cancelled";
  }
}

/** "3 passing · 1 failing · 1 pending" — null when the host reported no checks. */
export function prsChecksSummary(checks: readonly PrsCheck[]): string | null {
  if (checks.length === 0) return null;
  const counts = new Map<string, number>();
  for (const check of checks) {
    const label = prsCheckStatusLabel(check.status);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].map(([label, count]) => `${count} ${label}`).join(" · ");
}

/** Where a review thread sits: `path:12`, left-side lines named "(removed side)". */
export function prsThreadAnchor(thread: Pick<PrsReviewThread, "path" | "line" | "side">): string {
  const line = thread.line !== null ? `:${thread.line}` : "";
  const side = thread.side === "left" ? " (removed side)" : "";
  return `${thread.path}${line}${side}`;
}

export function prsThreadStateLabel(
  thread: Pick<PrsReviewThread, "isResolved" | "isOutdated">,
): string {
  if (thread.isResolved) return "Resolved";
  if (thread.isOutdated) return "Outdated";
  return "Open";
}

/** "N more comments" when a thread's first page was cut by the host. */
export function prsThreadMoreLabel(thread: PrsReviewThread): string | null {
  if (thread.nextCommentsCursor === undefined) return null;
  const rest =
    thread.commentCount !== undefined && thread.commentCount > thread.comments.length
      ? `${thread.commentCount - thread.comments.length} more comment${
          thread.commentCount - thread.comments.length === 1 ? "" : "s"
        }`
      : "more comments";
  return `Show ${rest}`;
}

export function prsReviewVerdictLabel(state: string | null): string | null {
  if (state === null) return null;
  const normalized = state.toLowerCase().replace(/_/g, " ");
  switch (normalized) {
    case "approved":
      return "approved";
    case "changes requested":
      return "requested changes";
    case "commented":
      return "reviewed";
    case "dismissed":
      return "dismissed a review";
    default:
      return normalized;
  }
}

/* ---------------- refreshes ---------------- */

/** `subscribeRefreshes` close reasons as user-facing text. */
export function prsRefreshClosedLabel(reason: "overflow" | "refresh-error"): string {
  return reason === "overflow"
    ? "Refresh stream overflowed — updates may be delayed"
    : "Refresh stream failed on the host";
}

/* ---------------- streamDiff: fold → verify ---------------- */

export interface StreamFrameLike<T> {
  readonly value: T;
}

type FoldResult<T> =
  | { readonly ok: true; readonly assembly: T }
  | { readonly ok: false; readonly detail: string };

export type StreamFailure =
  | { readonly kind: "protocol"; readonly detail: string }
  | { readonly kind: "incomplete"; readonly detail: string }
  | { readonly kind: "mismatch"; readonly detail: string }
  | { readonly kind: "cancelled" };

type PrsDiffManifest = Extract<PrsDiffStreamEvent, { readonly kind: "manifest" }>;

export interface PrsDiffAssembly {
  readonly manifest: PrsDiffManifest | null;
  readonly chunks: readonly string[];
  readonly complete: string | null;
}

export function createPrsDiffAssembly(): PrsDiffAssembly {
  return { manifest: null, chunks: [], complete: null };
}

/**
 * `streamDiff` fold — the single-diff member of the `t3.vcs/diff` frame
 * family: one manifest, chunks in strict `chunkIndex` order, a terminal
 * `payloadSha256`. Out-of-order, duplicated, or post-complete frames are
 * protocol errors; nothing is emitted until verification.
 */
export function applyPrsDiffStreamEvent(
  assembly: PrsDiffAssembly,
  event: PrsDiffStreamEvent,
): FoldResult<PrsDiffAssembly> {
  if (assembly.complete !== null) {
    return { ok: false, detail: "stream continued after the complete frame" };
  }
  if (event.kind === "manifest") {
    if (assembly.manifest !== null) return { ok: false, detail: "duplicate manifest frame" };
    return { ok: true, assembly: { manifest: event, chunks: [], complete: null } };
  }
  if (assembly.manifest === null) {
    return { ok: false, detail: `${event.kind} frame arrived before the manifest` };
  }
  if (event.kind === "chunk") {
    if (event.chunkIndex >= assembly.manifest.chunkCount) {
      return {
        ok: false,
        detail: `chunkIndex ${event.chunkIndex} exceeds declared chunkCount ${assembly.manifest.chunkCount}`,
      };
    }
    if (event.chunkIndex !== assembly.chunks.length) {
      return {
        ok: false,
        detail: `out-of-order chunk ${event.chunkIndex} (expected ${assembly.chunks.length})`,
      };
    }
    return { ok: true, assembly: { ...assembly, chunks: [...assembly.chunks, event.data] } };
  }
  return { ok: true, assembly: { ...assembly, complete: event.payloadSha256 } };
}

export type PrsDiffVerification =
  | { readonly kind: "verified"; readonly manifest: PrsDiffManifest; readonly patch: string }
  | StreamFailure;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Terminal verification, in the diff panel's order: declared chunk
 * count, reassembled UTF-8 byte length, then sha256 — checked against
 * both the manifest's `diffHash` and the terminal `payloadSha256`
 * (identical payloads for a single-diff stream) before one byte is
 * produced.
 */
export async function verifyPrsDiffAssembly(
  assembly: PrsDiffAssembly,
): Promise<PrsDiffVerification> {
  if (assembly.manifest === null) {
    return { kind: "incomplete", detail: "stream ended before the manifest" };
  }
  if (assembly.complete === null) {
    return { kind: "incomplete", detail: "stream ended before the complete frame" };
  }
  const manifest = assembly.manifest;
  if (assembly.chunks.length !== manifest.chunkCount) {
    return {
      kind: "incomplete",
      detail: `received ${assembly.chunks.length} of ${manifest.chunkCount} declared chunks`,
    };
  }
  const patch = assembly.chunks.join("");
  if (utf8Length(patch) !== manifest.diffByteLength) {
    return {
      kind: "mismatch",
      detail: "reassembled byte length does not match the manifest",
    };
  }
  const hash = await sha256Hex(patch);
  if (hash !== manifest.diffHash) {
    return { kind: "mismatch", detail: "reassembled bytes do not match the manifest hash" };
  }
  if (hash !== assembly.complete) {
    return {
      kind: "mismatch",
      detail: "reassembled payload does not match the terminal checksum",
    };
  }
  return { kind: "verified", manifest, patch };
}

/**
 * Consume a `streamDiff` iterable into a verified patch. The abort
 * signal is checked before every frame; leaving the loop abandons the
 * iterator — the contract's cancellation mechanism.
 */
export async function collectPrsDiffStream(
  stream: AsyncIterable<StreamFrameLike<PrsDiffStreamEvent>>,
  signal: AbortSignal,
): Promise<PrsDiffVerification> {
  let assembly = createPrsDiffAssembly();
  for await (const frame of stream) {
    if (signal.aborted) return { kind: "cancelled" };
    const next = applyPrsDiffStreamEvent(assembly, frame.value);
    if (!next.ok) return { kind: "protocol", detail: next.detail };
    assembly = next.assembly;
  }
  if (signal.aborted) return { kind: "cancelled" };
  return verifyPrsDiffAssembly(assembly);
}

/**
 * Accumulated, independently verified diff delivery. A truncated stream
 * resumes through `nextCursor` as a new stream whose own manifest and
 * checksums verify its own slice; the panel concatenates verified patch
 * text only — a segment that fails verification contributes nothing.
 */
export interface PrsDiffDelivery {
  readonly patch: string;
  /** Per-segment content hashes — the first segment's hash is the diff's identity. */
  readonly diffHashes: readonly string[];
  /** Last manifest's truncation state: true while more of the diff remains unread. */
  readonly truncated: boolean;
  /** Host-issued resume point for the next segment; null at the diff's end. */
  readonly nextCursor: string | null;
  /** Files the host omitted from the delivered diff (union across segments). */
  readonly omittedFileStats: readonly PrsOmittedFileStat[];
  readonly byteLength: number;
}

export function mergePrsDiffSegment(
  delivery: PrsDiffDelivery | null,
  manifest: PrsDiffManifest,
  patch: string,
): PrsDiffDelivery {
  const omitted = manifest.omittedFileStats ?? [];
  return {
    patch: (delivery?.patch ?? "") + patch,
    diffHashes: [...(delivery?.diffHashes ?? []), manifest.diffHash],
    truncated: manifest.truncated,
    nextCursor: manifest.nextCursor,
    omittedFileStats: [...(delivery?.omittedFileStats ?? []), ...omitted],
    byteLength: (delivery?.byteLength ?? 0) + manifest.diffByteLength,
  };
}

export function prsOmittedFilesLabel(stats: readonly PrsOmittedFileStat[]): string {
  const files = stats.length;
  if (files === 0) return "";
  const additions = stats.reduce((n, s) => n + s.additions, 0);
  const deletions = stats.reduce((n, s) => n + s.deletions, 0);
  return `${files} file${files === 1 ? "" : "s"} omitted from the delivered diff (+${additions} −${deletions})`;
}

/* ---------------- patch → renderable ---------------- */

/** Unquote parser paths without stripping real directories; mirrors native fileDiffPath. */
export function resolveDiffPath(raw: string): string {
  return unquoteGitPatchPath(raw);
}

const DIFF_GIT_BOUNDARY = /^diff --git /gm;
const BINARY_FILES_MARKER = /^Binary files .+ differ$/m;
const GIT_BINARY_MARKER = /^GIT binary patch$/m;
const BINARY_B_PATH = /^Binary files .+ and ("b\/.*"|b\/.+) differ$/m;
const HEADER_B_PATH_QUOTED = /^diff --git "a\/(?:.*)" ("b\/.*")$/;
const HEADER_B_PATH = /^diff --git a\/.* (b\/.*)$/;

/** Paths the delivered patch marks binary — the literal marker, never inferred. */
export function binaryPathsFromPatch(diff: string): ReadonlySet<string> {
  const paths = new Set<string>();
  const boundaries = [...diff.matchAll(DIFF_GIT_BOUNDARY)].map((match) => match.index);
  for (let index = 0; index < boundaries.length; index += 1) {
    const start = boundaries[index];
    const end = index + 1 < boundaries.length ? boundaries[index + 1] : diff.length;
    const section = diff.slice(start, end);
    if (BINARY_FILES_MARKER.test(section)) {
      const path = BINARY_B_PATH.exec(section)?.[1];
      if (path !== undefined) paths.add(resolveDiffPath(path).slice(2));
    } else if (GIT_BINARY_MARKER.test(section)) {
      const header = section.split("\n", 1)[0] ?? "";
      const path =
        HEADER_B_PATH_QUOTED.exec(header)?.[1] ?? HEADER_B_PATH.exec(header)?.[1] ?? null;
      if (path !== null) paths.add(resolveDiffPath(path).slice(2));
    }
  }
  return paths;
}

export type DiffChangeType = FileDiffMetadata["type"];

export interface DiffFileRow {
  /** Stable key for selection: prev + new path (renames differ on both). */
  readonly key: string;
  readonly path: string;
  readonly prevPath: string | null;
  readonly changeType: DiffChangeType;
  readonly additions: number;
  readonly deletions: number;
  /** Literal binary marker in the patch — no fake text patch is rendered. */
  readonly binary: boolean;
  /** Parsed but carrying no text hunks (mode-only change, or a truncated tail). */
  readonly textless: boolean;
  readonly file: FileDiffMetadata;
}

function rowFromFile(file: FileDiffMetadata, binaryPaths: ReadonlySet<string>): DiffFileRow {
  const path = resolveDiffPath(file.name ?? file.prevName ?? "");
  const prevPath = file.prevName !== undefined ? resolveDiffPath(file.prevName) : null;
  let additions = 0;
  let deletions = 0;
  for (const hunk of file.hunks) {
    additions += hunk.additionLines;
    deletions += hunk.deletionLines;
  }
  const binary = binaryPaths.has(path) || (prevPath !== null && binaryPaths.has(prevPath));
  return {
    key: `${prevPath ?? ""} ${path}`,
    path,
    prevPath,
    changeType: file.type,
    additions,
    deletions,
    binary,
    textless: file.hunks.length === 0 && !binary,
    file,
  };
}

export type RenderableDiff =
  | { readonly kind: "files"; readonly files: readonly DiffFileRow[] }
  | { readonly kind: "raw"; readonly text: string; readonly reason: string };

/**
 * Parse the verified patch into file rows; the honest `raw` fallback
 * carries a reason when the delivered text is not a parseable patch.
 */
export function renderableFromPatch(diff: string | null | undefined): RenderableDiff | null {
  if (diff === null || diff === undefined) return null;
  const normalized = diff.trim();
  if (normalized.length === 0) return null;
  try {
    const files = parsePatchFiles(normalized, patchCacheKey(normalized)).flatMap(
      (patch) => patch.files,
    );
    if (files.length > 0) {
      const binaryPaths = binaryPathsFromPatch(normalized);
      return { kind: "files", files: files.map((file) => rowFromFile(file, binaryPaths)) };
    }
    return {
      kind: "raw",
      text: normalized,
      reason: "Unsupported diff format. Showing raw patch.",
    };
  } catch {
    return {
      kind: "raw",
      text: normalized,
      reason: "Failed to parse patch. Showing raw patch.",
    };
  }
}

function patchCacheKey(patch: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < patch.length; index += 1) {
    hash ^= patch.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `t3.prs.diff:${patch.length}:${hash.toString(36)}`;
}

export type DiffDisplayRow = { readonly ordinal: number } & (
  | {
      readonly kind: "context";
      readonly text: string;
      readonly oldLine: number;
      readonly newLine: number;
    }
  | { readonly kind: "addition"; readonly text: string; readonly newLine: number }
  | { readonly kind: "deletion"; readonly text: string; readonly oldLine: number }
  /** Unmodified region the patch elided: `count` lines, named rather than painted. */
  | { readonly kind: "gap"; readonly count: number }
);

function lineText(lines: readonly string[], index: number): string {
  return (lines[index] ?? "").replace(/\r?\n$/, "");
}

/**
 * Patch-faithful display rows for one file — exactly the hunks the patch
 * carries, with each `collapsedBefore` region named as a gap row.
 * Full-file context expansion is the deferred
 * `streamDiffFileContents` slice: the contract exists, this panel does
 * not yet consume it, and no gap row pretends to be expandable.
 */
export function fileRows(row: DiffFileRow): readonly DiffDisplayRow[] {
  const file = row.file;
  if (file.hunks.length === 0) return [];
  const additionLines = file.additionLines;
  const deletionLines = file.deletionLines;

  const rows: DiffDisplayRow[] = [];
  for (const hunk of file.hunks) {
    if (hunk.collapsedBefore > 0) {
      rows.push({ ordinal: rows.length, kind: "gap", count: hunk.collapsedBefore });
    }
    let additionIndex = hunk.additionLineIndex;
    let deletionIndex = hunk.deletionLineIndex;
    let newLine = hunk.additionStart;
    let oldLine = hunk.deletionStart;
    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        for (let offset = 0; offset < content.lines; offset += 1) {
          rows.push({
            ordinal: rows.length,
            kind: "context",
            text: lineText(additionLines, additionIndex + offset),
            oldLine: oldLine + offset,
            newLine: newLine + offset,
          });
        }
        additionIndex += content.lines;
        deletionIndex += content.lines;
        oldLine += content.lines;
        newLine += content.lines;
      } else {
        for (let offset = 0; offset < content.deletions; offset += 1) {
          rows.push({
            ordinal: rows.length,
            kind: "deletion",
            text: lineText(deletionLines, deletionIndex + offset),
            oldLine: oldLine + offset,
          });
        }
        deletionIndex += content.deletions;
        oldLine += content.deletions;
        for (let offset = 0; offset < content.additions; offset += 1) {
          rows.push({
            ordinal: rows.length,
            kind: "addition",
            text: lineText(additionLines, additionIndex + offset),
            newLine: newLine + offset,
          });
        }
        additionIndex += content.additions;
        newLine += content.additions;
      }
    }
  }
  return rows;
}

export function changeTypeLabel(changeType: DiffChangeType): string {
  switch (changeType) {
    case "new":
      return "added";
    case "deleted":
      return "deleted";
    case "rename-pure":
      return "renamed";
    case "rename-changed":
      return "renamed, modified";
    case "change":
      return "modified";
  }
}

/** Display path for a row: `old → new` for renames, `new` otherwise. */
export function displayPath(row: DiffFileRow): string {
  return row.prevPath !== null ? `${row.prevPath} → ${row.path}` : row.path;
}

/** Per-file stat text, e.g. "+12 −4"; binary and textless rows carry no counts. */
export function fileStatLabel(row: DiffFileRow): string {
  if (row.binary || row.textless) return "";
  return `+${row.additions} −${row.deletions}`;
}

/* ---------------- writes (t3.prs/write) ---------------- */

export type PrsWriteGate =
  | { readonly kind: "loading" }
  /** The `getCapabilities` invoke itself failed — grant denial or broker error, surfaced verbatim. */
  | { readonly kind: "error"; readonly detail: string }
  /** The probe answered a named unavailable state. */
  | {
      readonly kind: "unavailable";
      readonly reason: PrsUnavailableReason;
      readonly detail: string | null;
    }
  | {
      readonly kind: "ready";
      readonly operations: PrsWriteOperationsSupport;
      readonly actions: readonly PrsWriteActionKind[];
      readonly mergeMethods: readonly PrsWriteMergeMethod[];
      readonly updateMethods: readonly PrsWriteUpdateMethod[];
      readonly verdicts: readonly PrsWriteVerdict[];
    };

/**
 * The write gate, run against `t3.prs/write`'s own probe. A grant the
 * installation does not hold fails the invoke outright — the error kind
 * carries the denial verbatim rather than implying support.
 */
export function prsWriteGate(
  capabilities: PrsWriteCapabilitiesResult | null,
  error: string | null,
): PrsWriteGate {
  if (error !== null) return { kind: "error", detail: error };
  if (capabilities === null) return { kind: "loading" };
  if (capabilities.hosted && capabilities.reason === null) {
    return {
      kind: "ready",
      operations: capabilities.operations,
      actions: capabilities.actions,
      mergeMethods: capabilities.mergeMethods,
      updateMethods: capabilities.updateMethods,
      verdicts: capabilities.verdicts,
    };
  }
  return {
    kind: "unavailable",
    reason: capabilities.reason ?? "provider-unsupported",
    detail: capabilities.detail,
  };
}

/** Button text for a host action — the native panel's own verbs. */
export function prsWriteActionLabel(action: PrsWriteActionKind): string {
  switch (action) {
    case "merge":
      return "Merge";
    case "ready":
      return "Ready for review";
    case "draft":
      return "Convert to draft";
    case "close":
      return "Close";
    case "reopen":
      return "Reopen";
    case "update-branch":
      return "Update branch";
    case "enable-auto-merge":
      return "Enable auto-merge";
    case "disable-auto-merge":
      return "Disable auto-merge";
    case "revert":
      return "Revert";
    case "approve-workflows":
      return "Approve workflows";
  }
}

const PRS_MERGE_METHOD_LABELS: Readonly<Record<string, string>> = {
  merge: "Merge",
  squash: "Squash and merge",
  rebase: "Rebase and merge",
};

/** How one header action reads: native's words where native draws it. */
export interface PrsActionPresentation {
  /** Visible text, and so the accessible name. */
  readonly label: string;
  /** Native's tooltip, or null where native's action has none. */
  readonly tooltip: string | null;
  /** Native keeps the tooltip hoverable while a pending write disables the action. */
  readonly hoverWhileDisabled: boolean;
}

/**
 * Native header wording for `action` given its selected merge method and
 * the action whose write is in flight, if any. Only the running action
 * shows its pending words; the rest keep theirs while disabled. Actions
 * native keeps in a plain menu get no tooltip.
 */
export function prsActionPresentation(
  action: PrsWriteActionKind,
  method: string,
  pendingAction: string | null,
): PrsActionPresentation {
  const running = pendingAction === action;
  const native = (label: string): PrsActionPresentation => ({
    label,
    tooltip: label,
    hoverWhileDisabled: true,
  });
  switch (action) {
    case "ready":
      return native("Ready for review");
    case "merge":
      return native(running ? "Merging..." : (PRS_MERGE_METHOD_LABELS[method] ?? "Merge"));
    case "enable-auto-merge": {
      const methodLabel = PRS_MERGE_METHOD_LABELS[method];
      return native(
        running
          ? "Enabling..."
          : methodLabel === undefined
            ? "Auto-merge"
            : `Auto-merge (${methodLabel.toLowerCase()})`,
      );
    }
    case "approve-workflows":
      return native(running ? "Approving..." : "Approve workflows to run");
    default: {
      const label = prsWriteActionLabel(action);
      return { label: running ? `${label}…` : label, tooltip: null, hoverWhileDisabled: false };
    }
  }
}

/** Native's badge help once auto-merge is armed, naming the method when known. */
export function prsArmedAutoMergeTooltip(method: string | null | undefined): string {
  const methodLabel = method == null ? undefined : PRS_MERGE_METHOD_LABELS[method];
  const armed =
    methodLabel === undefined ? "Auto-merge" : `Auto-merge (${methodLabel.toLowerCase()})`;
  return `${armed}: the host will merge this on its own once its requirements are met`;
}

/** Native's aggregate checks help. */
export function prsChecksTooltip(
  state: "passing" | "failing" | "pending" | null | undefined,
): string | null {
  switch (state) {
    case "passing":
      return "All checks have passed";
    case "failing":
      return "Some checks were not successful";
    case "pending":
      return "Some checks haven't completed yet";
    default:
      return null;
  }
}

export type PrsChecksState = "passing" | "failing" | "pending";

/**
 * The checks glyph native draws on a row and in the detail header: one
 * icon per rollup, its accessible name and tooltip native's headline.
 * Null where the host reported no rollup — no tick nobody earned.
 */
export function prsChecksIcon(state: PrsChecksState | null | undefined): {
  readonly glyph: string;
  readonly label: string;
  readonly tone: "success" | "destructive" | "warning";
} | null {
  switch (state) {
    case "passing":
      return { glyph: "✓", label: "All checks have passed", tone: "success" };
    case "failing":
      return { glyph: "✕", label: "Some checks were not successful", tone: "destructive" };
    case "pending":
      return { glyph: "●", label: "Some checks haven't completed yet", tone: "warning" };
    default:
      return null;
  }
}

/** A detail's checks rolled up as the list row's field would be (native `pullRequestChecksState`). */
export function prsChecksStateFromChecks(
  checks: readonly Pick<PrsCheck, "status">[],
): PrsChecksState | null {
  if (checks.length === 0) return null;
  const statuses = new Set(checks.map((check) => check.status));
  if (statuses.has("failure") || statuses.has("cancelled")) return "failing";
  if (statuses.has("pending") || statuses.has("action-required")) return "pending";
  return statuses.has("success") ? "passing" : null;
}

/**
 * One dated read of a pull request: the detail, or its list row. `observedAt`
 * is the host's read-start time (`t3.prs/read@1.1.0`), `receivedAt` the
 * client's arrival time for that successful read.
 */
export interface PrsSnapshotStamp {
  readonly state: "open" | "closed" | "merged";
  readonly updatedAt: string;
  readonly observedAt?: number;
  readonly receivedAt: number;
}

/**
 * Positive when `incoming` is newer than `current`, as native orders pull
 * request snapshots: merged is final, then the host's update time, then its
 * read-start time (a snapshot without one never beats a stamped read), and
 * only when neither carries one, the client's arrival time.
 */
export function prsCompareSnapshots(current: PrsSnapshotStamp, incoming: PrsSnapshotStamp): number {
  const merged = Number(incoming.state === "merged") - Number(current.state === "merged");
  if (merged !== 0) return merged;
  const updated = Date.parse(incoming.updatedAt) - Date.parse(current.updatedAt);
  if (updated !== 0) return updated;
  if (current.observedAt === undefined && incoming.observedAt === undefined)
    return incoming.receivedAt - current.receivedAt;
  return (incoming.observedAt ?? -Infinity) - (current.observedAt ?? -Infinity);
}

/**
 * The header's checks rollup, reconciled as native's is: the list row's
 * rollup wins only when that row is the newer snapshot (ties go to the row,
 * as native's do), except that a run awaiting approval keeps it pending
 * unless something failed (list rollups can omit those runs). `stale` says
 * the detail's own checks no longer back the rollup.
 */
export function prsReconcileChecks(
  checks: readonly Pick<PrsCheck, "status">[],
  detail: PrsSnapshotStamp,
  entry: (PrsSnapshotStamp & { readonly checksState?: PrsChecksState }) | undefined,
): { readonly state: PrsChecksState | null; readonly stale: boolean } {
  const detailState = prsChecksStateFromChecks(checks);
  const latest =
    entry?.checksState !== undefined && prsCompareSnapshots(detail, entry) >= 0
      ? entry.checksState
      : detailState;
  const state =
    latest !== "failing" && checks.some((check) => check.status === "action-required")
      ? "pending"
      : latest;
  return { state, stale: state !== detailState };
}

/**
 * Native's stack-membership help. List membership only ever comes from the
 * host's own stack graph (GitHub stacks), never a base-branch chain, so this
 * is native's `kind === "native"` wording.
 */
export function prsStackTooltip(stack: PrsStackMembership | undefined): string | null {
  if (stack === undefined) return null;
  return `GitHub stack of ${stack.size}: merging a layer lands the ones below it.`;
}

/** Native's review-decision help. */
export function prsReviewTooltip(
  decision: "approved" | "changes-requested" | "review-required" | null | undefined,
): string | null {
  switch (decision) {
    case "approved":
      return "Approved";
    case "changes-requested":
      return "Changes requested";
    case "review-required":
      return "Awaiting review";
    default:
      return null;
  }
}

/** Native's conflict help, or null when the change request merges cleanly or is unknown. */
export function prsConflictTooltip(detail: {
  readonly mergeability?: "mergeable" | "conflicting" | "unknown";
  readonly baseBranch: string;
}): string | null {
  if (detail.mergeability !== "conflicting") return null;
  return detail.baseBranch ? `Conflicts with ${detail.baseBranch}` : "Has conflicts";
}

/** Native's author help: the display name with the login, or the login alone. */
export function prsActorTooltip(actor: PrsActor | null | undefined): string | null {
  if (!actor) return null;
  return actor.name && actor.name !== actor.login ? `${actor.name} (@${actor.login})` : actor.login;
}

/** Native's check help: the full description, else the name. */
export function prsCheckTooltip(check: Pick<PrsCheck, "name" | "description">): string {
  return check.description ?? check.name;
}

export interface PrsWriteActionOffer {
  readonly action: PrsWriteActionKind;
  readonly label: string;
  /** `merge` and `enable-auto-merge` pick among the host's declared methods when it has more than one. */
  readonly methods?: readonly PrsWriteMergeMethod[];
  /** `update-branch` picks among the host's declared methods when it has more than one. */
  readonly updateMethods?: readonly PrsWriteUpdateMethod[];
  /** Close/revert are destructive-direction writes — drawn apart from the rest. */
  readonly destructive: boolean;
}

/**
 * Native's `allowsSinglePullRequestMerge`: a host with stack actions must
 * finish stack discovery before offering a single-PR merge or auto-merge,
 * since on a stack layer that would merge the layer alone into its base.
 */
export function prsSingleMergeAllowed(input: {
  readonly supportsStackActions: boolean;
  readonly hasStack: boolean;
  readonly stackPending: boolean;
  readonly stackError: string | null;
}): boolean {
  return (
    !input.supportsStackActions ||
    (!input.hasStack && !input.stackPending && input.stackError === null)
  );
}

/**
 * The actions bar for a loaded detail: state decides which writes are
 * even sensible (a closed change request has no merge to offer), then the
 * host's declared `actions` intersects that set — nothing is drawn that
 * the provider did not claim, which is the native panel's own rule.
 * Merging and arming auto-merge follow native eligibility: never on a
 * draft or conflicting change request, only with a method the repository
 * allows, and only once stack discovery allows a single merge. Disarming
 * an armed auto-merge is always offered.
 */
export function prsWriteActionOffers(
  detail: {
    readonly state: "open" | "closed" | "merged";
    readonly isDraft: boolean;
    readonly mergeability?: "mergeable" | "conflicting" | "unknown";
    readonly mergeCapabilities?: Readonly<Record<PrsWriteMergeMethod, boolean>>;
    readonly baseComparison?: "ahead" | "behind" | "diverged" | "up-to-date" | string;
    readonly autoMergeEnabled?: boolean;
    readonly workflowApprovalsRequired?: number;
  },
  write: {
    readonly actions: readonly PrsWriteActionKind[];
    readonly mergeMethods: readonly PrsWriteMergeMethod[];
    readonly updateMethods: readonly PrsWriteUpdateMethod[];
  },
  options: { readonly singleMergeAllowed?: boolean } = {},
): readonly PrsWriteActionOffer[] {
  const declared = new Set(write.actions);
  const offer = (
    action: PrsWriteActionKind,
    extra?: Partial<Pick<PrsWriteActionOffer, "methods" | "updateMethods">>,
  ): PrsWriteActionOffer | null =>
    declared.has(action)
      ? {
          action,
          label: prsWriteActionLabel(action),
          destructive: action === "close" || action === "revert",
          ...(extra?.methods !== undefined ? { methods: extra.methods } : {}),
          ...(extra?.updateMethods !== undefined ? { updateMethods: extra.updateMethods } : {}),
        }
      : null;
  const mergeCapabilities = detail.mergeCapabilities;
  const mergeMethods =
    mergeCapabilities === undefined
      ? write.mergeMethods
      : write.mergeMethods.filter((method) => mergeCapabilities[method]);
  const canMerge =
    !detail.isDraft &&
    detail.mergeability !== "conflicting" &&
    mergeMethods.length > 0 &&
    options.singleMergeAllowed !== false;
  const offers: PrsWriteActionOffer[] = [];
  if (detail.state === "open") {
    if (!detail.isDraft) {
      const merge = canMerge ? offer("merge", { methods: mergeMethods }) : null;
      if (merge !== null) offers.push(merge);
      const draft = offer("draft");
      if (draft !== null) offers.push(draft);
    } else {
      const ready = offer("ready");
      if (ready !== null) offers.push(ready);
    }
    if (detail.baseComparison === "behind" || detail.baseComparison === "diverged") {
      const update = offer("update-branch", { updateMethods: write.updateMethods });
      if (update !== null) offers.push(update);
    }
    if (detail.autoMergeEnabled === true) {
      const disarm = offer("disable-auto-merge");
      if (disarm !== null) offers.push(disarm);
    } else if (detail.autoMergeEnabled === false && canMerge) {
      const arm = offer("enable-auto-merge", { methods: mergeMethods });
      if (arm !== null) offers.push(arm);
    }
    const close = offer("close");
    if (close !== null) offers.push(close);
    if ((detail.workflowApprovalsRequired ?? 0) > 0) {
      const approve = offer("approve-workflows");
      if (approve !== null) offers.push(approve);
    }
  } else if (detail.state === "closed") {
    const reopen = offer("reopen");
    if (reopen !== null) offers.push(reopen);
  } else {
    const revert = offer("revert");
    if (revert !== null) offers.push(revert);
  }
  return offers;
}

/* ---------------- stack merge ---------------- */

/** The strategies the host offers, narrowed to the ones the repository allows (native order). */
export function prsAllowedMergeMethods(detail: {
  readonly capabilities: { readonly mergeMethods: readonly PrsWriteMergeMethod[] };
  readonly mergeCapabilities: Readonly<Record<PrsWriteMergeMethod, boolean>>;
}): readonly PrsWriteMergeMethod[] {
  return detail.capabilities.mergeMethods.filter((method) => detail.mergeCapabilities[method]);
}

/**
 * Native's `resolvePullRequestMergeMethod`: the method picked for this change
 * request, else the project's setting, else the last method picked, each only
 * if the repository allows it; else the first allowed.
 */
export function prsResolveMergeMethod(
  allowed: readonly PrsWriteMergeMethod[],
  current: string | null,
  projectDefault: PrsWriteMergeMethod | undefined,
  lastSelected: string | null,
): PrsWriteMergeMethod {
  for (const method of [current, projectDefault, lastSelected]) {
    const match = allowed.find((candidate) => candidate === method);
    if (match !== undefined) return match;
  }
  return allowed[0] ?? "merge";
}

/**
 * Native's `canMerge` for the stack menu: the host does stacks and stack
 * actions, both the host and this viewer may merge, the repository allows a
 * method, and the write probe declares the action.
 */
export function prsCanMergeStack(
  detail: {
    readonly capabilities: {
      readonly actions: readonly string[];
      readonly mergeMethods: readonly PrsWriteMergeMethod[];
      readonly stacks?: boolean;
      readonly stackActions?: boolean;
    };
    readonly viewerPermissions: { readonly actions: readonly string[] };
    readonly mergeCapabilities: Readonly<Record<PrsWriteMergeMethod, boolean>>;
  },
  write: {
    readonly operations: { readonly "prs.runAction": boolean };
    readonly actions: readonly PrsWriteActionKind[];
  },
): boolean {
  return (
    detail.capabilities.stacks === true &&
    detail.capabilities.stackActions === true &&
    detail.capabilities.actions.includes("merge") &&
    detail.viewerPermissions.actions.includes("merge") &&
    prsAllowedMergeMethods(detail).length > 0 &&
    write.operations["prs.runAction"] &&
    write.actions.includes("merge")
  );
}

/**
 * Native's Merge stack (PullRequestStackMenu): this layer and every
 * unmerged layer below it, each pinned to the head the reader saw so a
 * moved branch fails rather than merges unseen code.
 */
export function prsStackMergePlan(stack: PrsStack, number: number, mergeMethod: string) {
  const position = stack.layers.findIndex((layer) => layer.number === number) + 1;
  const selected = position > 0 ? stack.layers[position - 1] : undefined;
  const layers = stack.layers.slice(0, position).filter((layer) => layer.state !== "merged");
  const unready = layers.some((layer) => layer.state !== "open" || layer.isDraft === true);
  const count = layers.length;
  const input: Omit<PrsWriteActionInput, "repository" | "host"> = {
    number,
    action: "merge",
    mergeMethod: mergeMethod as PrsWriteMergeMethod,
    stackNumber: stack.number,
    expectedStackHeads: layers.flatMap((layer) =>
      layer.headSha ? [{ number: layer.number, headSha: layer.headSha }] : [],
    ),
  };
  return {
    visible: selected?.state === "open",
    disabled:
      selected?.state !== "open" ||
      count === 0 ||
      unready ||
      layers.some((layer) => !layer.headSha),
    layers,
    input,
    label: "Merge stack",
    tooltip: `Merge stack through #${number} into ${stack.base} (${count} ${
      count === 1 ? "pull request" : "pull requests"
    })`,
    confirmTitle: `Merge ${count} pull requests?`,
    confirmDescription: `Merge #${number} and its unmerged layers below into ${stack.base} using ${mergeMethod}. GitHub checks their rules before merging or queueing them and rebases the remaining stack after merging.`,
    blockedNote: unready ? "Every layer being merged must be open and ready for review." : null,
  };
}

/** Native's stack-merge toasts as a receipt. */
export function prsStackMergeReceipt(
  outcome: { readonly ok: true } | { readonly ok: false; readonly detail: string | null },
): PrsReceipt {
  return outcome.ok
    ? {
        tone: "success",
        title: "Stack merge request completed",
        description: "GitHub merged the stack or added it to its merge queue.",
      }
    : { tone: "error", title: "Stack operation did not complete", description: outcome.detail };
}

/**
 * Native's `canRebase` for the stack menu: the host does stack actions, this
 * viewer may rebase the stack, and the write probe declares `update-branch`.
 */
export function prsCanRebaseStack(
  detail: {
    readonly capabilities: { readonly stacks?: boolean; readonly stackActions?: boolean };
    readonly viewerPermissions: { readonly stackRebase?: boolean };
  },
  write: {
    readonly operations: { readonly "prs.runAction": boolean };
    readonly actions: readonly PrsWriteActionKind[];
  },
): boolean {
  return (
    detail.capabilities.stacks === true &&
    detail.capabilities.stackActions === true &&
    detail.viewerPermissions.stackRebase === true &&
    write.operations["prs.runAction"] &&
    write.actions.includes("update-branch")
  );
}

/**
 * Native's Rebase stack (PullRequestStackMenu): every unmerged layer, bottom
 * to top onto the stack base, requested through the top layer with each head
 * pinned. A closed layer or a head the host did not report disables it.
 */
export function prsStackRebasePlan(stack: PrsStack) {
  const layers = stack.layers.filter((layer) => layer.state !== "merged");
  const top = stack.layers.at(-1);
  const count = layers.length;
  const input: Omit<PrsWriteActionInput, "repository" | "host"> = {
    number: top?.number ?? 0,
    action: "update-branch",
    updateMethod: "rebase",
    stackNumber: stack.number,
    expectedStackHeads: layers.flatMap((layer) =>
      layer.headSha ? [{ number: layer.number, headSha: layer.headSha }] : [],
    ),
  };
  return {
    disabled:
      count === 0 ||
      top === undefined ||
      layers.some((layer) => layer.state !== "open" || !layer.headSha),
    layers,
    input,
    label: "Rebase stack",
    confirmTitle: `Rebase ${count} pull requests?`,
    confirmDescription: `Rebase the remote branches from bottom to top onto ${stack.base}. This rewrites branch history and may restart checks. If a layer fails, earlier updates remain.`,
  };
}

/** Native's stack-rebase toasts as a receipt. */
export function prsStackRebaseReceipt(
  outcome: { readonly ok: true } | { readonly ok: false; readonly detail: string | null },
): PrsReceipt {
  return outcome.ok
    ? { tone: "success", title: "Stack rebased", description: null }
    : { tone: "error", title: "Stack operation did not complete", description: outcome.detail };
}

/** Review verdicts the host accepts, as picker options in the native order. */
export function prsWriteVerdictOptions(
  verdicts: readonly PrsWriteVerdict[],
): readonly { readonly value: PrsWriteVerdict; readonly label: string }[] {
  const order: readonly PrsWriteVerdict[] = ["comment", "approve", "request-changes"];
  const labels: Record<PrsWriteVerdict, string> = {
    comment: "Comment",
    approve: "Approve",
    "request-changes": "Request changes",
  };
  return order
    .filter((verdict) => verdicts.includes(verdict))
    .map((verdict) => ({ value: verdict, label: labels[verdict] }));
}

/**
 * The effective verdict for the review composer. The selection lives in
 * the draft store so a refresh remount cannot downgrade it — a stored
 * value the host still declares wins; anything else (unset, or a verdict
 * the provider no longer lists) falls back to the first declared option.
 */
export function prsReviewVerdict(
  draft: string,
  verdicts: readonly { readonly value: PrsWriteVerdict }[],
): PrsWriteVerdict {
  return verdicts.some((option) => option.value === draft)
    ? (draft as PrsWriteVerdict)
    : (verdicts[0]?.value ?? "comment");
}

/** Shown where write controls would stand when the write probe failed. */
export function prsWriteUnavailableNote(gate: PrsWriteGate): string | null {
  if (gate.kind === "loading") return "Reading write capabilities…";
  if (gate.kind === "error") return `Pull-request writes unavailable — ${gate.detail}`;
  if (gate.kind === "unavailable") {
    const base =
      gate.reason === "cli-missing"
        ? "Pull-request writes need a host CLI that is not installed"
        : gate.reason === "cli-unauthenticated"
          ? "Pull-request writes need an authenticated host CLI"
          : "This project's host cannot take pull-request writes";
    return gate.detail !== null ? `${base} — ${gate.detail}` : base;
  }
  return null;
}

/**
 * Composer drafts keyed by `${prsRefKey}:${writeKey}` — the panel owns
 * them so a refresh reprobe (which unmounts the ready subtree while the
 * capability hooks re-read) cannot take the author's words with it.
 */
export function prsDraftKey(prKey: string | null, writeKey: string): string {
  return `${prKey ?? "-"}\n${writeKey}`;
}

/**
 * Settle a submitted draft: drop it only when it is still exactly what
 * was submitted. Text typed while the request was in flight is newer
 * work and survives the success.
 */
export function settlePrsDraft(
  drafts: Readonly<Record<string, string>>,
  key: string,
  submitted: string,
): Readonly<Record<string, string>> {
  if ((drafts[key] ?? "") !== submitted) return drafts;
  const next = { ...drafts };
  delete next[key];
  return next;
}

export const PRS_DIFF_CONTENTS_DEFERRED =
  "Full-file context expansion is deferred — streamDiffFileContents is not consumed by this panel yet.";
