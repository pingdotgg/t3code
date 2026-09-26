/**
 * Pure view-model for the Browser panel. Owns the panel-local navigation
 * state machine and the requested-targets history the chrome row renders.
 *
 * Accepted targets are dispatched to a `t3.browser/sessions` session by the
 * view; receipts are dispatch records, never load confirmations — engine and
 * navigation state come only from the sessions stream. The history stack
 * keeps real browser traversal semantics (submitting drops forward entries).
 */
import { normalizePreviewUrl } from "@t3tools/shared/preview";

/** The normalized target the user asked for, or the rejection reason. */
export type NavigationStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "rejected"; readonly input: string; readonly message: string }
  | { readonly kind: "target"; readonly url: string };

export interface NavigationState {
  /** Accepted normalized targets in visit order; index points at the current one. */
  readonly history: readonly string[];
  readonly index: number;
  /**
   * Bumped on every accepted submit/reload so a re-request of the current
   * target is observable even though nothing about the URL changed.
   */
  readonly epoch: number;
  readonly status: NavigationStatus;
}

export const initialNavigationState: NavigationState = {
  history: [],
  index: -1,
  epoch: 0,
  status: { kind: "idle" },
};

export type AddressResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly message: string };

/**
 * The exact normalization the native panel runs (its PreviewView submits
 * through `@t3tools/shared/preview` `normalizePreviewUrl`): bare loopback → http,
 * bare host → https, http(s) only, `PreviewUrlNormalizationError` → a plain
 * message.
 */
export function normalizeAddress(raw: string): AddressResult {
  try {
    return { ok: true, url: normalizePreviewUrl(raw) };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Address could not be parsed",
    };
  }
}

/**
 * Record a requested target. Invalid input becomes a named rejection and
 * never enters history; a valid URL truncates any forward entries and
 * becomes the current target — the same stack semantics the engine's
 * history would enforce.
 */
export function submitAddress(state: NavigationState, raw: string): NavigationState {
  const result = normalizeAddress(raw);
  if (!result.ok) {
    return {
      ...state,
      status: { kind: "rejected", input: raw, message: result.message },
    };
  }
  const history = [...state.history.slice(0, state.index + 1), result.url];
  return {
    history,
    index: history.length - 1,
    epoch: state.epoch + 1,
    status: { kind: "target", url: result.url },
  };
}

export function canGoBack(state: NavigationState): boolean {
  return state.index > 0;
}

export function canGoForward(state: NavigationState): boolean {
  return state.index >= 0 && state.index < state.history.length - 1;
}

export function goBack(state: NavigationState): NavigationState {
  if (!canGoBack(state)) return state;
  const index = state.index - 1;
  return { ...state, index, status: { kind: "target", url: state.history[index]! } };
}

export function goForward(state: NavigationState): NavigationState {
  if (!canGoForward(state)) return state;
  const index = state.index + 1;
  return { ...state, index, status: { kind: "target", url: state.history[index]! } };
}

/** Re-request the current target; idle/rejected states have nothing to reload. */
export function reload(state: NavigationState): NavigationState {
  if (state.status.kind !== "target") return state;
  return { ...state, epoch: state.epoch + 1 };
}

/** Current target's URL, or null when the panel has none. */
export function currentUrl(state: NavigationState): string | null {
  return state.index >= 0 ? (state.history[state.index] ?? null) : null;
}

/**
 * The requested-targets rows the empty state lists, newest first, each
 * paired with its index in `state.history` so the render can mark the
 * current entry. Minted lease URLs stay in the navigation stack —
 * back/forward and `currentUrl` must track the session's traversal — but
 * never list: they expire with their token and a click can only open a
 * guaranteed-404 session.
 */
export function recentTargets(
  state: NavigationState,
): ReadonlyArray<{ readonly url: string; readonly index: number }> {
  return state.history
    .map((url, index) => ({ url, index }))
    .toReversed()
    .filter((entry) => !isLeaseUrl(entry.url));
}

/**
 * A session tab row's label — the native right-panel tab title rule: a
 * non-empty page title, else the URL's host, else "Browser".
 */
export function tabLabel(title: string, url: string | null): string {
  const trimmed = title.trim();
  if (trimmed.length > 0) return trimmed;
  if (url) {
    try {
      return new URL(url).host || "Browser";
    } catch {
      // An unparseable url still gets the neutral label.
    }
  }
  return "Browser";
}

/**
 * Body copy when no browser session is held — the contract exists now, so the
 * notice names how a session starts rather than a missing engine.
 */
export const NO_SESSION_NOTICE =
  "No browser session is open in this panel yet. Enter an address to open one through t3.browser/sessions.";

/** Status line for the current navigation state. */
export function describeStatus(state: NavigationState): string {
  switch (state.status.kind) {
    case "idle":
      return "Enter an address — nothing requested yet";
    case "rejected":
      return `Rejected “${state.status.input}” — ${state.status.message}`;
    case "target":
      return `Requested ${state.status.url} (request ${state.epoch})`;
  }
}

/**
 * Browser-previewable workspace files — same rule as the native
 * `isBrowserPreviewFile` (the native openFileInPreview module, line 32).
 * Package-owned so the presentation provider and the view agree.
 */
export function isBrowserPreviewFile(path: string): boolean {
  return /\.(?:html?|pdf)$/i.test(path.split(/[?#]/, 1)[0] ?? "");
}

/** A minted workspace-file URL — never recorded in history or restore state. */
export function isLeaseUrl(url: string): boolean {
  try {
    return new URL(url).pathname.startsWith("/api/assets/");
  } catch {
    return false;
  }
}
