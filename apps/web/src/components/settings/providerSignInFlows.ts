/**
 * Fork-owned presentation logic for provider account sign-in (fork f1).
 *
 * Pure so the one genuinely subtle decision — browser handoff vs device code —
 * is unit-tested instead of buried in a dialog.
 *
 * @module components/settings/providerSignInFlows
 */
import {
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type EnvironmentId,
  type ProviderSignInEvent,
  type ProviderSignInMode,
  type ServerProvider,
} from "@t3tools/contracts";

/**
 * Which mode to offer first.
 *
 * The gate is **environment identity, not capability sniffing**. `codex
 * app-server` mints the browser `authUrl` itself and its OAuth redirect
 * terminates on the machine running that process — `V2LoginAccountParams` has
 * no callback host or port. So the browser flow can only complete when the
 * user's browser and the t3 server are the same machine: a desktop client
 * pointed at the primary local environment. Every other surface — a paired web
 * client, app.t3.codes, mobile, a relay environment — must default to the
 * device code, which works from anywhere.
 *
 * Sniffing `openExternal` availability is not an option: on web it falls
 * through to `window.open` and discards the result, so there is nothing to
 * detect.
 */
export function defaultSignInMode(input: {
  readonly environmentId: EnvironmentId | null;
  readonly hasDesktopBridge: boolean;
}): ProviderSignInMode {
  return input.hasDesktopBridge && input.environmentId === PRIMARY_LOCAL_ENVIRONMENT_ID
    ? "browser"
    : "deviceCode";
}

export function otherSignInMode(mode: ProviderSignInMode): ProviderSignInMode {
  return mode === "browser" ? "deviceCode" : "browser";
}

/** Label for the persistent "use the other mode instead" action. */
export function switchSignInModeLabel(mode: ProviderSignInMode): string {
  return mode === "browser" ? "Use a device code instead" : "Use the browser instead";
}

/** Modes a provider snapshot says it can drive from inside the app. */
export function providerSignInModes(
  provider: ServerProvider | undefined,
): ReadonlyArray<ProviderSignInMode> {
  return provider?.authMethods ?? [];
}

/**
 * Whether to render any sign-in affordance at all. An upstream server, or a
 * driver with no native login, reports no methods and the UI stays as it was.
 */
export function supportsInAppSignIn(provider: ServerProvider | undefined): boolean {
  return providerSignInModes(provider).length > 0;
}

export function signInActionLabel(provider: ServerProvider | undefined): string {
  return provider?.auth.status === "authenticated" ? "Switch account" : "Sign in";
}

export type ProviderSignInPhase =
  | "idle"
  | "starting"
  | "browserHandoff"
  | "deviceCode"
  | "completed"
  | "failed";

export interface ProviderSignInPresentation {
  readonly phase: ProviderSignInPhase;
  readonly title: string;
  readonly body: string;
  /** Present in the browser-handoff phase. */
  readonly authUrl?: string;
  /** Present in the device-code phase. */
  readonly userCode?: string;
  readonly verificationUrl?: string;
  readonly failureMessage?: string;
  /** True while the dialog should show a "waiting for confirmation" row. */
  readonly waiting: boolean;
}

/**
 * Map the latest stream event onto exactly one dialog state. `undefined` means
 * the stream has not produced anything yet (or has not been started).
 */
export function describeSignInEvent(
  event: ProviderSignInEvent | undefined,
  context: { readonly providerName: string; readonly mode: ProviderSignInMode },
): ProviderSignInPresentation {
  if (event === undefined) {
    return {
      phase: "starting",
      title: `Contacting ${context.providerName}…`,
      body: "Starting the sign-in.",
      waiting: true,
    };
  }

  switch (event._tag) {
    case "started":
      return {
        phase: "starting",
        title: `Contacting ${context.providerName}…`,
        body:
          context.mode === "browser"
            ? "Preparing a browser sign-in link."
            : "Requesting a device code.",
        waiting: true,
      };
    case "browserHandoff":
      return {
        phase: "browserHandoff",
        title: "Finish signing in in your browser",
        body: "We opened the sign-in page for you. If nothing happened, open the link below.",
        authUrl: event.authUrl,
        waiting: true,
      };
    case "deviceCode":
      return {
        phase: "deviceCode",
        title: "Enter this code to sign in",
        body: "Open the page below on any device and enter the code.",
        userCode: event.userCode,
        verificationUrl: event.verificationUrl,
        waiting: true,
      };
    case "completed":
      return {
        phase: "completed",
        title: "Signed in",
        body: `${context.providerName} is ready to use.`,
        waiting: false,
      };
    case "failed":
      return {
        phase: "failed",
        title: "Sign-in failed",
        body: event.message.trim().length > 0 ? event.message : "The sign-in did not complete.",
        failureMessage: event.message,
        waiting: false,
      };
  }
}

/**
 * Two-step inline confirm for sign-out, ported from 2code: the label swaps and
 * reverts after a few seconds rather than opening a second modal.
 */
export const SIGN_OUT_CONFIRM_TIMEOUT_MS = 5_000;

/**
 * fork: f1 F-22 — how long "Contacting…" may last before the dialog gives up.
 *
 * The stream has no error path for an unreachable environment: `followStream`
 * turns an `acquireSupervisor` failure into an EMPTY stream, so `events.data`
 * stays `undefined` and `events.error` stays `null` forever. Without a deadline
 * the dialog spins indefinitely with no retry button rendered.
 */
export const SIGN_IN_START_TIMEOUT_MS = 20_000;

export function signOutButtonLabel(armed: boolean, pending = false): string {
  if (pending) return "Signing out…";
  return armed ? "Confirm sign-out" : "Sign out";
}
