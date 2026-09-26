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
import type {
  PrsActor,
  PrsCheck,
  PrsDiffStreamEvent,
  PrsListEntry,
  PrsListInput,
  PrsListResult,
  PrsOperationsSupport,
  PrsOmittedFileStat,
  PrsProviderSummary,
  PrsReviewThread,
  PrsStackMembership,
  PrsWriteActionKind,
  PrsWriteCapabilitiesResult,
  PrsWriteMergeMethod,
  PrsWriteOperationsSupport,
  PrsWriteUpdateMethod,
  PrsWriteVerdict,
} from "@t3tools/extension-sdk/catalogue";

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

/* ---------------- detail projections ---------------- */

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

/** Strip the renderer prefix git applies (`a/` `b/`). */
export function resolveDiffPath(raw: string): string {
  if (raw.startsWith("a/") || raw.startsWith("b/")) return raw.slice(2);
  return raw;
}

const DIFF_GIT_BOUNDARY = /^diff --git /gm;
const BINARY_FILES_MARKER = /^Binary files .+ differ$/m;
const GIT_BINARY_MARKER = /^GIT binary patch$/m;
const BINARY_B_PATH = /^Binary files .+ and b\/(.+) differ$/m;
const HEADER_B_PATH_QUOTED = /^diff --git "a\/(?:.*)" "b\/(.*)"$/;
const HEADER_B_PATH = /^diff --git a\/.* b\/(.*)$/;

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
      if (path !== undefined) paths.add(path);
    } else if (GIT_BINARY_MARKER.test(section)) {
      const header = section.split("\n", 1)[0] ?? "";
      const path =
        HEADER_B_PATH_QUOTED.exec(header)?.[1] ?? HEADER_B_PATH.exec(header)?.[1] ?? null;
      if (path !== null) paths.add(path);
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
      return "Mark ready for review";
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

export interface PrsWriteActionOffer {
  readonly action: PrsWriteActionKind;
  readonly label: string;
  /** `merge` picks among the host's declared methods when it has more than one. */
  readonly methods?: readonly PrsWriteMergeMethod[];
  /** `update-branch` picks among the host's declared methods when it has more than one. */
  readonly updateMethods?: readonly PrsWriteUpdateMethod[];
  /** Close/revert are destructive-direction writes — drawn apart from the rest. */
  readonly destructive: boolean;
}

/**
 * The actions bar for a loaded detail: state decides which writes are
 * even sensible (a closed change request has no merge to offer), then the
 * host's declared `actions` intersects that set — nothing is drawn that
 * the provider did not claim, which is the native panel's own rule.
 */
export function prsWriteActionOffers(
  detail: {
    readonly state: "open" | "closed" | "merged";
    readonly isDraft: boolean;
    readonly baseComparison?: "ahead" | "behind" | "diverged" | "up-to-date" | string;
    readonly autoMergeEnabled?: boolean;
    readonly workflowApprovalsRequired?: number;
  },
  write: {
    readonly actions: readonly PrsWriteActionKind[];
    readonly mergeMethods: readonly PrsWriteMergeMethod[];
    readonly updateMethods: readonly PrsWriteUpdateMethod[];
  },
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
  const offers: PrsWriteActionOffer[] = [];
  if (detail.state === "open") {
    if (!detail.isDraft) {
      const merge = offer("merge", { methods: write.mergeMethods });
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
    } else if (detail.autoMergeEnabled === false) {
      const arm = offer("enable-auto-merge");
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
