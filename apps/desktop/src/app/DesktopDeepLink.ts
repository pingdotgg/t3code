import type { DesktopDeepLinkTarget } from "@t3tools/contracts";

// Parsing for the `t3code://` deep links that address an existing thread.
//
// The external contract is the same one the mobile app and widgets already use:
//
//   t3code://threads/<environmentId>/<threadId>
//
// which maps onto the renderer's typed route `/$environmentId/$threadId`. Only
// the external shape is stable; the renderer route stays an implementation
// detail, so callers outside the app never depend on the hash history layout.
//
// Parsing lives here as plain functions (no Effect) so the URL edge cases can be
// unit tested without an Electron or Effect runtime, mirroring wslPathParsing.

export const DEEP_LINK_THREAD_HOST = "threads";

// Re-exported so main-process modules do not each reach into the contracts
// package for what is, from their side, this module's return type.
export type DeepLinkTarget = DesktopDeepLinkTarget;

// Path segments are percent-decoded by `URL`, but a decoded segment can still
// be empty, contain a path separator, or be pure whitespace when the link was
// hand-written or truncated by a chat client. Anything that is not a single
// clean segment is rejected rather than normalized: a wrong-but-plausible id
// would navigate to someone else's thread, which is worse than not navigating.
function isCleanSegment(value: string): boolean {
  if (value.length === 0 || value.trim().length !== value.length) return false;
  return !/[/\\?#]/.test(value);
}

/**
 * Parses a deep link URL into a navigation target.
 *
 * Returns `null` for anything that is not a well-formed thread link, including
 * links using a different scheme, so callers can fall back to simply revealing
 * the window.
 */
export function parseDeepLink(rawUrl: string, schemes: readonly string[]): DeepLinkTarget | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  // `URL.protocol` keeps the trailing colon.
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (!schemes.some((candidate) => candidate.toLowerCase() === scheme)) {
    return null;
  }

  // `t3code://threads/<env>/<thread>` puts `threads` in the host position, not
  // in the path — the authority component absorbs the first segment.
  if (url.hostname.toLowerCase() !== DEEP_LINK_THREAD_HOST) {
    return null;
  }

  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length !== 2) {
    return null;
  }

  let environmentId: string;
  let threadId: string;
  try {
    environmentId = decodeURIComponent(segments[0] ?? "");
    threadId = decodeURIComponent(segments[1] ?? "");
  } catch {
    // Malformed percent-encoding.
    return null;
  }

  if (!isCleanSegment(environmentId) || !isCleanSegment(threadId)) {
    return null;
  }

  return { kind: "thread", environmentId, threadId };
}

/**
 * Extracts the first deep link from a process argv vector.
 *
 * Windows and Linux deliver protocol URLs as a command-line argument — both on
 * first launch and, for an already-running app, through Electron's
 * `second-instance` event. macOS instead emits `open-url`, so this is not used
 * there.
 */
export function findDeepLinkInArgv(
  argv: readonly string[],
  schemes: readonly string[],
): string | null {
  for (const arg of argv) {
    if (typeof arg !== "string") continue;
    const trimmed = arg.trim();
    if (trimmed.length === 0) continue;
    if (!schemes.some((scheme) => trimmed.toLowerCase().startsWith(`${scheme.toLowerCase()}://`))) {
      continue;
    }
    return trimmed;
  }
  return null;
}
