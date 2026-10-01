/**
 * Page controls over the `t3.browser/sessions` engine verbs — back, forward,
 * reload, hard reload, zoom, appearance, mute, DevTools and native
 * picture-in-picture (which needs its own `t3.browser/picture-in-picture`
 * grant). Every verb is dispatched to the desktop engine host that owns the
 * session; this module decides whether a verb may be sent, names why not, and
 * turns receipts and errors into the panel's inline messages. Pure and
 * client-injected so the rules are testable without a mounted view.
 *
 * Engine truth comes from the session's `engine` block. Only the client's
 * explicit owner-claim signal hides the unclaimed `desktop-required` sentinel
 * while attachment is pending; remote environments and failed claims keep
 * their real unavailable state. Dead guests are `crashed` and replacements
 * are `recovering`. Blocked controls name the same state as the status line.
 *
 * DevTools (open and close are separate verbs) additionally needs the
 * installation's `t3.browser/devtools` grant and only acts on sessions this
 * installation opened; each refusal is shown by name.
 */
import { describeGrantDenial } from "@t3tools/extension-sdk/capabilities";
import {
  BROWSER_SESSION_ZOOM_LEVELS,
  type BrowserSession,
  type BrowserSessionReceipt,
  type browserSessionsApi,
} from "@t3tools/extension-sdk/catalogue";

import type { BoundApi } from "./uiContracts.js";

export type PageAppearance = "system" | "light" | "dark";

export type PageVerb =
  | {
      readonly method:
        | "back"
        | "forward"
        | "reload"
        | "hardReload"
        | "openDevTools"
        | "closeDevTools";
    }
  | { readonly method: "zoom"; readonly zoomFactor: number }
  | { readonly method: "setAppearance"; readonly appearance: PageAppearance }
  | { readonly method: "setAudioMuted"; readonly muted: boolean }
  | { readonly method: "setPictureInPicture"; readonly open: boolean };

/** The fence every engine verb carries. */
export interface PageTarget {
  readonly tabId: string;
  readonly serverEpoch: string;
  readonly engineGeneration: string | null;
}

// ---------------------------------------------------------------------------
// Engine gate

/**
 * Why page verbs cannot be sent to this session right now, or null when they
 * can. `starting` is allowed: the host has claimed the guest and answers
 * commands before its first page report.
 */
export function pageControlsBlock(
  session: BrowserSession | null,
  engineClaimPending = false,
): string | null {
  if (session === null) return "Waiting for the browser session to report its state.";
  if (awaitingEngineClaim(session, engineClaimPending))
    return "Waiting for the browser engine to attach.";
  const { engine } = session;
  switch (engine.state) {
    case "ready":
    case "starting":
      return null;
    case "unavailable":
      return `Page controls need the T3 Code desktop app, where the page renders (${engine.reason ?? "desktop-required"}).`;
    case "recovering":
      return "The page crashed and the browser engine is recovering it (recovering).";
    case "crashed":
      return engine.reason === "recovery-exhausted"
        ? "The page crashed and recovery gave up (recovery-exhausted). Reload opens a fresh session."
        : "The page crashed (crash).";
  }
}

/** A guest whose recovery gave up stays dead; only a new session brings the page back. */
export function isRecoveryExhausted(session: BrowserSession | null): boolean {
  return session?.engine.state === "crashed" && session.engine.reason === "recovery-exhausted";
}

export function awaitingEngineClaim(session: BrowserSession, engineClaimPending: boolean): boolean {
  return (
    engineClaimPending &&
    session.engine.state === "unavailable" &&
    session.engine.generation === null &&
    session.engine.reason === "desktop-required"
  );
}

/** Engine/navigation status, with pending wording only for a host-reported owner claim. */
export function engineStatusLabel(session: BrowserSession, engineClaimPending = false): string {
  const { engine, navigation } = session;
  const engineText = awaitingEngineClaim(session, engineClaimPending)
    ? "engine pending"
    : engine.state === "ready"
      ? "engine ready"
      : `engine ${engine.state}${engine.reason ? ` (${engine.reason})` : ""}`;
  const failure = navigation.failureCode ? ` (${navigation.failureCode})` : "";
  return `${engineText}, navigation ${navigation.kind}${failure}`;
}

// ---------------------------------------------------------------------------
// Zoom ladder

/** The contract ladder — the only factors `zoom` accepts. */
export const ZOOM_LADDER: readonly number[] = BROWSER_SESSION_ZOOM_LEVELS;
export const DEFAULT_ZOOM_FACTOR = 1;
const ZOOM_EPSILON = 0.001;

export function isLadderFactor(factor: number): boolean {
  return ZOOM_LADDER.some((level) => Math.abs(level - factor) < ZOOM_EPSILON);
}

/**
 * The native zoomIn/zoomOut step: the ladder entry at or below `current`,
 * then one step in `direction`, clamped at the ends. An unreported factor
 * steps from 100%.
 */
export function nextZoomFactor(current: number | null, direction: "in" | "out"): number {
  const base = current ?? DEFAULT_ZOOM_FACTOR;
  const found = ZOOM_LADDER.findIndex(
    (level) => Math.abs(level - base) < ZOOM_EPSILON || level > base,
  );
  const step =
    found < 0
      ? ZOOM_LADDER.length - 1
      : Math.abs(ZOOM_LADDER[found]! - base) < ZOOM_EPSILON
        ? found
        : found - 1;
  const index =
    direction === "in" ? Math.min(step + 1, ZOOM_LADDER.length - 1) : Math.max(step - 1, 0);
  return ZOOM_LADDER[index]!;
}

export function zoomPercent(factor: number): string {
  return `${Math.round(factor * 100)}%`;
}

// ---------------------------------------------------------------------------
// Dispatch

const VERB_LABELS: Record<PageVerb["method"], string> = {
  back: "Back",
  forward: "Forward",
  reload: "Reload",
  hardReload: "Hard reload",
  zoom: "Zoom",
  setAppearance: "Appearance",
  setAudioMuted: "Mute",
  openDevTools: "Open DevTools",
  closeDevTools: "Close DevTools",
  setPictureInPicture: "Picture in picture",
};

/** Inline message for a thrown verb, keyed on the server's stable error names. */
export function pageCommandErrorMessage(method: PageVerb["method"], error: unknown): string {
  const label = VERB_LABELS[method];
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const denial = describeGrantDenial(error);
  if (denial) return `${label} — ${denial.message}`;
  if (text.includes("BrowserSessionNotOwned"))
    return `${label} is only available on pages this panel opened (not-owned).`;
  if (text.includes("(engine-unsupported)"))
    return `${label} is not supported by the browser engine rendering this page (engine-unsupported).`;
  if (text.includes("BrowserSessionEngineDetached"))
    return `${label} was not sent: no desktop engine has attached this page yet (no-attached-engine).`;
  if (text.includes("BrowserSessionCommandUnsupported"))
    return `${label} needs the T3 Code desktop app, where the page renders (desktop-required).`;
  if (text.includes("BrowserStaleEngineGeneration"))
    return `${label} was not sent: the page's engine was replaced (stale-generation). Try again.`;
  if (text.includes("BrowserSessionNotFound"))
    return `${label} was not sent: the session is gone (session-not-found).`;
  const engineNotLive = /BrowserSessionEngineNotLive:.*\(([a-z-]+)\)/.exec(text);
  if (engineNotLive)
    return `${label} needs a live page; the page's engine is not live (${engineNotLive[1]}).`;
  return `${label} failed — ${text || "unknown error"}`;
}

/** Inline message for a non-accepted receipt; null for `accepted`. */
export function pageReceiptMessage(
  method: PageVerb["method"],
  outcome: BrowserSessionReceipt["outcome"],
): string | null {
  const label = VERB_LABELS[method];
  switch (outcome) {
    case "accepted":
      return null;
    case "rejected":
      return `${label} was rejected by the browser engine.`;
    case "unknown":
      return `${label}: the browser engine did not answer (unknown). The page state will catch up from the session.`;
  }
}

export type PageCommandOutcome =
  | { readonly kind: "accepted"; readonly receipt: BrowserSessionReceipt }
  | { readonly kind: "blocked" | "failed"; readonly message: string }
  | {
      readonly kind: "rejected" | "unknown";
      readonly message: string;
      readonly receipt: BrowserSessionReceipt;
    };

/**
 * Send one verb. A blocked engine or an off-ladder zoom factor never reaches
 * the wire; everything else is exactly one `t3.browser/sessions` call — a zoom
 * jump to any ladder factor included, never emulated by stepping.
 */
export async function runPageCommand(
  api: BoundApi<typeof browserSessionsApi>,
  target: PageTarget,
  session: BrowserSession | null,
  verb: PageVerb,
  signal: AbortSignal,
  engineClaimPending = false,
): Promise<PageCommandOutcome> {
  const block = pageControlsBlock(session, engineClaimPending);
  if (block !== null) return { kind: "blocked", message: block };
  if (verb.method === "zoom" && !isLadderFactor(verb.zoomFactor))
    return {
      kind: "blocked",
      message: `${zoomPercent(verb.zoomFactor)} is not on the zoom ladder.`,
    };
  const guard = {
    tabId: target.tabId,
    serverEpoch: target.serverEpoch,
    expectedEngineGeneration: target.engineGeneration,
  };
  let receipt: BrowserSessionReceipt;
  try {
    switch (verb.method) {
      case "zoom":
        receipt = await api.invoke("zoom", { ...guard, zoomFactor: verb.zoomFactor }, signal);
        break;
      case "setAppearance":
        receipt = await api.invoke(
          "setAppearance",
          { ...guard, appearance: verb.appearance },
          signal,
        );
        break;
      case "setAudioMuted":
        receipt = await api.invoke("setAudioMuted", { ...guard, muted: verb.muted }, signal);
        break;
      case "setPictureInPicture":
        receipt = await api.invoke("setPictureInPicture", { ...guard, open: verb.open }, signal);
        break;
      default:
        receipt = await api.invoke(verb.method, guard, signal);
    }
  } catch (error) {
    return { kind: "failed", message: pageCommandErrorMessage(verb.method, error) };
  }
  if (receipt.outcome === "accepted") return { kind: "accepted", receipt };
  return {
    kind: receipt.outcome,
    receipt,
    message: pageReceiptMessage(verb.method, receipt.outcome)!,
  };
}
