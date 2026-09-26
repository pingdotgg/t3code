import { isWorkspaceImagePreviewPath } from "@t3tools/shared/filePreview";
import {
  uiThemeApi,
  type WorkspaceResourceReadEvent,
  type WorkspaceResourceReason,
} from "@t3tools/extension-sdk/catalogue";
import { bindApi, bindStreamApi, type ApiClient } from "@t3tools/extension-sdk/capabilities";
import type { ViewContext } from "@t3tools/extension-sdk/contracts";

/**
 * Pure view-model for the Files tree panel. Owns the panel-local
 * behavior: ordering, expansion state, and name filtering over the flat entry
 * list the `t3.workspace/tree` snapshot delivers.
 */

export interface TreeEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
}

export interface TreeRow {
  readonly entry: TreeEntry;
  readonly depth: number;
  readonly expandable: boolean;
}

export function parentPath(path: string): string | null {
  const index = path.lastIndexOf("/");
  return index === -1 ? null : path.slice(0, index);
}

/**
 * Depth-first order with directories before files at every level: each path
 * segment is ranked by that entry's kind so a directory's whole subtree sorts
 * before the sibling files that follow it.
 */
function sortKey(entry: TreeEntry): string {
  const segments = entry.path.split("/");
  return segments
    .map((segment, index) => {
      const rank = index === segments.length - 1 && entry.kind === "file" ? "1" : "0";
      return rank + segment;
    })
    .join("/");
}

export function compareTreeEntries(left: TreeEntry, right: TreeEntry): number {
  const a = sortKey(left);
  const b = sortKey(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortTreeEntries(entries: readonly TreeEntry[]): TreeEntry[] {
  return entries.toSorted(compareTreeEntries);
}

export function toggleExpanded(expanded: ReadonlySet<string>, directoryPath: string): Set<string> {
  const next = new Set(expanded);
  if (next.has(directoryPath)) next.delete(directoryPath);
  else next.add(directoryPath);
  return next;
}

/**
 * Entries matching a case-insensitive substring of the path, plus every
 * ancestor directory needed to render them as a tree.
 */
export function filterEntries(entries: readonly TreeEntry[], query: string): Set<string> {
  const needle = query.trim().toLowerCase();
  const keep = new Set<string>();
  if (!needle) return keep;
  for (const entry of entries) {
    if (!entry.path.toLowerCase().includes(needle)) continue;
    keep.add(entry.path);
    let ancestor = parentPath(entry.path);
    while (ancestor !== null) {
      keep.add(ancestor);
      ancestor = parentPath(ancestor);
    }
  }
  return keep;
}

/**
 * Flat rows in render order. An entry is visible when every ancestor
 * directory is expanded; while a filter is active, expansion is ignored and
 * only matching rows (plus their ancestors) appear.
 */
export function visibleRows(
  entries: readonly TreeEntry[],
  expanded: ReadonlySet<string>,
  query = "",
): TreeRow[] {
  const keep = query.trim() ? filterEntries(entries, query) : null;
  const rows: TreeRow[] = [];
  for (const entry of sortTreeEntries(entries)) {
    if (keep !== null && !keep.has(entry.path)) continue;
    let depth = 0;
    let hidden = false;
    let ancestor = parentPath(entry.path);
    while (ancestor !== null) {
      depth += 1;
      if (keep === null && !expanded.has(ancestor)) hidden = true;
      ancestor = parentPath(ancestor);
    }
    if (!hidden) rows.push({ entry, depth, expandable: entry.kind === "directory" });
  }
  return rows;
}

/** How the preview pane treats a selected path. */
export type PreviewKind = "text" | "image" | "video" | "audio" | "font" | "binary";

const PREVIEW_KIND_BY_EXTENSION: Readonly<Record<string, PreviewKind>> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  avif: "image",
  svg: "image",
  ico: "image",
  bmp: "image",
  mp4: "video",
  webm: "video",
  mov: "video",
  m4v: "video",
  mp3: "audio",
  wav: "audio",
  ogg: "audio",
  flac: "audio",
  m4a: "audio",
  woff: "font",
  woff2: "font",
  ttf: "font",
  otf: "font",
  pdf: "binary",
  zip: "binary",
  gz: "binary",
  tar: "binary",
  wasm: "binary",
  bin: "binary",
  dat: "binary",
  exe: "binary",
  dylib: "binary",
  so: "binary",
};

/** Extension-based classification; unknown extensions preview as text. */
export function previewKind(relativePath: string): PreviewKind {
  const name = relativePath.split("/").at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "text";
  return PREVIEW_KIND_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? "text";
}

/** The public text-read contract result, minus the path the caller already knows. */
export interface PreviewRead {
  readonly contents: string;
  readonly byteLength: number;
  readonly truncated: boolean;
}

export interface PreviewStatus {
  readonly status: string;
  readonly shownByteLength: number;
  readonly truncated: boolean;
}

const textEncoder = new TextEncoder();

/**
 * Honest truncation state for the preview pane. `byteLength` is the
 * file's true size from the contract; `shownByteLength` is the UTF-8 length of
 * what was actually returned, so a truncated preview never claims to show the
 * whole file and never conflates char count with bytes.
 */
export function describeRead(read: PreviewRead): PreviewStatus {
  const shownByteLength = textEncoder.encode(read.contents).byteLength;
  if (read.truncated)
    return {
      status: `File truncated — showing first ${shownByteLength.toLocaleString("en-US")} of ${read.byteLength.toLocaleString("en-US")} bytes (read only)`,
      shownByteLength,
      truncated: true,
    };
  return {
    status: `File loaded — ${read.byteLength.toLocaleString("en-US")} bytes (read only)`,
    shownByteLength,
    truncated: false,
  };
}

/**
 * Named state for kinds the workspace media lease cannot mint. The
 * host's mint gate only accepts the image-preview and browser-document
 * extension sets, so video, audio, fonts and other binaries are honest gaps,
 * not fetch-and-hope previews.
 */
export function mediaPreviewNotice(kind: PreviewKind): string {
  return `${kind} preview is not available — the workspace media lease does not mint this file type`;
}

/* ------------------------------------------------------------------------
 * Media lease preview: `t3.resources/lease` mints a signed
 * `/api/assets/<token>/<name>` URL (1h TTL, token-is-the-auth at serve) that
 * the view renders document-relative. Every transition below is a pure
 * function so renewal timing and denial mapping are testable with an
 * injected clock.
 * --------------------------------------------------------------------- */

/** What the view renders for a minted lease: `<img>` or the document viewer. */
export type MediaLeasePreviewMode = "image" | "document";

/**
 * What a `workspace-file` lease can render for a path — the SAME predicate
 * the host enforces at mint (`isWorkspacePreviewEntryPath`): image-preview
 * extensions mint `workspace-file-exact` claims for `<img>`; `.pdf` mints a
 * `workspace-file` claim served as application/pdf for the built-in document
 * viewer. `.htm`/`.html` stay on the text path (`previewKind` classifies them
 * as source) — browser-document preview is t3.browser's lane. `null` is a
 * named gap; minting it would fail `AssetPreviewTypeValidationError` anyway.
 */
export function leasePreviewMode(relativePath: string): MediaLeasePreviewMode | null {
  if (isWorkspaceImagePreviewPath(relativePath)) return "image";
  if (relativePath.toLowerCase().endsWith(".pdf")) return "document";
  return null;
}

/** Mint-time denials the adapter names in ExtensionOperationError detail. */
export type MediaLeaseDenialReason =
  | "grant-denied"
  | "kind-denied"
  | "not-previewable"
  | "outside-workspace"
  | "context-missing";

export type MediaLeaseState =
  | { readonly status: "idle" }
  | { readonly status: "unsupported-kind"; readonly message: string }
  | { readonly status: "minting"; readonly url?: string; readonly expiresAt?: number }
  | {
      readonly status: "ready";
      readonly url: string;
      readonly expiresAt: number;
      /** A renewal mint failed while the current lease still serves. */
      readonly renewalError?: string;
    }
  | { readonly status: "expired"; readonly url: string }
  | {
      readonly status: "denied";
      readonly reason: MediaLeaseDenialReason;
      readonly message: string;
    }
  | { readonly status: "unavailable"; readonly message: string };

/** Re-mint this far before `expiresAt` so the rendered URL never lapses. */
export const MEDIA_LEASE_RENEWAL_SKEW_MS = 5 * 60_000;
/** Floor on the renewal delay — a short-TTL lease must not spin a mint loop. */
export const MEDIA_LEASE_MIN_RENEWAL_DELAY_MS = 30_000;

/**
 * What selecting a workspace path does to the preview. `hasThread` is the
 * `workspace-file` resource's thread scope — the contract has no
 * project-scope variant, so its absence is a named denial, not an invented
 * ref.
 */
export function selectMediaLease(input: {
  readonly path: string;
  readonly hasThread: boolean;
}): MediaLeaseState {
  if (leasePreviewMode(input.path) === null)
    return { status: "unsupported-kind", message: mediaPreviewNotice(previewKind(input.path)) };
  if (!input.hasThread)
    return {
      status: "denied",
      reason: "context-missing",
      message:
        "Media preview requires a thread-scoped context — this view was opened for a project only",
    };
  return { status: "minting" };
}

/**
 * Capability gate after `getCapabilities`: null means `workspace-file` is
 * mintable here; otherwise the named unsupported state — an absent kind is
 * never a fetch-and-hope mint.
 */
export function mediaLeaseKindGate(supportedKinds: readonly string[]): MediaLeaseState | null {
  return supportedKinds.includes("workspace-file")
    ? null
    : {
        status: "unsupported-kind",
        message:
          "Media preview is not available — this server build cannot mint workspace-file leases",
      };
}

export function mediaLeaseMinted(result: {
  readonly url: string;
  readonly expiresAt: number;
}): MediaLeaseState {
  return { status: "ready", url: result.url, expiresAt: result.expiresAt };
}

const LEASE_DENIALS: ReadonlyArray<{
  readonly name: string;
  readonly reason: MediaLeaseDenialReason;
  readonly message: string;
}> = [
  {
    name: "ResourceLeaseGrantDeniedError",
    reason: "grant-denied",
    message: "Media preview denied — the installation is missing the t3.workspace/resources grant",
  },
  {
    name: "ResourceLeaseKindDeniedError",
    reason: "kind-denied",
    message: "Media preview denied — this resource kind is not mintable on this server",
  },
  {
    name: "AssetPreviewTypeValidationError",
    reason: "not-previewable",
    message: "Media preview denied — this file type is not previewable through the workspace lease",
  },
  {
    name: "AssetWorkspacePathValidationError",
    reason: "outside-workspace",
    message: "Media preview denied — the path resolves outside the granted workspace",
  },
  {
    name: "AssetWorkspaceAssetNotFoundError",
    reason: "context-missing",
    message: "Media preview unavailable — the file no longer exists in the workspace",
  },
];

const LEASE_CONTEXT_ERRORS = new Set([
  "AssetWorkspaceContextNotFoundError",
  "AssetWorkspaceContextResolutionError",
  "AssetWorkspaceRootNormalizationError",
]);

/**
 * Mint failure → named state. Every denial the adapter names stays a `denied`
 * with its reason; an unnamed or host-side failure (including
 * `ResourceLeaseGrantCheckError`, a grant evaluation fault) is `unavailable`,
 * never coerced into a denial it isn't.
 */
export function mediaLeaseErrorState(
  error: unknown,
): Extract<MediaLeaseState, { readonly status: "denied" | "unavailable" }> {
  const text = error instanceof Error ? error.message : String(error);
  for (const denial of LEASE_DENIALS)
    if (text.includes(denial.name))
      return { status: "denied", reason: denial.reason, message: denial.message };
  for (const name of LEASE_CONTEXT_ERRORS)
    if (text.includes(name))
      return {
        status: "denied",
        reason: "context-missing",
        message: "Media preview unavailable — the workspace context could not be resolved",
      };
  return {
    status: "unavailable",
    message: `Media preview failed${text ? `: ${text.slice(0, 300)}` : ""}`,
  };
}

/**
 * A mint result failure. While a previous lease still serves (renewal in
 * flight), keep it rendered with the failure named — the signed token is
 * valid until `expiresAt` regardless of why the re-mint failed.
 */
export function mediaLeaseFailed(error: unknown, previous?: MediaLeaseState): MediaLeaseState {
  const mapped = mediaLeaseErrorState(error);
  if (
    previous?.status === "minting" &&
    previous.url !== undefined &&
    previous.expiresAt !== undefined
  )
    return {
      status: "ready",
      url: previous.url,
      expiresAt: previous.expiresAt,
      renewalError: mapped.message,
    };
  return mapped;
}

/**
 * Milliseconds until a live lease should be re-minted: `expiresAt` minus the
 * skew, floored at `MEDIA_LEASE_MIN_RENEWAL_DELAY_MS` so a mint returning an
 * already-due expiry (short-TTL host build, skewed clock) cannot spin an
 * unbounded tight mint loop.
 */
export function mediaLeaseRenewalDelay(expiresAt: number, now: number): number {
  return Math.max(MEDIA_LEASE_MIN_RENEWAL_DELAY_MS, expiresAt - MEDIA_LEASE_RENEWAL_SKEW_MS - now);
}

/** Renewal starts: the current URL keeps rendering while the re-mint runs. */
export function mediaLeaseRenewing(state: MediaLeaseState): MediaLeaseState {
  return state.status === "ready"
    ? { status: "minting", url: state.url, expiresAt: state.expiresAt }
    : state;
}

/**
 * A rendered `<img>`/document load failure. Past `expiresAt` the token simply
 * stopped serving — `expired` triggers a re-mint. Before expiry the fetch
 * failed for another reason (the file moved, the view is remote to the
 * environment, or the URL otherwise did not resolve on this origin) — named,
 * never a broken image.
 */
export function mediaLeaseAssetFailed(state: MediaLeaseState, now: number): MediaLeaseState {
  if (state.status !== "ready") return state;
  if (now >= state.expiresAt) return { status: "expired", url: state.url };
  return {
    status: "unavailable",
    message:
      "Preview could not be loaded — the minted URL did not resolve on this origin (the file may have moved, or this view is remote to the environment)",
  };
}

/** A live lease reaching its TTL with no landed renewal: go expired. */
export function mediaLeaseExpire(state: MediaLeaseState): MediaLeaseState {
  return state.status === "ready" ? { status: "expired", url: state.url } : state;
}

/**
 * The URL a media element should render: a live lease, or the previous one
 * while its renewal mint is in flight. `expired`, denials and failures carry
 * no renderable URL — the named state is the UI, never a broken element.
 */
export function mediaLeaseUrl(state: MediaLeaseState): string | null {
  if (state.status === "ready") return state.url;
  if (state.status === "minting") return state.url ?? null;
  return null;
}

const leaseTime = (expiresAt: number) =>
  new Date(expiresAt).toLocaleTimeString("en-US", { hour12: false });

/** Status line for the media preview pane. */
export function describeMediaLease(state: MediaLeaseState): string {
  switch (state.status) {
    case "idle":
      return "";
    case "unsupported-kind":
      return state.message;
    case "minting":
      return state.url === undefined
        ? "Preparing preview — minting a media lease"
        : "Preview shown — renewing the media lease";
    case "ready":
      return state.renewalError === undefined
        ? `Preview ready — lease renews automatically (expires ${leaseTime(state.expiresAt)})`
        : `Preview shown — renewal failed (${state.renewalError}); the current lease expires ${leaseTime(state.expiresAt)}`;
    case "expired":
      return "Preview lease expired — renewing";
    case "denied":
      return state.message;
    case "unavailable":
      return state.message;
  }
}

/**
 * Editor: the `t3.workspace/text-edits@1.1.0` snapshot result
 * mapped onto the panel's editing surface. The 24000-byte bound is an API
 * checkpoint; `oversized` names the deferred full-size-editing blocker (#19)
 * instead of pretending a truncated read is editable.
 */
export type SnapshotReason =
  | "not-found"
  | "not-regular-file"
  | "binary"
  | "invalid-utf8"
  | "oversized"
  | "outside-workspace"
  | "unsafe-path"
  | "changed-during-read"
  | "io-error";

export interface SnapshotRead {
  readonly kind: "editable" | "not-editable";
  readonly contents?: string;
  readonly revision?: string;
  readonly reason?: SnapshotReason;
}

export type EditorOpen =
  | { readonly editable: true; readonly contents: string; readonly revision: string }
  | { readonly editable: false; readonly reason: SnapshotReason; readonly message: string };

const WORKSPACE_RESOURCE_MAX_BYTES = 8 * 1024 * 1024;

const REASON_MESSAGES: Readonly<Record<SnapshotReason, string>> = {
  "not-found": "File does not exist in this workspace",
  "not-regular-file": "Not a regular file — only regular files can be edited",
  binary: "Binary file — editing is not supported",
  "invalid-utf8": "File is not valid UTF-8 — editing is not supported",
  oversized: `File exceeds the ${WORKSPACE_RESOURCE_MAX_BYTES.toLocaleString("en-US")}-byte workspace resource bound — read only`,
  "outside-workspace": "Path is outside the workspace",
  "unsafe-path": "Path is not a safe workspace-relative path",
  "changed-during-read": "File changed while it was being read — try again",
  "io-error": "File could not be read",
};

/**
 * Snapshot → editor state. Editable snapshots carry the contents and the
 * revision saves compare against; everything else is read-only with the
 * contract's named reason — never silent truncation of user edits.
 */
export function describeSnapshot(read: SnapshotRead): EditorOpen {
  if (read.kind === "editable" && typeof read.contents === "string" && read.revision)
    return { editable: true, contents: read.contents, revision: read.revision };
  const reason: SnapshotReason = read.reason ?? "io-error";
  return { editable: false, reason, message: REASON_MESSAGES[reason] };
}

export type SaveStateKind = "clean" | "dirty" | "saving" | "saved" | "conflict" | "error";

/**
 * Whether the coordinator holds local work a remote refresh must not
 * clobber — the plugin-side form of the native panel's `selectedFilePending`
 * gate. `conflict` is the latched case; `dirty`/`saving`/`error` are the same
 * "unresolved local edits" pending.
 */
export function editorSavePending(kind: SaveStateKind): boolean {
  return kind === "dirty" || kind === "saving" || kind === "conflict" || kind === "error";
}

/**
 * Mutation-refresh gate for `t3.workspace/changes`, mirroring the native
 * `useWorkspaceMutationRefresh` handled-token semantics: a seq different from
 * the handled one fires exactly one refresh; while `enabled` is false the
 * bump stays unhandled, so it still fires when the latch opens.
 *
 * The first observed seq is NOT a baseline: any nonzero value may fold
 * mutations that landed before the view's initial reads completed, so it
 * must refresh once — the native hook likewise fires on the first non-null
 * token. `seq === 0` is the empty fold (native's null token) and never fires.
 */
export function shouldHandleMutation(input: {
  readonly enabled: boolean;
  readonly mutationSeq: number;
  readonly handledSeq: number | null;
}): boolean {
  return input.enabled && input.mutationSeq > 0 && input.mutationSeq !== input.handledSeq;
}

/** Status line for the coordinator's observable state. */
export function describeSaveState(state: {
  readonly kind: SaveStateKind;
  readonly message?: string;
}): string {
  switch (state.kind) {
    case "clean":
      return "No unsaved changes";
    case "dirty":
      return "Unsaved changes";
    case "saving":
      return "Saving";
    case "saved":
      return "Saved";
    case "conflict":
      return "File changed on disk — reload it or keep your version";
    case "error":
      return `Save failed${state.message ? `: ${state.message}` : ""} — your changes are kept`;
  }
}

/* ------------------------------------------------------------------------
 * Resource reads: fold + verify a `t3.workspace/resources`
 * `read` stream into contents the panel may render or an editor may open.
 * Single-source form of the diff panel's stream reassembly: a `manifest`
 * snapshot, strictly-ordered `chunk` data frames, a terminal `complete`
 * sha256 — or a sole `unavailable` frame naming the file-level failure.
 * Nothing reaches the caller before the terminal checksum verifies.
 * --------------------------------------------------------------------- */

export interface StreamFrameLike<T> {
  readonly value: T;
}

/** Terminal failure kinds a resource stream delivery can end in. */
export type StreamFailure =
  | { readonly kind: "protocol"; readonly detail: string }
  | { readonly kind: "incomplete"; readonly detail: string }
  | { readonly kind: "mismatch"; readonly detail: string }
  | { readonly kind: "cancelled" };

const SHA256_ROUND_CONSTANTS = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * Portable SHA-256 for contexts where `crypto.subtle` is missing — plain-http
 * LAN origins are not secure contexts, and remote-ready is a product
 * requirement, so digest verification must not depend on it.
 */
export function sha256HexPortable(bytes: Uint8Array): string {
  const state = Uint32Array.from([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const block = new Uint32Array(64);
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor((bytes.length * 8) / 0x1_0000_0000));
  view.setUint32(paddedLength - 4, (bytes.length * 8) >>> 0);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) block[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const a = block[index - 15]!;
      const b = block[index - 2]!;
      block[index] =
        (block[index - 16]! +
          (((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3)) +
          block[index - 7]! +
          (((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10))) >>>
        0;
    }
    let [a, b, c, d, e, f, g, h] = state as unknown as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    for (let index = 0; index < 64; index += 1) {
      const sum1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choose + SHA256_ROUND_CONSTANTS[index]! + block[index]!) >>> 0;
      const sum0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    state[0] = (state[0]! + a) >>> 0;
    state[1] = (state[1]! + b) >>> 0;
    state[2] = (state[2]! + c) >>> 0;
    state[3] = (state[3]! + d) >>> 0;
    state[4] = (state[4]! + e) >>> 0;
    state[5] = (state[5]! + f) >>> 0;
    state[6] = (state[6]! + g) >>> 0;
    state[7] = (state[7]! + h) >>> 0;
  }
  return [...state].map((word) => word.toString(16).padStart(8, "0")).join("");
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = textEncoder.encode(text);
  const subtle = globalThis.crypto?.subtle;
  if (subtle !== undefined) {
    const digest = await subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return sha256HexPortable(bytes);
}

export interface ResourceReadAssembly {
  readonly manifest: Extract<WorkspaceResourceReadEvent, { kind: "manifest" }> | null;
  readonly chunks: readonly string[];
  /** Terminal `complete` sha256, or null until it arrives. */
  readonly complete: string | null;
  /** Terminal file-level failure reason — legal only before the manifest. */
  readonly unavailable: WorkspaceResourceReason | null;
}

export function createResourceReadAssembly(): ResourceReadAssembly {
  return { manifest: null, chunks: [], complete: null, unavailable: null };
}

type ResourceFoldResult =
  | { readonly ok: true; readonly assembly: ResourceReadAssembly }
  | { readonly ok: false; readonly detail: string };

/**
 * Fold one `read` event. Frames must arrive manifest → ordered chunks →
 * complete, or be a sole `unavailable` first frame; out-of-order, duplicated
 * or post-terminal frames are protocol failures — accepting them would hide
 * transport breakage.
 */
export function applyResourceReadEvent(
  assembly: ResourceReadAssembly,
  event: WorkspaceResourceReadEvent,
): ResourceFoldResult {
  if (assembly.complete !== null || assembly.unavailable !== null)
    return { ok: false, detail: "stream continued after a terminal frame" };
  if (event.kind === "unavailable") {
    if (assembly.manifest !== null)
      return { ok: false, detail: "unavailable frame arrived after the manifest" };
    return { ok: true, assembly: { ...assembly, unavailable: event.reason } };
  }
  if (event.kind === "manifest") {
    if (assembly.manifest !== null) return { ok: false, detail: "duplicate manifest frame" };
    return { ok: true, assembly: { ...assembly, manifest: event } };
  }
  if (assembly.manifest === null)
    return { ok: false, detail: `${event.kind} frame arrived before the manifest` };
  if (event.kind === "chunk") {
    if (event.chunkIndex >= assembly.manifest.chunkCount)
      return {
        ok: false,
        detail: `chunkIndex ${event.chunkIndex} exceeds declared chunkCount ${assembly.manifest.chunkCount}`,
      };
    if (event.chunkIndex !== assembly.chunks.length)
      return {
        ok: false,
        detail: `out-of-order chunk ${event.chunkIndex} (expected ${assembly.chunks.length})`,
      };
    return { ok: true, assembly: { ...assembly, chunks: [...assembly.chunks, event.data] } };
  }
  return { ok: true, assembly: { ...assembly, complete: event.sha256 } };
}

export interface VerifiedResourceRead {
  readonly contents: string;
  readonly byteLength: number;
  readonly truncated: boolean;
  /**
   * File revision — the terminal digest over complete bytes. Null when the
   * delivery is a truncated prefix: the hash then covers the prefix only and
   * is not a saveable base revision.
   */
  readonly revision: string | null;
}

export type ResourceReadVerification =
  | { readonly kind: "verified"; readonly read: VerifiedResourceRead }
  | { readonly kind: "unavailable"; readonly reason: WorkspaceResourceReason }
  | StreamFailure;

/**
 * Terminal verification: declared chunk count, reassembled UTF-8 byte length
 * against the manifest's `deliveredByteLength`, then the terminal sha256 — in
 * that order, before a single byte reaches the caller. A non-truncated
 * manifest must also account for the full on-disk byte length.
 */
export async function verifyResourceReadAssembly(
  assembly: ResourceReadAssembly,
): Promise<ResourceReadVerification> {
  if (assembly.unavailable !== null) return { kind: "unavailable", reason: assembly.unavailable };
  if (assembly.manifest === null)
    return { kind: "incomplete", detail: "stream ended before the manifest" };
  if (assembly.complete === null)
    return { kind: "incomplete", detail: "stream ended before the complete frame" };
  const manifest = assembly.manifest;
  if (assembly.chunks.length !== manifest.chunkCount)
    return {
      kind: "incomplete",
      detail: `received ${assembly.chunks.length} of ${manifest.chunkCount} declared chunks`,
    };
  const body = assembly.chunks.join("");
  if (textEncoder.encode(body).byteLength !== manifest.deliveredByteLength)
    return { kind: "mismatch", detail: "reassembled byte length does not match the manifest" };
  if ((await sha256Hex(body)) !== assembly.complete)
    return { kind: "mismatch", detail: "reassembled bytes do not match the terminal checksum" };
  if (!manifest.truncated && manifest.deliveredByteLength !== manifest.byteLength)
    return {
      kind: "mismatch",
      detail: "manifest claims a complete read but declared fewer delivered bytes",
    };
  return {
    kind: "verified",
    read: {
      contents: body,
      byteLength: manifest.byteLength,
      truncated: manifest.truncated,
      revision: manifest.truncated ? null : assembly.complete,
    },
  };
}

/**
 * Consume a `read` iterable into a verified resource read. The abort signal
 * is checked before every frame and leaving the loop abandons the iterator —
 * the contract's cancellation mechanism. Nothing is produced before the
 * terminal checksum verifies.
 */
export async function collectResourceRead(
  stream: AsyncIterable<StreamFrameLike<WorkspaceResourceReadEvent>>,
  signal: AbortSignal,
): Promise<ResourceReadVerification> {
  let assembly = createResourceReadAssembly();
  try {
    for await (const frame of stream) {
      if (signal.aborted) return { kind: "cancelled" };
      const next = applyResourceReadEvent(assembly, frame.value);
      if (!next.ok) return { kind: "protocol", detail: next.detail };
      assembly = next.assembly;
    }
  } catch (error) {
    if (signal.aborted) return { kind: "cancelled" };
    return {
      kind: "protocol",
      detail: error instanceof Error ? error.message : "Resource read stream failed",
    };
  }
  if (signal.aborted) return { kind: "cancelled" };
  try {
    return await verifyResourceReadAssembly(assembly);
  } catch (error) {
    return {
      kind: "mismatch",
      detail: error instanceof Error ? error.message : "Resource read verification failed",
    };
  }
}

/** Resource reasons that exist verbatim in the snapshot vocabulary. */
const SNAPSHOT_RESOURCE_REASONS: ReadonlySet<string> = new Set([
  "not-found",
  "not-regular-file",
  "binary",
  "invalid-utf8",
  "oversized",
  "outside-workspace",
  "unsafe-path",
  "changed-during-read",
  "io-error",
]);

function resourceSnapshotReason(reason: WorkspaceResourceReason): SnapshotReason {
  return SNAPSHOT_RESOURCE_REASONS.has(reason) ? (reason as SnapshotReason) : "io-error";
}

/**
 * A finished resource read → the same `EditorOpen` a text-edits snapshot
 * produces. Only a complete verified transfer is editable — a truncated
 * prefix is read-only `oversized` at the resource bound, and the upload-only
 * reasons a nonconforming host could emit degrade to `io-error`, never to an
 * editable buffer.
 */
export function describeResourceRead(
  read: Exclude<ResourceReadVerification, { readonly kind: "cancelled" }>,
): EditorOpen {
  if (read.kind === "verified") {
    if (read.read.revision !== null)
      return { editable: true, contents: read.read.contents, revision: read.read.revision };
    return { editable: false, reason: "oversized", message: REASON_MESSAGES.oversized };
  }
  if (read.kind === "unavailable") {
    const reason = resourceSnapshotReason(read.reason);
    return { editable: false, reason, message: REASON_MESSAGES[reason] };
  }
  return {
    editable: false,
    reason: "io-error",
    message: `File could not be read (${read.detail.slice(0, 200)})`,
  };
}

/**
 * A finished resource read → the read-only preview pane shape. Verified
 * deliveries keep the honest `describeRead` truncation status; unavailability
 * and stream failures are named states, never a blank preview.
 */
export function describeResourcePreview(
  read: Exclude<ResourceReadVerification, { readonly kind: "cancelled" }>,
): { contents: string; status: string; truncated: boolean } {
  if (read.kind === "verified") {
    const described = describeRead(read.read);
    return {
      contents: read.read.contents,
      status: described.status,
      truncated: described.truncated,
    };
  }
  if (read.kind === "unavailable") {
    const reason = resourceSnapshotReason(read.reason);
    return { contents: "", status: REASON_MESSAGES[reason], truncated: false };
  }
  return {
    contents: "",
    status: `File could not be read (${read.detail.slice(0, 200)})`,
    truncated: false,
  };
}

/** Kind selector values for the `t3.workspace/search` contract call. */
export type SearchKindFilter = "all" | "file" | "directory";

/** The public search-contract result mapped onto the panel's entry shape. */
export interface SearchResults {
  readonly entries: readonly TreeEntry[];
  readonly truncated: boolean;
}

/**
 * Honest status for a contract search: `truncated` comes straight
 * off the wire — the panel never claims completeness the index did not
 * report, and names the limit instead of silently clipping the list.
 */
export function describeSearch(result: SearchResults | null, query: string, limit: number): string {
  const needle = query.trim();
  if (!needle) return "";
  if (result === null) return `Searching for “${needle}”`;
  const count = result.entries.length;
  if (count === 0) return `No matches for “${needle}”`;
  const suffix = result.truncated ? ` — showing first ${count}, refine the query` : "";
  return `${count}${result.truncated ? "+" : ""} match${count === 1 && !result.truncated ? "" : "es"} for “${needle}” (limit ${limit})${suffix}`;
}

/* ------------------------------------------------------------------------
 * Contents search: the shipped `searchContents` method on the same
 * `t3.workspace/search` API. One match record per matching line; the count
 * line reports matching lines and distinct files, both straight off the
 * wire — `truncated` and `regexFallbackError` are surfaced verbatim.
 * --------------------------------------------------------------------- */

/** One `searchContents` result record: a line carrying ≥1 match ranges. */
export interface ContentSearchMatch {
  readonly path: string;
  readonly lineNumber: number;
  readonly lineContent: string;
  readonly matchRanges: readonly { readonly start: number; readonly end: number }[];
}

export interface ContentSearchResults {
  readonly matches: readonly ContentSearchMatch[];
  readonly truncated: boolean;
  readonly regexFallbackError?: string;
}

export interface ContentMatchSegment {
  readonly text: string;
  readonly match: boolean;
}

/**
 * Line content → renderable segments with the contract's `matchRanges`
 * highlighted. Ranges are sorted, clamped to the line, and overlapping or
 * out-of-bounds ranges are dropped — the contract says they are ordered and
 * in-bounds, but a nonconforming host must not corrupt the line the user sees.
 */
export function contentMatchSegments(
  lineContent: string,
  matchRanges: readonly { readonly start: number; readonly end: number }[],
): ContentMatchSegment[] {
  const ranges = matchRanges
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end))
    .map((range) => ({
      start: Math.max(0, Math.min(range.start, lineContent.length)),
      end: Math.max(0, Math.min(range.end, lineContent.length)),
    }))
    .filter((range) => range.end > range.start)
    .toSorted((a, b) => a.start - b.start || a.end - b.end);
  // Overlapping ranges merge so every byte the host reported stays marked.
  const merged: { start: number; end: number }[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  const segments: ContentMatchSegment[] = [];
  let cursor = 0;
  for (const range of merged) {
    if (range.start > cursor)
      segments.push({ text: lineContent.slice(cursor, range.start), match: false });
    segments.push({ text: lineContent.slice(range.start, range.end), match: true });
    cursor = range.end;
  }
  if (cursor < lineContent.length) segments.push({ text: lineContent.slice(cursor), match: false });
  if (segments.length === 0) segments.push({ text: lineContent, match: false });
  return segments;
}

/**
 * Honest status for a contents search: "N matches in M files" — matches are
 * matching lines (the contract's granularity), files are distinct paths.
 * `truncated` comes straight off the wire and names the limit; a regex
 * fallback error is appended so a literal-substring fallback never
 * masquerades as the regex the user asked for.
 */
export function describeContentSearch(
  result: ContentSearchResults | null,
  query: string,
  limit: number,
): string {
  const needle = query.trim();
  if (!needle) return "";
  if (result === null) return `Searching contents for “${needle}”`;
  const lines = result.matches.length;
  const files = new Set(result.matches.map((match) => match.path)).size;
  const fallback = result.regexFallbackError ? ` — ${result.regexFallbackError}` : "";
  if (lines === 0) return `No contents matches for “${needle}”${fallback}`;
  const suffix = result.truncated ? ` — showing first ${lines}, refine the query` : "";
  return `${lines}${result.truncated ? "+" : ""} match${lines === 1 && !result.truncated ? "" : "es"} in ${files} file${files === 1 ? "" : "s"} for “${needle}” (limit ${limit})${suffix}${fallback}`;
}

/* ------------------------------------------------------------------------
 * Open in external editor: the public `t3.file/presentation.open`
 * path. The host's provider selection IS the picker — files, browser, or a
 * future editor provider can all provide the API — so resolving honestly is
 * the entire surface: report the descriptor or name the failure, never fake
 * an editor launch.
 * --------------------------------------------------------------------- */

/**
 * The file a restored view selects. `t3.file/presentation.open` with an empty
 * path (the host's plain Files panel) restores `{ relativePath: "" }`, which
 * means "no file"; selecting it would read the workspace root as a file.
 */
export function restoredSelection(restoreState: unknown): string | null {
  if (!restoreState || typeof restoreState !== "object" || Array.isArray(restoreState)) return null;
  const path = (restoreState as { readonly relativePath?: unknown }).relativePath;
  return typeof path === "string" && path !== "" ? path : null;
}

/** Upper bound on persisted expanded directories — view state, not an index. */
export const MAX_PERSISTED_EXPANDED = 512;

/**
 * Byte budget for persisted expansion: half the host's 64 KiB payload cap,
 * leaving room for the rest of the record. 512 deep monorepo paths exceed it.
 */
export const MAX_PERSISTED_EXPANDED_BYTES = 32 * 1024;

/**
 * The Files view's saved state (row 12): the selected file plus tree
 * expansion and the rendered-markdown preference. `expanded` and
 * `renderMarkdown` are optional so the `{ relativePath }` records written by
 * `t3.file/presentation.open` and older saves stay valid at stateVersion 1.
 */
export type FilesViewState = {
  readonly relativePath: string;
  readonly expanded?: readonly string[];
  readonly renderMarkdown?: boolean;
};

/** validateRestore for the Files view: null or a well-formed FilesViewState. */
export function isFilesViewState(value: unknown): value is FilesViewState | null {
  if (value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record))
    if (key !== "relativePath" && key !== "expanded" && key !== "renderMarkdown") return false;
  if (typeof record.relativePath !== "string") return false;
  if (
    record.expanded !== undefined &&
    !(
      Array.isArray(record.expanded) &&
      record.expanded.length <= MAX_PERSISTED_EXPANDED &&
      record.expanded.every((path) => typeof path === "string")
    )
  )
    return false;
  return record.renderMarkdown === undefined || typeof record.renderMarkdown === "boolean";
}

/** Expanded directories a restored view reopens; empty for anything malformed. */
export function restoredExpanded(restoreState: unknown): Set<string> {
  if (!isFilesViewState(restoreState) || restoreState === null) return new Set();
  return new Set(restoreState.expanded ?? []);
}

/** Whether a restored view resumes in the rendered-markdown preview. */
export function restoredRenderMarkdown(restoreState: unknown): boolean {
  return isFilesViewState(restoreState) && restoreState?.renderMarkdown === true;
}

/**
 * The record `session.save` persists. Expansion is sorted so equal view
 * states serialize identically, and bounded by count and bytes so a
 * sprawling tree can neither grow the record without limit nor push it past
 * the host's payload cap (an oversized `session.save` throws).
 */
export function filesViewState(
  selected: string | null,
  expanded: ReadonlySet<string>,
  renderMarkdown: boolean,
): FilesViewState {
  const kept: string[] = [];
  let bytes = 0;
  for (const path of [...expanded].sort()) {
    if (kept.length >= MAX_PERSISTED_EXPANDED) break;
    // JSON quotes plus the separating comma.
    bytes += textEncoder.encode(path).length + 3;
    if (bytes > MAX_PERSISTED_EXPANDED_BYTES) break;
    kept.push(path);
  }
  return { relativePath: selected ?? "", expanded: kept, renderMarkdown };
}

/**
 * Safety check before `t3.file/presentation.open`: the path must be
 * workspace-relative — reject absolute, empty, `..` and backslash segments.
 * Same predicate the diff panel ported; kept package-local because the
 * sibling package's view model is not a shared contract.
 */
export function presentationPath(path: string): string | null {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment === "" || segment === "..")
  ) {
    return null;
  }
  return path;
}

/** Honest report of a resolved `t3.file/presentation.open` descriptor. */
export function describePresentation(result: {
  readonly surfaceId: string;
  readonly placement: string;
}): string {
  return `opens in ${result.surfaceId} · ${result.placement}`;
}

export type FileOpenState =
  | { readonly status: "idle" }
  | { readonly status: "resolving" }
  | { readonly status: "resolved"; readonly message: string }
  | { readonly status: "denied"; readonly message: string }
  | { readonly status: "unavailable"; readonly message: string };

/**
 * `presentation.open` invoke failure → named state. The broker delivers the
 * resolution reason code or the capability denial as the error message, so
 * match those strings exactly: grant denial is `denied` (recoverable by
 * granting `t3.file/open` at install), resolution failures are `unavailable`,
 * and anything else reports its detail — never a silent no-op.
 */
export function fileOpenFailed(
  error: unknown,
): Extract<FileOpenState, { readonly status: "denied" | "unavailable" }> {
  const text = error instanceof Error ? error.message : String(error);
  if (text.includes("capability denied"))
    return {
      status: "denied",
      message: "Open is denied — this installation is missing the t3.file/open grant",
    };
  if (text.includes("provider-selection-required"))
    return {
      status: "unavailable",
      message:
        "Several providers can open files — pick one for t3.file/presentation in extension settings",
    };
  if (
    text.includes("missing-api") ||
    text.includes("selected-provider-unavailable") ||
    text.includes("API unavailable")
  )
    return {
      status: "unavailable",
      message: "Open is unavailable — no provider is selected for t3.file/presentation",
    };
  return {
    status: "unavailable",
    message: `Open failed${text ? `: ${text.slice(0, 300)}` : ""}`,
  };
}

/** Status line for the open-in-presentation action. */
export function describeFileOpen(state: FileOpenState): string {
  switch (state.status) {
    case "idle":
      return "";
    case "resolving":
      return "Resolving presentation…";
    case "resolved":
    case "denied":
    case "unavailable":
      return state.message;
  }
}

/** Which selected paths offer the rendered-markdown view. */
export function isMarkdownPath(relativePath: string): boolean {
  return /\.(?:md|mdx)$/i.test(relativePath);
}

// ---------------------------------------------------------------------------
// t3.ui/theme consumption
// ---------------------------------------------------------------------------

/**
 * The theme roles this panel consumes, each republished as a `--t3-files-*`
 * custom property on the view root. Component styles chain
 * `var(--t3-files-x, …)` ahead of their pre-contract fallbacks, so a host
 * that cannot serve the contract (ungranted or provider-less) renders
 * exactly what it rendered before adoption. The `font-*` vars are not color
 * roles and stay outside the contract map on purpose.
 */
export const FILES_THEME_VARS = {
  text: "--t3-files-text",
  canvas: "--t3-files-canvas",
  mutedForeground: "--t3-files-muted-foreground",
  border: "--t3-files-border",
  muted: "--t3-files-muted",
  accentSurface: "--t3-files-accent-surface",
  messageAction: "--t3-files-message-action",
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
  for (const [role, property] of Object.entries(FILES_THEME_VARS)) {
    const value = tokens[role];
    if (value === undefined) continue;
    const contractVar = cssVars[role];
    overrides[property] = contractVar ? `var(${contractVar}, ${value})` : value;
  }
  return overrides;
}

/**
 * Drives the theme-var layer: an initial `getTokens` read, re-read on every
 * `subscribeState` frame. `apply` receives the published map after each
 * successful read and `null` whenever the feed can't vouch for values —
 * at subscription start (a fresh feed must not inherit the old one's map),
 * on a denied read, and on a closed or lost stream (the no-stale-fallback
 * rule). A failure also invalidates any older in-flight response so it
 * cannot restore a stale map. The caller's `signal` owns the lifetime; the
 * stream has no resume, so recovery is a fresh subscription from the view
 * lifecycle (hide→show or session change).
 */
export function watchThemeVars(options: {
  readonly client: Pick<ApiClient, "invokeApi" | "subscribeApi">;
  readonly context: ViewContext;
  readonly signal: AbortSignal;
  readonly apply: (vars: Record<string, string> | null) => void;
}): Promise<void> {
  const api = bindApi(uiThemeApi, options.client, options.context);
  const streams = bindStreamApi(uiThemeApi, options.client, options.context);
  if (!options.signal.aborted) options.apply(null);
  let generation = 0;
  const invalidate = () => {
    generation += 1;
    if (!options.signal.aborted) options.apply(null);
  };
  const refresh = () => {
    const at = ++generation;
    void api.invoke("getTokens", {}, options.signal).then(
      (value) => {
        if (!options.signal.aborted && at === generation)
          options.apply(themeVarOverrides(value.tokens, value.cssVars));
      },
      // A superseded rejection carries no fresh information — only the
      // newest read's failure may invalidate the published map.
      () => {
        if (at === generation) invalidate();
      },
    );
  };
  refresh();
  return (async () => {
    try {
      for await (const frame of streams.subscribe("subscribeState", {}, options.signal)) {
        if (options.signal.aborted) return;
        if (frame.type === "closed") break;
        refresh();
      }
      invalidate();
    } catch {
      invalidate();
    }
  })();
}

// ---------------------------------------------------------------------------
// t3.ui/keybindings consumption
// ---------------------------------------------------------------------------

/**
 * The panel's command set for `t3.ui/keybindings`. `surface` scope keeps
 * dispatch at the focused-view arbitration tier — each command acts only on
 * the view instance that registered it, and the palette greys it unless that
 * view is focused. `defaultKey`s sit beneath user and native rules, so they
 * only fill a true miss; `mod+r`/`mod+f` mirror the app's own refresh and
 * find conventions and carry the surface-focus `when` clause — without it a
 * default matches `extensionCommandForKeydown` even while another
 * extension's view is focused, and first-match wins the chord before
 * eligibility drops the dispatch. Commands that collide with an
 * unconditional native rule (`mod+o` → `editor.openFavorite`) ship unbound
 * rather than registering a losing conflict. Element-local keys (Escape in
 * the editor and search field) stay element-local — the contract is for
 * named commands, not DOM key handling.
 */
export const FILES_VIEW_COMMANDS: readonly {
  readonly id: string;
  readonly title: string;
  readonly defaultKey?: string;
  readonly when?: string;
  readonly scope: "surface";
}[] = [
  {
    id: "refresh",
    title: "Refresh files",
    defaultKey: "mod+r",
    when: "extension.t3.files/view.focus",
    scope: "surface",
  },
  {
    id: "focusSearch",
    title: "Focus file search",
    defaultKey: "mod+f",
    when: "extension.t3.files/view.focus",
    scope: "surface",
  },
  { id: "openIn", title: "Open file in…", scope: "surface" },
  { id: "toggleMarkdown", title: "Toggle rendered markdown", scope: "surface" },
];

// ---------------------------------------------------------------------------
// t3.ui/notifications consumption
// ---------------------------------------------------------------------------

/**
 * The `notify` input for a failed open-in-presentation — the one place the
 * native Files surface toasts (`FilePreviewPanel` raises "Unable to open file
 * in browser" on a failed preview open). Thread-anchored when the view runs
 * in a thread context, matching the native `stackedThreadToast`; otherwise
 * the global drawer. `durationMs` matches the toast manager's 5 s default —
 * the contract provider pins `timeout: 0` and dismisses only on an explicit
 * duration, so omitting it would leave every failed open permanently
 * displayed. Non-failure states return null: resolving and resolved are
 * inline status in both implementations, and save/search surfaces never
 * toast natively.
 */
export function fileOpenNotification(
  state: FileOpenState,
  threadId: string | undefined,
): {
  readonly severity: "error";
  readonly title: string;
  readonly body: string;
  readonly durationMs: number;
  readonly anchor?: "thread";
  readonly threadId?: string;
} | null {
  if (state.status !== "denied" && state.status !== "unavailable") return null;
  return {
    severity: "error",
    title: "Unable to open file",
    body: describeFileOpen(state),
    durationMs: 5_000,
    ...(threadId !== undefined && threadId.length > 0
      ? { anchor: "thread" as const, threadId }
      : {}),
  };
}
