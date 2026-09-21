import type { SdkCredentialStore, SdkLoginOptions, SdkLoginResult } from "@cursor/sdk";
import {
  ProviderSetupError,
  type ProviderAuthState,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { Cursor, InMemoryCredentialStore } from "./cursorSdk.ts";
import type { ProviderAuthController } from "./Services/ProviderAuthService.ts";

const AUTH_TIMEOUT_MS = 300_000;

interface AuthFlow {
  readonly id: string;
  readonly owner: string;
  fiber?: Fiber.Fiber<void>;
}

export interface CursorAuth {
  readonly controller: ProviderAuthController;
  readonly readApiKey: Effect.Effect<string | undefined, ProviderSetupError>;
  readonly requireApiKey: Effect.Effect<string, ProviderSetupError>;
  readonly usesApiKey: boolean;
  readonly withAccess: <A, E, R>(
    task: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ProviderSetupError, R | Scope.Scope>;
}

export interface CursorAuthOptions {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly apiKey?: string;
  readonly store: SdkCredentialStore;
  readonly onChanged: (signedIn: boolean) => Effect.Effect<void, ProviderSetupError>;
  readonly login?: (options: SdkLoginOptions) => Promise<SdkLoginResult>;
}

/** Each instance owns its browser credential; explicit API keys always take precedence. */
export const makeCursorAuth = Effect.fn("makeCursorAuth")(function* (options: CursorAuthOptions) {
  const scope = yield* Scope.Scope;
  const crypto = yield* Crypto.Crypto;
  const lock = yield* Semaphore.make(1);
  const configuredKey = options.apiKey?.trim() || undefined;
  const emptyState: ProviderAuthState = {
    instanceId: options.instanceId,
    phase: "idle",
    flowId: null,
    authorizationUrl: null,
    expiresAt: null,
    message: null,
  };
  const snapshot = yield* SubscriptionRef.make({ owner: null as string | null, state: emptyState });
  let active: AuthFlow | undefined;
  let operation: "idle" | "login" | "stopping" | "closed" = "idle";
  const sessions = new Set<Scope.Closeable>();

  const publish = (flow: AuthFlow, patch: Partial<ProviderAuthState>) =>
    SubscriptionRef.update(snapshot, (current) => ({
      owner: flow.owner,
      state: { ...current.state, ...patch },
    }));

  const readApiKey = Effect.gen(function* () {
    if (configuredKey) return configuredKey;
    const credentials = yield* Effect.tryPromise({
      try: () => options.store.load(),
      catch: (cause) =>
        new ProviderSetupError({
          instanceId: options.instanceId,
          operation: "credentials",
          detail: "Could not read the Cursor sign-in. Try signing in again.",
          cause,
        }),
    });
    const now = yield* Clock.currentTimeMillis;
    return credentials &&
      (credentials.apiKeyExpiresAtMs === undefined || credentials.apiKeyExpiresAtMs > now)
      ? credentials.apiKey
      : undefined;
  });

  const requireApiKey = Effect.gen(function* () {
    if (operation !== "idle") {
      return yield* new ProviderSetupError({
        instanceId: options.instanceId,
        operation: "credentials",
        detail: "Cursor sign-in or sign-out is in progress. Try again after it finishes.",
      });
    }
    const apiKey = yield* readApiKey;
    if (!apiKey) {
      return yield* new ProviderSetupError({
        instanceId: options.instanceId,
        operation: "credentials",
        detail: "Sign in with Cursor or add CURSOR_API_KEY in provider settings.",
      });
    }
    return apiKey;
  });

  // Keep SDK sessions and one-shot text generation inside instance-owned scopes.
  // Closing admission before draining these scopes prevents cached credentials surviving sign-out.
  const withAccess: CursorAuth["withAccess"] = (task) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const parent = yield* Scope.Scope;
        const child = yield* lock.withPermits(1)(
          Effect.gen(function* () {
            if (operation !== "idle")
              return yield* new ProviderSetupError({
                instanceId: options.instanceId,
                operation: "session",
                detail: "Cursor sign-in or sign-out is in progress. Try again after it finishes.",
              });
            const child = yield* Scope.make();
            sessions.add(child);
            yield* Scope.addFinalizer(
              child,
              Effect.sync(() => {
                sessions.delete(child);
              }),
            );
            yield* Scope.addFinalizer(parent, Scope.close(child, Exit.void));
            return child;
          }),
        );
        const fiber = yield* restore(task).pipe(
          Effect.provideService(Scope.Scope, child),
          Effect.forkIn(child),
        );
        return yield* restore(Fiber.await(fiber)).pipe(
          Effect.flatMap((result) => result),
          Effect.onExit((result) =>
            Exit.isFailure(result) ? Scope.close(child, Exit.void) : Effect.void,
          ),
        );
      }),
    );
  const stopSessionsWithCredentials = Effect.suspend(() =>
    Effect.forEach(Array.from(sessions), (session) => Scope.close(session, Exit.void), {
      discard: true,
      concurrency: "unbounded",
    }),
  );

  const runLogin = (flow: AuthFlow, stopSessions: Effect.Effect<void, ProviderSetupError>) =>
    Effect.gen(function* () {
      yield* stopSessions.pipe(Effect.ensuring(stopSessionsWithCredentials));
      // The SDK first writes into memory. Cancellation must not save a late login result.
      const pendingStore = new InMemoryCredentialStore();
      const urls = yield* Queue.unbounded<string>();
      yield* Queue.take(urls).pipe(
        Effect.flatMap((authorizationUrl) =>
          lock.withPermits(1)(
            Effect.gen(function* () {
              if (active !== flow) return;
              yield* publish(flow, {
                phase: "waiting",
                authorizationUrl,
                message:
                  "Open the Cursor sign-in page and finish signing in. This page updates automatically.",
              });
            }),
          ),
        ),
        Effect.forever,
        Effect.forkScoped,
      );
      yield* Effect.tryPromise({
        try: (signal) =>
          (options.login ?? Cursor.auth.login)({
            openBrowser: false,
            store: pendingStore,
            signal,
            apiKeyName: `T3 Code - ${options.displayName}`,
            onLoginUrl: (authorizationUrl) => {
              if (active === flow) Queue.offerUnsafe(urls, authorizationUrl);
            },
          }),
        catch: (cause) =>
          new ProviderSetupError({
            instanceId: options.instanceId,
            operation: "start",
            detail: "Cursor sign-in failed. Start sign-in again.",
            cause,
          }),
      });
      // Commit and publish together; interrupting a store Promise cannot stop a late write.
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          if (active !== flow) return;
          yield* publish(flow, {
            phase: "verifying",
            authorizationUrl: null,
            message: "Checking Cursor sign-in.",
          });
          yield* Effect.tryPromise({
            try: async () => {
              const credentials = await pendingStore.load();
              if (!credentials) throw new Error("Cursor login did not return credentials");
              await options.store.save(credentials);
            },
            catch: (cause) =>
              new ProviderSetupError({
                instanceId: options.instanceId,
                operation: "start",
                detail: "Could not save the Cursor sign-in. Try again.",
                cause,
              }),
          });
          const verified = yield* options.onChanged(true).pipe(Effect.exit);
          if (Exit.isFailure(verified)) {
            yield* Effect.tryPromise({
              try: () => options.store.clear(),
              catch: (cause) =>
                new ProviderSetupError({
                  instanceId: options.instanceId,
                  operation: "start",
                  detail: "Could not clear the rejected Cursor sign-in. Try signing out.",
                  cause,
                }),
            });
            return yield* Effect.failCause(verified.cause);
          }
          active = undefined;
          operation = "idle";
          yield* publish(flow, {
            phase: "succeeded",
            authorizationUrl: null,
            expiresAt: null,
            message: "Signed in with Cursor.",
          });
        }).pipe(Effect.uninterruptible),
      );
    }).pipe(
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: AUTH_TIMEOUT_MS,
        orElse: () =>
          Effect.fail(
            new ProviderSetupError({
              instanceId: options.instanceId,
              operation: "start",
              detail: "Cursor sign-in expired. Start sign-in again.",
            }),
          ),
      }),
      Effect.exit,
      Effect.flatMap((result) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            if (active !== flow) return;
            active = undefined;
            operation = "idle";
            yield* publish(flow, {
              phase: Exit.isSuccess(result) ? "succeeded" : "failed",
              authorizationUrl: null,
              expiresAt: null,
              message: Exit.isSuccess(result)
                ? "Signed in with Cursor."
                : "Cursor sign-in failed or expired. Start sign-in again.",
            });
          }),
        ),
      ),
    );

  const requireFlow = (owner: string, id: string, name: string) =>
    Effect.gen(function* () {
      if (!active || active.owner !== owner || active.id !== id) {
        return yield* new ProviderSetupError({
          instanceId: options.instanceId,
          operation: name,
          detail: "This sign-in is no longer active in this client.",
        });
      }
      return active;
    });

  const controller: ProviderAuthController = {
    start: (owner, stopSessions = Effect.void) =>
      lock.withPermits(1)(
        Effect.uninterruptible(
          Effect.gen(function* () {
            if (!options.enabled)
              return yield* new ProviderSetupError({
                instanceId: options.instanceId,
                operation: "start",
                detail: "Enable Cursor before signing in.",
              });
            if (configuredKey)
              return yield* new ProviderSetupError({
                instanceId: options.instanceId,
                operation: "start",
                detail:
                  "Remove CURSOR_API_KEY from this provider's environment before using browser sign-in.",
              });
            if (active?.owner === owner && operation === "login") return snapshot.value.state;
            if (operation !== "idle")
              return yield* new ProviderSetupError({
                instanceId: options.instanceId,
                operation: "start",
                detail: "Cursor setup is already in progress.",
              });
            const id = yield* crypto.randomUUIDv4.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderSetupError({
                    instanceId: options.instanceId,
                    operation: "start",
                    detail: "Could not start Cursor sign-in. Try again.",
                    cause,
                  }),
              ),
            );
            const expiresAt = DateTime.formatIso(
              DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + AUTH_TIMEOUT_MS),
            );
            const flow: AuthFlow = { id, owner };
            active = flow;
            operation = "login";
            const state: ProviderAuthState = {
              ...emptyState,
              phase: "starting",
              flowId: id,
              expiresAt,
              message: "Starting Cursor sign-in.",
            };
            yield* SubscriptionRef.set(snapshot, { owner, state });
            flow.fiber = yield* runLogin(flow, stopSessions).pipe(
              Effect.interruptible,
              Effect.forkIn(scope),
            );
            return state;
          }),
        ),
      ),
    complete: () =>
      Effect.fail(
        new ProviderSetupError({
          instanceId: options.instanceId,
          operation: "complete",
          detail: "Finish signing in on the Cursor website. No redirect URL is needed.",
        }),
      ),
    cancel: (owner, id) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const flow = yield* lock.withPermits(1)(
            Effect.gen(function* () {
              const flow = yield* requireFlow(owner, id, "cancel");
              active = undefined;
              operation = "stopping";
              yield* publish(flow, {
                phase: "cancelled",
                authorizationUrl: null,
                expiresAt: null,
                message: "Cursor sign-in was cancelled.",
              });
              return flow;
            }),
          );
          if (flow.fiber) yield* Fiber.interrupt(flow.fiber);
          operation = "idle";
          return snapshot.value.state;
        }),
      ),
    logout: (stopSessions) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const flow = yield* lock.withPermits(1)(
            Effect.gen(function* () {
              if (configuredKey)
                return yield* new ProviderSetupError({
                  instanceId: options.instanceId,
                  operation: "logout",
                  detail:
                    "Remove CURSOR_API_KEY from this provider's environment to disconnect it.",
                });
              if (operation !== "idle" && operation !== "login")
                return yield* new ProviderSetupError({
                  instanceId: options.instanceId,
                  operation: "logout",
                  detail: "Cursor setup is already stopping.",
                });
              operation = "stopping";
              const flow = active;
              active = undefined;
              return flow;
            }),
          );
          const result = yield* Effect.gen(function* () {
            if (flow?.fiber) yield* Fiber.interrupt(flow.fiber);
            yield* stopSessions.pipe(Effect.ensuring(stopSessionsWithCredentials));
            yield* Effect.tryPromise({
              try: () => options.store.clear(),
              catch: (cause) =>
                new ProviderSetupError({
                  instanceId: options.instanceId,
                  operation: "logout",
                  detail: "Could not clear the Cursor sign-in. Try again.",
                  cause,
                }),
            });
            yield* options.onChanged(false);
          }).pipe(Effect.exit);
          operation = "idle";
          const state: ProviderAuthState = {
            ...emptyState,
            phase: Exit.isSuccess(result) ? "idle" : "failed",
            message: Exit.isSuccess(result)
              ? "Signed out of Cursor."
              : "Cursor sign-out failed. Try again.",
          };
          yield* SubscriptionRef.set(snapshot, { owner: null, state });
          if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause);
          return state;
        }),
      ),
    subscribe: (owner) =>
      SubscriptionRef.changes(snapshot).pipe(
        Stream.map((current) => {
          if (current.owner === null || current.owner === owner) return current.state;
          return {
            ...current.state,
            flowId: null,
            authorizationUrl: null,
            expiresAt: null,
            message: active ? "Sign-in is in progress in another client." : current.state.message,
          };
        }),
      ),
    isLogoutPrompt: (text, hasAttachments) => !hasAttachments && text.trim() === "/logout",
  };

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      operation = "closed";
      const flow = active;
      active = undefined;
      if (flow?.fiber) yield* Fiber.interrupt(flow.fiber);
      yield* stopSessionsWithCredentials;
    }),
  );

  return {
    controller,
    readApiKey,
    requireApiKey,
    withAccess,
    usesApiKey: configuredKey !== undefined,
  } satisfies CursorAuth;
});
