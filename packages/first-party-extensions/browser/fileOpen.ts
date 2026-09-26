/**
 * Open a workspace HTML file in the browser surface. Native mints a
 * `workspace-file` asset URL and opens a preview session on it (the native
 * openFileInPreview module); the plugin's equivalent is
 * `t3.resources/lease` `createPresentationUrl` → `t3.browser/sessions`.
 *
 * A `workspace-file` lease for an HTML file is a directory claim: the token
 * serves the file's siblings (`style.css`, `app.js`) under the same
 * `/api/assets/<token>/` prefix, so relative subresources load. The token
 * expires at `expiresAt` (1 h); after that every request under it 404s. A
 * lease URL is therefore never written to history or to the restore record —
 * the view keeps the workspace path and re-mints (on restore without a live
 * session, and on Reload) instead of reopening a dead URL.
 */
import type { ResourceLeaseRef } from "@t3tools/extension-sdk/catalogue";
import { WORKSPACE_RESOURCES } from "@t3tools/extension-sdk/catalogue";

import { isBrowserPreviewFile } from "./viewModel.ts";

export type FileOpenFailureReason =
  | "grant-denied"
  | "mint-unsupported"
  | "foreign-origin"
  | "outside-workspace"
  | "not-previewable"
  | "not-found"
  | "context-missing"
  | "unavailable";

export type FileOpenResult =
  | { readonly ok: true; readonly url: string; readonly expiresAt: number }
  | {
      readonly ok: false;
      readonly reason: FileOpenFailureReason;
      readonly message: string;
    };

type Failure = Extract<FileOpenResult, { readonly ok: false }>;

const fail = (reason: FileOpenFailureReason, message: string): Failure => ({
  ok: false,
  reason,
  message,
});

/**
 * Workspace-relative path → lease ref. An absolute path, a `..` segment or a
 * backslash is refused by name before any mint — the plugin never asks the
 * host to serve a path it could not name inside the workspace.
 */
export function fileLeaseRef(
  threadId: string | undefined,
  relativePath: string,
): { readonly ok: true; readonly resource: ResourceLeaseRef } | Failure {
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    /^[a-zA-Z]:/.test(relativePath) ||
    relativePath.split("/").some((segment) => segment === "..")
  )
    return fail(
      "outside-workspace",
      `Cannot open ${relativePath || "an empty path"} — the path is outside the workspace.`,
    );
  if (!isBrowserPreviewFile(relativePath))
    return fail(
      "not-previewable",
      `Cannot open ${relativePath} — the browser opens .html, .htm and .pdf files only.`,
    );
  if (!threadId)
    return fail(
      "context-missing",
      "Cannot open a workspace file here — this view has no thread to resolve the workspace from.",
    );
  return { ok: true, resource: { _tag: "workspace-file", threadId, path: relativePath } };
}

/** `getCapabilities` gate: an absent kind is named, never a mint-and-hope. */
export function mintGate(supportedKinds: readonly string[]): Failure | null {
  return supportedKinds.includes("workspace-file")
    ? null
    : fail(
        "mint-unsupported",
        "Cannot open workspace files — this environment cannot mint workspace-file leases.",
      );
}

/**
 * The minted `url` is server-relative ("resolve against the environment
 * origin"). The SDK hands a plugin no environment origin, so — like the files
 * plugin's media lease — it resolves against the document this view runs in.
 * That is the environment only when the client is served from it: a
 * non-HTTP document (the desktop app's `t3code://` renderer) or a result on a
 * different origin is named, never handed to the engine as a dead link.
 */
export function resolveLeaseUrl(
  minted: string,
  documentUrl: string | undefined,
): { readonly ok: true; readonly url: string } | Failure {
  let base: URL;
  try {
    base = new URL(documentUrl ?? "");
  } catch {
    return fail("foreign-origin", FOREIGN_ORIGIN_NO_BASE);
  }
  if (base.protocol !== "http:" && base.protocol !== "https:")
    return fail(
      "foreign-origin",
      `Cannot open workspace files from this client — it is served from ${base.protocol}//${base.host}, not the environment's web address, and plugins are not told that address.`,
    );
  let resolved: URL;
  try {
    resolved = new URL(minted, base);
  } catch {
    return fail("unavailable", "Cannot open the file — the environment returned an invalid URL.");
  }
  if (resolved.origin !== base.origin)
    return fail(
      "foreign-origin",
      "Cannot open the file — the environment returned a URL on a different origin.",
    );
  return { ok: true, url: resolved.href };
}

const FOREIGN_ORIGIN_NO_BASE =
  "Cannot open workspace files from this client — it has no web address to resolve the file against.";

export const FOREIGN_ORIGIN_UNREACHABLE =
  "Cannot open the file — the minted URL did not load on this client's origin (this client is not served by the environment).";

const LEASE_DENIALS: ReadonlyArray<{
  readonly name: string;
  readonly reason: FileOpenFailureReason;
  readonly message: string;
}> = [
  {
    name: "ResourceLeaseGrantDeniedError",
    reason: "grant-denied",
    message: `Cannot open workspace files — this installation is missing the ${WORKSPACE_RESOURCES} grant.`,
  },
  {
    name: "ResourceLeaseKindDeniedError",
    reason: "mint-unsupported",
    message: "Cannot open workspace files — this environment does not mint workspace-file leases.",
  },
  {
    name: "AssetWorkspacePathValidationError",
    reason: "outside-workspace",
    message: "Cannot open the file — the path resolves outside the workspace.",
  },
  {
    name: "AssetPreviewTypeValidationError",
    reason: "not-previewable",
    message: "Cannot open the file — this file type cannot be served to the browser.",
  },
  {
    name: "AssetWorkspaceAssetNotFoundError",
    reason: "not-found",
    message: "Cannot open the file — it no longer exists in the workspace.",
  },
];

const CONTEXT_ERRORS = [
  "AssetWorkspaceContextNotFoundError",
  "AssetWorkspaceContextResolutionError",
  "AssetWorkspaceRootNormalizationError",
];

/** Mint failure → named reason. The adapter puts the stable error name in the message. */
export function fileOpenErrorState(error: unknown): Failure {
  const text = error instanceof Error ? error.message : String(error);
  for (const denial of LEASE_DENIALS)
    if (text.includes(denial.name)) return fail(denial.reason, denial.message);
  if (CONTEXT_ERRORS.some((name) => text.includes(name)))
    return fail(
      "context-missing",
      "Cannot open the file — the thread's workspace could not be resolved.",
    );
  // The broker's "no provider bound" failure: a host without the lease API.
  if (/\bAPI unavailable\b/.test(text))
    return fail(
      "mint-unsupported",
      "Cannot open workspace files — this environment has no t3.resources/lease provider.",
    );
  return fail("unavailable", `Cannot open the file${text ? ` — ${text.slice(0, 300)}` : ""}.`);
}

/** The two `t3.resources/lease` calls this flow makes. */
export interface LeaseCalls {
  getCapabilities(signal: AbortSignal): Promise<{ readonly supportedKinds: readonly string[] }>;
  createPresentationUrl(
    resource: ResourceLeaseRef,
    signal: AbortSignal,
  ): Promise<{ readonly url: string; readonly expiresAt: number }>;
}

/**
 * Mint + resolve + preflight. The preflight fetch runs from this document —
 * the same origin rule the files plugin's document preview uses — so a
 * foreign-origin client lands in the named state instead of an engine 404
 * page. The body is discarded; the engine fetches the page itself.
 */
export async function mintWorkspaceFileUrl(input: {
  readonly lease: LeaseCalls;
  readonly threadId: string | undefined;
  readonly relativePath: string;
  readonly documentUrl: string | undefined;
  readonly fetch: (url: string, init: { readonly signal: AbortSignal }) => Promise<Response>;
  readonly signal: AbortSignal;
}): Promise<FileOpenResult> {
  const ref = fileLeaseRef(input.threadId, input.relativePath);
  if (!ref.ok) return ref;
  // Origin first: a client that cannot address the environment should not
  // hold a minted token it can never use.
  const originCheck = resolveLeaseUrl("/", input.documentUrl);
  if (!originCheck.ok) return originCheck;
  let minted: { readonly url: string; readonly expiresAt: number };
  try {
    const capabilities = await input.lease.getCapabilities(input.signal);
    const gate = mintGate(capabilities.supportedKinds);
    if (gate) return gate;
    minted = await input.lease.createPresentationUrl(ref.resource, input.signal);
  } catch (error) {
    input.signal.throwIfAborted();
    return fileOpenErrorState(error);
  }
  const resolved = resolveLeaseUrl(minted.url, input.documentUrl);
  if (!resolved.ok) return resolved;
  try {
    const response = await input.fetch(resolved.url, { signal: input.signal });
    await response.body?.cancel().catch(() => {});
    if (!response.ok) return fail("foreign-origin", FOREIGN_ORIGIN_UNREACHABLE);
  } catch (error) {
    input.signal.throwIfAborted();
    return fail(
      "foreign-origin",
      `${FOREIGN_ORIGIN_UNREACHABLE}${error instanceof Error && error.message ? ` (${error.message.slice(0, 200)})` : ""}`,
    );
  }
  return { ok: true, url: resolved.url, expiresAt: minted.expiresAt };
}
