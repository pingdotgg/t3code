/**
 * Pure transition table for a Codex `account/login/*` handshake (fork f1).
 *
 * Lives outside `CodexAccountService.ts` so the ordering rules that are easy
 * to get wrong — the `account/login/completed` notification racing ahead of
 * the `account/login/start` response, terminal states swallowing late events,
 * a timeout landing after success — are testable without a subprocess, a
 * clock, or an Effect runtime.
 *
 * @module provider/Drivers/codexLoginState
 */
import type { ProviderSignInEvent, ProviderSignInMode } from "@t3tools/contracts";
import type * as CodexSchema from "effect-codex-app-server/schema";

export type CodexLoginState =
  /** Before `account/login/start` has been issued. */
  | { readonly _tag: "starting" }
  /** `type: "chatgpt"` accepted; the user must finish in a browser. */
  | {
      readonly _tag: "awaitingBrowser";
      readonly loginId: string;
      readonly authUrl: string;
    }
  /** `type: "chatgptDeviceCode"` accepted; the user must enter `userCode`. */
  | {
      readonly _tag: "awaitingDeviceCode";
      readonly loginId: string;
      readonly userCode: string;
      readonly verificationUrl: string;
    }
  | { readonly _tag: "completed" }
  | { readonly _tag: "failed"; readonly message: string };

export type CodexLoginEvent =
  | {
      readonly _tag: "loginStartResponse";
      readonly response: CodexSchema.V2LoginAccountResponse;
    }
  | {
      readonly _tag: "loginCompletedNotification";
      readonly notification: CodexSchema.V2AccountLoginCompletedNotification;
    }
  /** The app-server child died (or the request failed) mid-handshake. */
  | { readonly _tag: "aborted"; readonly detail: string }
  /** `LOGIN_TIMEOUT_MS` elapsed without a terminal notification. */
  | { readonly _tag: "timedOut" };

export const initialLoginState: CodexLoginState = { _tag: "starting" };

export function isTerminalLoginState(state: CodexLoginState): boolean {
  return state._tag === "completed" || state._tag === "failed";
}

/**
 * The `loginId` minted by `account/login/start`, once known. Used by the
 * stream finalizer to send `account/login/cancel`; `undefined` means there is
 * nothing to cancel yet.
 */
export function loginIdOf(state: CodexLoginState): string | undefined {
  return state._tag === "awaitingBrowser" || state._tag === "awaitingDeviceCode"
    ? state.loginId
    : undefined;
}

/**
 * The Codex `account/login/start` params for one of our two modes.
 *
 * Both optional `chatgpt` fields (`appBrand`, `useHostedLoginSuccessPage`) are
 * deliberately omitted so the handshake matches whatever the installed codex
 * CLI does by default. Note there is no callback host/port parameter at all:
 * the redirect terminates on the machine running the app-server, which is why
 * `browser` is only ever the default for the primary local desktop.
 */
export function loginStartParams(mode: ProviderSignInMode): CodexSchema.V2LoginAccountParams {
  return mode === "browser" ? { type: "chatgpt" } : { type: "chatgptDeviceCode" };
}

function failedNotificationMessage(
  notification: CodexSchema.V2AccountLoginCompletedNotification,
): string {
  const error = notification.error?.trim();
  return error && error.length > 0 ? error : "Sign-in did not complete.";
}

/**
 * Fold one protocol event into the login state.
 *
 * Rules, in the order they matter:
 *
 *  1. **Terminal states are absorbing.** A late notification, abort, or
 *     timeout after `completed`/`failed` changes nothing — this is what keeps
 *     a process-exit finalizer from overwriting a successful login.
 *  2. **`loginCompletedNotification` is accepted in `starting`.** The
 *     notification can arrive before the request response; dropping it there
 *     would hang the stream until the timeout.
 *  3. **A notification for a different `loginId` is ignored.** The child is
 *     dedicated to one login, so this only fires on a protocol oddity, but it
 *     must not resolve the wrong handshake.
 *  4. **A start response we did not ask for fails closed.** `apiKey`,
 *     `chatgptAuthTokens` and `amazonBedrock` are deliberately not offered.
 */
export function nextLoginState(prev: CodexLoginState, event: CodexLoginEvent): CodexLoginState {
  if (isTerminalLoginState(prev)) {
    return prev;
  }

  switch (event._tag) {
    case "loginStartResponse": {
      // A response arriving after the notification already resolved the login
      // is handled by rule 1 above; here `prev` is still `starting`.
      switch (event.response.type) {
        case "chatgpt":
          return {
            _tag: "awaitingBrowser",
            loginId: event.response.loginId,
            authUrl: event.response.authUrl,
          };
        case "chatgptDeviceCode":
          return {
            _tag: "awaitingDeviceCode",
            loginId: event.response.loginId,
            userCode: event.response.userCode,
            verificationUrl: event.response.verificationUrl,
          };
        default:
          return {
            _tag: "failed",
            message: `Codex returned an unsupported sign-in type: ${event.response.type}.`,
          };
      }
    }
    case "loginCompletedNotification": {
      const expectedLoginId = loginIdOf(prev);
      const notifiedLoginId = event.notification.loginId ?? undefined;
      if (
        expectedLoginId !== undefined &&
        notifiedLoginId !== undefined &&
        notifiedLoginId !== expectedLoginId
      ) {
        return prev;
      }
      return event.notification.success
        ? { _tag: "completed" }
        : { _tag: "failed", message: failedNotificationMessage(event.notification) };
    }
    case "aborted":
      return { _tag: "failed", message: event.detail };
    case "timedOut":
      return {
        _tag: "failed",
        message: "Timed out waiting for the sign-in to complete.",
      };
  }
}

/**
 * The wire event a state transition should emit, or `null` when the state did
 * not change in a way the client can observe. `starting` never emits here —
 * the service emits `started` once, up front.
 */
export function loginStateSignInEvent(state: CodexLoginState): ProviderSignInEvent | null {
  switch (state._tag) {
    case "starting":
      return null;
    case "awaitingBrowser":
      return { _tag: "browserHandoff", authUrl: state.authUrl };
    case "awaitingDeviceCode":
      return {
        _tag: "deviceCode",
        userCode: state.userCode,
        verificationUrl: state.verificationUrl,
      };
    case "completed":
      return { _tag: "completed" };
    case "failed":
      return { _tag: "failed", message: state.message };
  }
}
