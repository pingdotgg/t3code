import { ProviderSetupError, type ProviderInstanceId } from "@lathe/contracts";
import * as Cause from "effect/Cause";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as AcpErrors from "effect-acp/errors";

import { AuthRelayError } from "../auth-relay/AuthRelayError.ts";
import type { LoopbackCallbackDelivery } from "../auth-relay/loopbackCallback.ts";
import {
  makeAuthRelayFlow,
  type AuthRelayFlow,
  type AuthRelaySignInHandle,
  type PendingAuthorization,
} from "../auth-relay/AuthRelayFlow.ts";
import type * as AcpSessionRuntime from "@lathe/provider-acp/server/AcpSessionRuntime";
import {
  antigravityLoginResponse,
  parseAntigravityAuthorizationUrl,
  type AntigravityAuthorizationUrl,
} from "./antigravityAuthSupport.ts";
import { validateAntigravityCallbackUrl } from "./antigravityCallback.ts";

// Once initialized, a healthy agent shows the Google link within seconds; its bundled Python has no
// IPv4 fallback, so broken IPv6 stalls each Google request. The hint is timed from initialize: the
// one-file runtime unpacks on every launch (about a minute on Windows) before it answers initialize.
const NO_RESPONSE_HINT_MS = 30_000;
const NOT_RESPONDING_MESSAGE =
  "Antigravity did not respond. Its runtime may not run on this machine.";
const NO_RESPONSE_MESSAGE =
  "Antigravity has not reached Google after 30 seconds. Check this machine's network connection. Broken IPv6 is a common cause.";
const UNREACHABLE_MESSAGE =
  "Antigravity could not reach Google. Check this machine's network connection, then start sign-in again.";
const isSetupError = Schema.is(ProviderSetupError);
const isAcpRequestError = Schema.is(AcpErrors.AcpRequestError);
const isAcpProcessExitedError = Schema.is(AcpErrors.AcpProcessExitedError);

/** The generic relay flow, driven by Antigravity's ACP runtime. */
export interface AntigravityAuth extends AuthRelayFlow {
  /** A session started outside a flow, so an earlier flow's failure no longer describes sign-in. */
  readonly onSignedInElsewhere: Effect.Effect<void>;
}

/** `agy acp --login`: it prints a Google link and reads the code the Antigravity page shows. */
export interface AntigravityCodeLogin {
  readonly submit: (response: string) => Effect.Effect<void>;
  /** Succeeds once the runtime has stored the sign-in. */
  readonly completed: Effect.Effect<void, ProviderSetupError>;
}

export type AntigravityAuthRuntime = Pick<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  "initialize" | "start" | "request"
>;

export interface AntigravityAuthOptions<
  Runtime extends AntigravityAuthRuntime = AcpSessionRuntime.AcpSessionRuntime["Service"],
> {
  readonly instanceId: ProviderInstanceId;
  readonly makeRuntime: (input: {
    readonly onAuthorizationUrl?: (url: string) => Effect.Effect<void, AcpErrors.AcpError>;
  }) => Effect.Effect<Runtime, AcpErrors.AcpError | ProviderSetupError, Scope.Scope>;
  readonly onAuthenticated: (
    result: AcpSessionRuntime.AcpSessionRuntimeStartResult,
    runtime: Runtime,
  ) => Effect.Effect<void>;
  readonly onSignedOut: Effect.Effect<void>;
  readonly forwardCallback?: (callback: URL) => Effect.Effect<void, ProviderSetupError>;
  readonly usesBrowser?: boolean;
  /** Undefined when the runtime signs in through ACP `authenticate` and Lathe's browser helper. */
  readonly codeLogin?: (input: {
    readonly onAuthorizationUrl: (url: string) => Effect.Effect<void, AcpErrors.AcpError>;
  }) => Effect.Effect<
    AntigravityCodeLogin | undefined,
    AcpErrors.AcpError | ProviderSetupError,
    Scope.Scope
  >;
}

function safeAuthFailure(cause: Cause.Cause<unknown>, usesBrowser: boolean): string {
  const error = Cause.findErrorOption(cause);
  if (Option.isSome(error)) {
    if (isSetupError(error.value)) {
      return error.value.detail;
    }
    if (isAcpProcessExitedError(error.value)) {
      const { code, signal } = error.value;
      const reason =
        signal !== undefined
          ? ` after signal ${signal}`
          : code !== undefined
            ? ` with code ${code}`
            : "";
      return `Antigravity exited unexpectedly${reason}. Start sign-in again.`;
    }
    if (isAcpRequestError(error.value)) {
      if (error.value.errorMessage.includes("SUBSCRIPTION_REQUIRED")) {
        return "Google requires an eligible Antigravity subscription for this account.";
      }
      if (/access_denied|denied access|cancelled/i.test(error.value.errorMessage)) {
        return "Google sign-in was not approved. Start sign-in again.";
      }
      if (error.value.method === "session/new" && error.value.code === -32603) {
        return "Antigravity authenticated, but could not initialize a session or load models.";
      }
      if (!usesBrowser && error.value.code === -32602) {
        return "Antigravity rejected the configured credentials. Check the provider settings.";
      }
    }
  }
  return usesBrowser
    ? "Google sign-in failed. Start sign-in again."
    : "Antigravity could not authenticate with the configured credentials.";
}

/**
 * Owns one instance's explicit sign-in and all process admission around
 * sign-out. The ACP process owns token exchange and storage; Lathe relays the
 * Google callback to the process's loopback listener, or hands the code from
 * the Antigravity page to `agy acp --login`.
 */
export const makeAntigravityAuth = Effect.fn("makeAntigravityAuth")(function* <
  Runtime extends AntigravityAuthRuntime,
>(
  options: AntigravityAuthOptions<Runtime>,
): Effect.fn.Return<AntigravityAuth, never, SecureRandom.SecureRandom | Scope.Scope> {
  const usesBrowser = options.usesBrowser ?? true;
  const setupError = (name: string, detail: string) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation: name, detail });
  const invalidCode = () =>
    new AuthRelayError({
      operation: "complete",
      detail: "Paste the code from the Antigravity page, or that page's full URL.",
    });
  // The relay runs one sign-in at a time, so the current one's mode lives here.
  let redirect: "loopback" | "code" = "loopback";
  let initialized = false;
  let codePending: AntigravityAuthorizationUrl | undefined;
  let submitLoginCode: ((response: string) => Effect.Effect<void>) | undefined;
  const toAcpError = (error: AuthRelayError) =>
    new AcpErrors.AcpTransportError({ detail: error.detail, cause: undefined });

  const relay = yield* makeAuthRelayFlow<AcpErrors.AcpError | ProviderSetupError>({
    instanceId: options.instanceId,
    copy: {
      starting: usesBrowser ? "Starting Google sign-in." : "Checking credentials.",
      get waiting() {
        return redirect === "loopback"
          ? "Open the Google sign-in link. If you are remote, paste the redirect URL here."
          : "Open the Google sign-in link, then paste the code from the Antigravity page here.";
      },
      waitingForDeviceCode: "Open the Google sign-in link and enter the code.",
      verifyingCallback: "Waiting for Google to finish sign-in.",
      succeeded: usesBrowser ? "Signed in with Google." : "Connected to Antigravity.",
      expired: "Google sign-in expired. Start sign-in again.",
      cancelled: "Google sign-in was cancelled.",
      cancelledBySignOut: "Google sign-in was cancelled by sign-out.",
      signedOut: "Signed out of Google.",
      signOutFailed: "Antigravity sign-out failed. Try again.",
      signOutTimedOut: "Antigravity sign-out timed out.",
      busy: "Antigravity setup is already in progress.",
      processBusy: "Antigravity sign-in or sign-out is in progress. Try again after it finishes.",
      noResponse: { afterMs: NO_RESPONSE_HINT_MS, message: NO_RESPONSE_MESSAGE, fromReady: true },
      get unreachable() {
        return initialized ? UNREACHABLE_MESSAGE : NOT_RESPONDING_MESSAGE;
      },
      describeFailure: (cause) => safeAuthFailure(cause, usesBrowser),
    },
    parseAuthorizationUrl: (url) =>
      parseAntigravityAuthorizationUrl(url, redirect).pipe(
        Effect.map((authorization): PendingAuthorization => {
          if (redirect === "code") {
            codePending = authorization;
            return {
              authorizationUrl: authorization.authorizationUrl,
              completion: { kind: "code", state: authorization.state },
            };
          }
          return {
            authorizationUrl: authorization.authorizationUrl,
            completion: {
              kind: "loopback",
              callback: { redirectUri: authorization.redirectUri, state: authorization.state },
            },
          };
        }),
        Effect.mapError(
          () =>
            new AuthRelayError({
              operation: "start",
              detail: "Antigravity returned an invalid Google sign-in URL.",
            }),
        ),
      ),
    signIn: Effect.fn("AntigravityAuth.signIn")(function* (handle: AuthRelaySignInHandle) {
      redirect = "code";
      initialized = false;
      codePending = undefined;
      submitLoginCode = undefined;
      const signedIn = yield* Effect.scoped(
        Effect.gen(function* () {
          const login = yield* (
            options.codeLogin?.({
              onAuthorizationUrl: (url) =>
                handle.receiveAuthorizationUrl(url).pipe(Effect.mapError(toAcpError)),
            }) ?? Effect.undefined
          );
          if (login === undefined) return false;
          submitLoginCode = login.submit;
          yield* login.completed;
          return true;
        }),
      );
      redirect = "loopback";
      const runtime = yield* options.makeRuntime(
        signedIn
          ? {}
          : {
              onAuthorizationUrl: (url) =>
                handle.receiveAuthorizationUrl(url).pipe(Effect.mapError(toAcpError)),
            },
      );
      // `start` reuses this memoized handshake.
      yield* runtime.initialize();
      initialized = true;
      yield* handle.ready;
      const started = yield* runtime.start();
      yield* handle.verifying("Checking Antigravity access and models.");
      yield* options.onAuthenticated(started, runtime);
    }),
    submitCode: (pasted) =>
      Effect.suspend(() => {
        const response =
          codePending === undefined
            ? undefined
            : antigravityLoginResponse(codePending, pasted.code);
        return response === undefined || submitLoginCode === undefined
          ? Effect.fail(invalidCode())
          : submitLoginCode(response);
      }),
    signOut: Effect.gen(function* () {
      const runtime = yield* options.makeRuntime({});
      const initialized = yield* runtime.initialize();
      if (!initialized.agentCapabilities?.auth?.logout) {
        return yield* setupError(
          "logout",
          "This Antigravity version does not support sign-out. Update the provider.",
        );
      }
      yield* runtime.request("logout", {});
      yield* options.onSignedOut;
    }),
    validateCallback: validateAntigravityCallbackUrl,
    ...(options.forwardCallback
      ? {
          // Google's callback is always a GET; the URL is all the Antigravity replay needs.
          forwardCallback: (delivery: LoopbackCallbackDelivery) =>
            options.forwardCallback!(delivery.url).pipe(
              Effect.mapError(
                (error) => new AuthRelayError({ operation: "complete", detail: error.detail }),
              ),
            ),
        }
      : {}),
    isLogoutPrompt: (text, hasAttachments) => !hasAttachments && text.trim() === "/logout",
  });

  // The relay does not yet clear a stale failure when a session starts outside a flow.
  return { ...relay, onSignedInElsewhere: Effect.void };
});
