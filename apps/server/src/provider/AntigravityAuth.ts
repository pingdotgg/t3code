import {
  ProviderSetupError,
  type ProviderAuthState,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as AcpErrors from "effect-acp/errors";

import type { AcpSessionRuntime, AcpSessionRuntimeStartResult } from "./acp/AcpSessionRuntime.ts";
import { parseAntigravityAuthorizationUrl } from "./antigravityAuthSupport.ts";
import {
  forwardAntigravityCallback,
  validateAntigravityCallbackUrl,
  type AntigravityPendingCallback,
} from "./antigravityCallback.ts";
import type { ProviderAuthController } from "./Services/ProviderAuthService.ts";

const AUTH_TIMEOUT_MS = 300_000;
const FORWARDING_FAILED_MESSAGE = "Could not deliver the sign-in response. Start sign-in again.";
const isSetupError = Schema.is(ProviderSetupError);
const isAcpRequestError = Schema.is(AcpErrors.AcpRequestError);

interface AuthSnapshot {
  readonly ownerSessionId: string | null;
  readonly state: ProviderAuthState;
}

interface AuthFlow {
  readonly id: string;
  readonly ownerSessionId: string;
  readonly expiresAtMillis: number;
  state: ProviderAuthState;
  pending: AntigravityPendingCallback | undefined;
  callbackSent: boolean;
  fiber: Fiber.Fiber<void> | undefined;
  forwarding: Fiber.Fiber<void, ProviderSetupError> | undefined;
}

interface OwnedProcess {
  readonly stop: Effect.Effect<void>;
  startup: Fiber.Fiber<unknown, unknown> | undefined;
}

export interface AntigravityAuth {
  readonly controller: ProviderAuthController;
  /** Tracks startup and the process scope so sign-out cannot leave cached credentials in memory. */
  readonly withProcess: <A, E, R>(
    stop: Effect.Effect<void>,
    task: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ProviderSetupError, R | Scope.Scope>;
}

export type AntigravityAuthRuntime = Pick<
  AcpSessionRuntime["Service"],
  "initialize" | "start" | "request"
>;

export interface AntigravityAuthOptions<
  Runtime extends AntigravityAuthRuntime = AcpSessionRuntime["Service"],
> {
  readonly instanceId: ProviderInstanceId;
  readonly makeRuntime: (input: {
    readonly onAuthorizationUrl?: (url: string) => Effect.Effect<void, AcpErrors.AcpError>;
  }) => Effect.Effect<Runtime, AcpErrors.AcpError | ProviderSetupError, Scope.Scope>;
  readonly onAuthenticated: (
    result: AcpSessionRuntimeStartResult,
    runtime: Runtime,
  ) => Effect.Effect<void>;
  readonly onSignedOut: Effect.Effect<void>;
  readonly forwardCallback?: (callback: URL) => Effect.Effect<void, ProviderSetupError>;
  /** False for API key methods, which authenticate without a Google sign-in page. */
  readonly usesBrowser?: boolean;
}

function visibleSnapshot(snapshot: AuthSnapshot, ownerSessionId: string): ProviderAuthState {
  if (snapshot.ownerSessionId === null || snapshot.ownerSessionId === ownerSessionId) {
    return snapshot.state;
  }
  const busy = ["starting", "waiting", "verifying"].includes(snapshot.state.phase);
  return {
    ...snapshot.state,
    flowId: null,
    authorizationUrl: null,
    expiresAt: null,
    ...(busy ? { message: "Sign-in is in progress in another client." } : {}),
  };
}

function safeAuthFailure(cause: Cause.Cause<unknown>, usesBrowser: boolean): string {
  const error = Cause.findErrorOption(cause);
  if (Option.isSome(error)) {
    if (isSetupError(error.value)) {
      return error.value.detail;
    }
    if (isAcpRequestError(error.value)) {
      if (error.value.errorMessage.includes("SUBSCRIPTION_REQUIRED")) {
        return "Google requires an eligible Antigravity subscription for this account.";
      }
      if (/access_denied|denied access|cancelled/i.test(error.value.errorMessage)) {
        return "Google sign-in was not approved. Start sign-in again.";
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

/** Owns one instance's explicit sign-in and all process admission around sign-out. */
export const makeAntigravityAuth = Effect.fn("makeAntigravityAuth")(function* <
  Runtime extends AntigravityAuthRuntime,
>(
  options: AntigravityAuthOptions<Runtime>,
): Effect.fn.Return<AntigravityAuth, never, Crypto.Crypto | Scope.Scope> {
  const crypto = yield* Crypto.Crypto;
  const instanceScope = yield* Scope.Scope;
  const usesBrowser = options.usesBrowser ?? true;
  const lock = yield* Semaphore.make(1);
  const closed = yield* Deferred.make<void>();
  const emptyState: ProviderAuthState = {
    instanceId: options.instanceId,
    phase: "idle",
    flowId: null,
    authorizationUrl: null,
    expiresAt: null,
    message: null,
  };
  const snapshot = yield* SubscriptionRef.make<AuthSnapshot>({
    ownerSessionId: null,
    state: emptyState,
  });
  const processes = new Set<OwnedProcess>();
  let activeFlow: AuthFlow | undefined;
  let operation: "idle" | "auth" | "logout" | "cancel" | "closed" = "idle";

  const setupError = (name: string, detail: string) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation: name, detail });
  const currentState = (ownerSessionId: string) =>
    SubscriptionRef.get(snapshot).pipe(
      Effect.map((value) => visibleSnapshot(value, ownerSessionId)),
    );
  const publishFlow = (flow: AuthFlow, state: ProviderAuthState) => {
    flow.state = state;
    return SubscriptionRef.set(snapshot, { ownerSessionId: flow.ownerSessionId, state });
  };
  const stopOwnedProcesses = Effect.suspend(() =>
    Effect.forEach(
      Array.from(processes),
      (owned) =>
        Effect.gen(function* () {
          if (owned.startup) {
            yield* Fiber.interrupt(owned.startup);
          }
          yield* owned.stop;
        }),
      { discard: true, concurrency: "unbounded" },
    ),
  );

  const withProcess: AntigravityAuth["withProcess"] = (stop, task) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const scope = yield* Scope.Scope;
        const owned: OwnedProcess = { stop, startup: undefined };
        const fiber = yield* lock.withPermits(1)(
          Effect.gen(function* () {
            if (operation !== "idle") {
              return yield* setupError(
                "startProcess",
                "Antigravity sign-in or sign-out is in progress. Try again after it finishes.",
              );
            }
            processes.add(owned);
            yield* Scope.addFinalizer(
              scope,
              Effect.sync(() => {
                processes.delete(owned);
              }),
            );
            const child = yield* restore(task).pipe(Effect.forkIn(scope));
            owned.startup = child;
            return child;
          }),
        );
        // Propagate interruption after the exit wait so concurrent stop waiters stay attached.
        return yield* restore(Fiber.await(fiber)).pipe(
          Effect.flatMap((result) => result),
          Effect.ensuring(Fiber.interrupt(fiber)),
          Effect.ensuring(
            Effect.sync(() => {
              owned.startup = undefined;
            }),
          ),
        );
      }),
    );

  const finishFlow = (flow: AuthFlow, result: Exit.Exit<void, unknown>) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        if (activeFlow !== flow) return;
        activeFlow = undefined;
        operation = "idle";
        flow.pending = undefined;
        yield* publishFlow(flow, {
          ...flow.state,
          phase: Exit.isSuccess(result) ? "succeeded" : "failed",
          authorizationUrl: null,
          expiresAt: null,
          message: Exit.isSuccess(result)
            ? usesBrowser
              ? "Signed in with Google."
              : "Connected to Antigravity."
            : safeAuthFailure(result.cause, usesBrowser),
        });
      }),
    );

  const receiveAuthorizationUrl = (flow: AuthFlow, url: string) =>
    parseAntigravityAuthorizationUrl(url).pipe(
      Effect.flatMap((authorization) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            if (activeFlow !== flow || operation !== "auth") return;
            if (flow.pending) {
              return yield* new AcpErrors.AcpTransportError({
                detail: "Antigravity started more than one Google sign-in request.",
                cause: undefined,
              });
            }
            flow.pending = authorization;
            yield* publishFlow(flow, {
              ...flow.state,
              phase: "waiting",
              authorizationUrl: authorization.authorizationUrl,
              message:
                "Open the Google sign-in link. If you are remote, paste the redirect URL here.",
            });
          }),
        ),
      ),
    );

  const runSignIn = (flow: AuthFlow, stopSessions: Effect.Effect<void, ProviderSetupError>) =>
    Effect.gen(function* () {
      yield* stopSessions.pipe(Effect.ensuring(stopOwnedProcesses));
      const runtime = yield* options.makeRuntime({
        onAuthorizationUrl: (url) => receiveAuthorizationUrl(flow, url),
      });
      const started = yield* runtime.start();
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          if (activeFlow !== flow) return;
          flow.pending = undefined;
          yield* publishFlow(flow, {
            ...flow.state,
            phase: "verifying",
            authorizationUrl: null,
            message: "Checking Antigravity access and models.",
          });
        }),
      );
      yield* options.onAuthenticated(started, runtime);
    }).pipe(
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: AUTH_TIMEOUT_MS,
        orElse: () =>
          Effect.fail(setupError("start", "Google sign-in expired. Start sign-in again.")),
      }),
      Effect.exit,
      Effect.flatMap((result) => finishFlow(flow, result)),
    );

  const stopFlow = (flow: AuthFlow, phase: "cancelled" | "failed", message: string) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const detached = yield* lock.withPermits(1)(
          Effect.gen(function* () {
            if (activeFlow !== flow) return false;
            activeFlow = undefined;
            operation = "cancel";
            flow.pending = undefined;
            yield* publishFlow(flow, {
              ...flow.state,
              phase,
              authorizationUrl: null,
              expiresAt: null,
              message,
            });
            return true;
          }),
        );
        if (!detached) return;
        if (flow.forwarding) yield* Fiber.interrupt(flow.forwarding);
        if (flow.fiber) yield* Fiber.interrupt(flow.fiber);
        yield* lock.withPermits(1)(
          Effect.sync(() => {
            if (operation === "cancel") operation = "idle";
          }),
        );
      }),
    );

  const requireFlow = (ownerSessionId: string, flowId: string, name: string) =>
    Effect.gen(function* () {
      const flow = activeFlow;
      if (!flow || flow.id !== flowId || flow.ownerSessionId !== ownerSessionId) {
        return yield* setupError(name, "This sign-in is no longer active in this client.");
      }
      const now = yield* Clock.currentTimeMillis;
      if (now >= flow.expiresAtMillis) {
        return yield* setupError(name, "Google sign-in expired. Start sign-in again.");
      }
      return flow;
    });

  const controller: ProviderAuthController = {
    start: (ownerSessionId, stopSessions = Effect.void) =>
      lock.withPermits(1)(
        Effect.uninterruptible(
          Effect.gen(function* () {
            if (activeFlow?.ownerSessionId === ownerSessionId && operation === "auth") {
              return activeFlow.state;
            }
            if (operation !== "idle") {
              return yield* setupError("start", "Antigravity setup is already in progress.");
            }
            const flowId = yield* crypto.randomUUIDv4.pipe(
              Effect.mapError(() =>
                setupError("start", "Could not start Google sign-in. Try again."),
              ),
            );
            const expiresAtMillis = (yield* Clock.currentTimeMillis) + AUTH_TIMEOUT_MS;
            const state: ProviderAuthState = {
              ...emptyState,
              phase: "starting",
              flowId,
              expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expiresAtMillis)),
              message: usesBrowser ? "Starting Google sign-in." : "Checking credentials.",
            };
            const flow: AuthFlow = {
              id: flowId,
              ownerSessionId,
              expiresAtMillis,
              state,
              pending: undefined,
              callbackSent: false,
              fiber: undefined,
              forwarding: undefined,
            };
            activeFlow = flow;
            operation = "auth";
            yield* publishFlow(flow, state);
            flow.fiber = yield* runSignIn(flow, stopSessions).pipe(
              Effect.interruptible,
              Effect.forkIn(instanceScope),
            );
            return state;
          }),
        ),
      ),
    complete: Effect.fn("AntigravityAuth.complete")(function* (ownerSessionId, input) {
      const pending = yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const flow = yield* requireFlow(ownerSessionId, input.flowId, "complete");
          if (!flow.pending || flow.callbackSent) {
            return yield* setupError(
              "complete",
              flow.callbackSent
                ? "The sign-in response was already sent. Wait for Google to finish."
                : "Wait for the Google sign-in link before you send a redirect URL.",
            );
          }
          const callback = yield* validateAntigravityCallbackUrl(
            options.instanceId,
            flow.pending,
            input.callbackUrl,
          );
          flow.callbackSent = true;
          yield* publishFlow(flow, {
            ...flow.state,
            phase: "verifying",
            authorizationUrl: null,
            message: "Waiting for Google to finish sign-in.",
          });
          // The instance owns delivery and its failure handling. The RPC that
          // sent the callback may disconnect before Google answers, and the
          // flow must still settle instead of sitting at "verifying" until
          // the deadline.
          const forwarding = yield* (
            options.forwardCallback?.(callback) ??
            forwardAntigravityCallback(options.instanceId, callback)
          ).pipe(
            // stopFlow interrupts this fiber, so it runs from a sibling fiber.
            Effect.tapError(() =>
              stopFlow(flow, "failed", FORWARDING_FAILED_MESSAGE).pipe(
                Effect.forkIn(instanceScope),
              ),
            ),
            Effect.interruptible,
            Effect.forkIn(instanceScope),
          );
          flow.forwarding = forwarding;
          return { flow, forwarding };
        }),
      );
      const forwarded = yield* Fiber.await(pending.forwarding);
      if (Exit.isFailure(forwarded)) {
        return yield* setupError("complete", FORWARDING_FAILED_MESSAGE);
      }
      return pending.flow.state;
    }),
    cancel: Effect.fn("AntigravityAuth.cancel")(function* (ownerSessionId, flowId) {
      const flow = yield* lock.withPermits(1)(requireFlow(ownerSessionId, flowId, "cancel"));
      yield* stopFlow(flow, "cancelled", "Google sign-in was cancelled.");
      return flow.state;
    }),
    logout: Effect.fn("AntigravityAuth.logout")(function* (stopSessions) {
      const task = Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const flow = yield* lock.withPermits(1)(
            Effect.gen(function* () {
              if (operation !== "idle" && operation !== "auth") {
                return yield* setupError("logout", "Antigravity setup is already stopping.");
              }
              operation = "logout";
              const currentFlow = activeFlow;
              activeFlow = undefined;
              if (currentFlow) {
                currentFlow.pending = undefined;
                yield* publishFlow(currentFlow, {
                  ...currentFlow.state,
                  phase: "cancelled",
                  authorizationUrl: null,
                  expiresAt: null,
                  message: "Google sign-in was cancelled by sign-out.",
                });
              }
              return currentFlow;
            }),
          );
          const stopRemaining = Effect.gen(function* () {
            if (flow?.forwarding) yield* Fiber.interrupt(flow.forwarding);
            if (flow?.fiber) yield* Fiber.interrupt(flow.fiber);
            yield* stopOwnedProcesses;
          });
          const result = yield* restore(
            Effect.gen(function* () {
              yield* stopSessions.pipe(Effect.ensuring(stopRemaining));
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
            }).pipe(
              Effect.scoped,
              Effect.timeoutOrElse({
                duration: "30 seconds",
                orElse: () => Effect.fail(setupError("logout", "Antigravity sign-out timed out.")),
              }),
            ),
          ).pipe(Effect.exit);
          yield* lock.withPermits(1)(
            Effect.gen(function* () {
              operation = "idle";
              yield* SubscriptionRef.set(snapshot, {
                ownerSessionId: null,
                state: {
                  ...emptyState,
                  phase: Exit.isSuccess(result) ? "idle" : "failed",
                  message: Exit.isSuccess(result)
                    ? "Signed out of Google."
                    : "Antigravity sign-out failed. Try again.",
                },
              });
            }),
          );
          if (Exit.isFailure(result)) {
            const failure = Cause.findErrorOption(result.cause);
            return yield* Option.isSome(failure) && isSetupError(failure.value)
              ? failure.value
              : setupError("logout", "Antigravity sign-out failed. Try again.");
          }
          return yield* currentState("");
        }),
      );
      const worker = yield* task.pipe(Effect.forkIn(instanceScope));
      return yield* Fiber.await(worker).pipe(Effect.flatMap((result) => result));
    }),
    subscribe: (ownerSessionId) =>
      SubscriptionRef.changes(snapshot).pipe(
        Stream.map((value) => visibleSnapshot(value, ownerSessionId)),
        Stream.interruptWhen(Deferred.await(closed)),
      ),
    isLogoutPrompt: (text, hasAttachments) => !hasAttachments && text.trim() === "/logout",
  };

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      operation = "closed";
      const flow = activeFlow;
      activeFlow = undefined;
      if (flow) {
        flow.pending = undefined;
        if (flow.forwarding) yield* Fiber.interrupt(flow.forwarding);
        if (flow.fiber) yield* Fiber.interrupt(flow.fiber);
      }
      yield* stopOwnedProcesses;
      yield* Deferred.succeed(closed, undefined);
    }),
  );

  return { controller, withProcess };
});
