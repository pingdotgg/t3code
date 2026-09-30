import {
  ProviderSetupError,
  type ProviderAuthState,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { ProviderAuthController } from "../Services/ProviderAuthService.ts";
import type { FirefoxChatGPT } from "./FirefoxChatGPT.ts";

export const makeChatGPTAuth = Effect.fn("makeChatGPTAuth")(function* (
  instanceId: ProviderInstanceId,
  browser: Pick<FirefoxChatGPT, "signIn" | "signOut" | "hasSession">,
) {
  const scope = yield* Scope.Scope;
  const lock = yield* Semaphore.make(1);
  const empty: ProviderAuthState = {
    instanceId,
    phase: "idle",
    flowId: null,
    authorizationUrl: null,
    expiresAt: null,
    message: "Sign in through Firefox on this environment's desktop.",
  };
  const state = yield* SubscriptionRef.make(empty);
  let owner: string | undefined;
  let worker: Fiber.Fiber<void> | undefined;
  let generation = 0;
  const error = (operation: string, detail: string) =>
    new ProviderSetupError({ instanceId, operation, detail });
  const stop = Effect.gen(function* () {
    if (worker) yield* Fiber.interrupt(worker);
    worker = undefined;
  });
  const controller: ProviderAuthController = {
    credentialBinding: { owner: "t3", key: `chatgpt-web:${instanceId}` },
    start: (ownerSessionId, stopSessions) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* SubscriptionRef.get(state);
          if (current.phase === "waiting")
            return yield* error("start", "Sign-in is already in progress.");
          if (stopSessions) yield* stopSessions;
          owner = ownerSessionId;
          const flowId = `firefox-${++generation}`;
          const waiting: ProviderAuthState = {
            ...empty,
            flowId,
            phase: "waiting",
            message:
              "Finish signing in in the Firefox window on this environment's desktop. It switches to background mode automatically.",
          };
          yield* SubscriptionRef.set(state, waiting);
          worker = yield* Effect.tryPromise({
            try: (signal) => browser.signIn(signal),
            catch: (cause) =>
              error("start", cause instanceof Error ? cause.message : "Firefox sign-in failed."),
          }).pipe(
            Effect.matchEffect({
              onSuccess: () =>
                SubscriptionRef.set(state, {
                  ...waiting,
                  phase: "succeeded",
                  message: "Signed in. Firefox is ready for model requests.",
                }),
              onFailure: (cause) =>
                SubscriptionRef.set(state, { ...waiting, phase: "failed", message: cause.detail }),
            }),
            Effect.forkIn(scope),
          );
          return waiting;
        }),
      ),
    complete: () =>
      Effect.fail(
        error("complete", "Finish sign-in in the Firefox window; no callback URL is needed."),
      ),
    cancel: (ownerSessionId, flowId) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* SubscriptionRef.get(state);
          if (owner !== ownerSessionId || current.flowId !== flowId)
            return yield* error("cancel", "This sign-in belongs to another client or has expired.");
          yield* stop;
          const cancelled: ProviderAuthState = {
            ...empty,
            phase: "cancelled",
            message: "Sign-in cancelled.",
          };
          yield* SubscriptionRef.set(state, cancelled);
          return cancelled;
        }),
      ),
    logout: (stopSessions) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          yield* stop;
          yield* stopSessions;
          yield* Effect.tryPromise({
            try: () => browser.signOut(),
            catch: () => error("logout", "Could not remove the saved Firefox session."),
          });
          yield* SubscriptionRef.set(state, empty);
          return empty;
        }),
      ),
    subscribe: (ownerSessionId) =>
      SubscriptionRef.changes(state).pipe(
        Stream.map((current) =>
          owner === undefined || owner === ownerSessionId
            ? current
            : {
                ...current,
                flowId: null,
                message: ["waiting", "starting", "verifying"].includes(current.phase)
                  ? "Sign-in is in progress in another client."
                  : current.message,
              },
        ),
      ),
  };
  return { controller, changes: SubscriptionRef.changes(state) };
});
