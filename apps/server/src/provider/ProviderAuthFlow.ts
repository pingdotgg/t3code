import {
  ProviderSetupError,
  type ProviderAuthInteraction,
  type ProviderAuthMethod,
  type ProviderAuthResponse,
  type ProviderAuthState,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { ProviderAuthController } from "./Services/ProviderAuthService.ts";

export interface ProviderAuthFlowContext {
  readonly flowId: string;
  readonly setInteraction: (
    interaction: ProviderAuthInteraction,
    respond?: (response: ProviderAuthResponse) => Effect.Effect<void, ProviderSetupError>,
  ) => Effect.Effect<void>;
  readonly verifying: Effect.Effect<void>;
}

interface Flow {
  readonly id: string;
  readonly owner: string;
  readonly expiresAt: number;
  fiber?: Fiber.Fiber<void>;
  respond:
    | ((response: ProviderAuthResponse) => Effect.Effect<void, ProviderSetupError>)
    | undefined;
}

/** Adapters do login and credential handling; this owns client consent and flow lifetime. */
export const makeProviderAuthFlow = Effect.fn("makeProviderAuthFlow")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly credentialBinding: NonNullable<ProviderAuthController["credentialBinding"]>;
  readonly methods: Effect.Effect<ReadonlyArray<ProviderAuthMethod>, ProviderSetupError>;
  readonly defaultMethodId?: string;
  readonly authenticate: (
    methodId: string,
    context: ProviderAuthFlowContext,
  ) => Effect.Effect<void, ProviderSetupError, Scope.Scope>;
  readonly logout: Effect.Effect<void, ProviderSetupError>;
  readonly timeoutMs?: number;
}) {
  const scope = yield* Scope.Scope;
  const crypto = yield* Crypto.Crypto;
  const lock = yield* Semaphore.make(1);
  const timeoutMs = options.timeoutMs ?? 300_000;
  const empty: ProviderAuthState = {
    instanceId: options.instanceId,
    phase: "idle",
    flowId: null,
    authorizationUrl: null,
    expiresAt: null,
    message: null,
    interaction: null,
    methods: [],
    credentialOwner: options.credentialBinding.owner,
  };
  const snapshot = yield* SubscriptionRef.make({ owner: null as string | null, state: empty });
  let active: Flow | undefined;
  let operation: "idle" | "auth" | "stopping" | "closed" = "idle";
  const sessions = new Set<Scope.Closeable>();
  const failure = (operation: string, detail: string) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation, detail });
  const stopOwnedSessions = Effect.suspend(() =>
    Effect.forEach(Array.from(sessions), (session) => Scope.close(session, Exit.void), {
      discard: true,
      concurrency: "unbounded",
    }),
  );
  const publish = (flow: Flow, patch: Partial<ProviderAuthState>) =>
    Effect.suspend(() =>
      active === flow
        ? SubscriptionRef.update(snapshot, (current) => ({
            owner: flow.owner,
            state: { ...current.state, ...patch },
          }))
        : Effect.void,
    );

  const requireFlow = Effect.fnUntraced(function* (owner: string, id: string) {
    if (
      !active ||
      active.owner !== owner ||
      active.id !== id ||
      (yield* Clock.currentTimeMillis) >= active.expiresAt
    ) {
      return yield* failure("respond", "This sign-in is no longer active in this client.");
    }
    return active;
  });

  // Discovery initializes the agent without invoking login or creating a session.
  yield* options.methods.pipe(
    Effect.flatMap((methods) =>
      SubscriptionRef.update(snapshot, (current) => ({
        ...current,
        state: { ...current.state, methods },
      })),
    ),
    Effect.catch(() => Effect.void),
    Effect.forkIn(scope),
  );

  const controller: ProviderAuthController = {
    credentialBinding: options.credentialBinding,
    isChangingCredentials: Effect.sync(() => operation !== "idle"),
    withAccess: (task) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const parent = yield* Scope.Scope;
          const child = yield* lock.withPermit(
            Effect.gen(function* () {
              if (operation !== "idle")
                return yield* failure(
                  "session",
                  "Provider sign-in is changing. Try again after it finishes.",
                );
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
      ),
    start: (owner, stopSessions = Effect.void, selectedMethodId) =>
      lock.withPermit(
        Effect.gen(function* () {
          if (operation === "auth" && active?.owner === owner) return snapshot.value.state;
          if (operation !== "idle")
            return yield* failure("start", "Provider setup is already in progress.");
          const id = yield* crypto.randomUUIDv4.pipe(
            Effect.mapError(() => failure("start", "Could not start sign-in. Try again.")),
          );
          const flow: Flow = {
            id,
            owner,
            expiresAt: (yield* Clock.currentTimeMillis) + timeoutMs,
            respond: undefined,
          };
          active = flow;
          operation = "auth";
          const state: ProviderAuthState = {
            ...empty,
            methods: snapshot.value.state.methods ?? [],
            phase: "starting",
            flowId: id,
            expiresAt: DateTime.formatIso(DateTime.makeUnsafe(flow.expiresAt)),
            message: "Starting sign-in.",
          };
          yield* SubscriptionRef.set(snapshot, { owner, state });
          flow.fiber = yield* Effect.gen(function* () {
            const methods = yield* options.methods;
            yield* publish(flow, { methods });
            const methodId = selectedMethodId ?? options.defaultMethodId ?? methods[0]?.id;
            if (!methodId || !methods.some((method) => method.id === methodId))
              return yield* failure("start", "The provider did not advertise this sign-in method.");
            yield* stopSessions.pipe(Effect.ensuring(stopOwnedSessions));
            yield* options.authenticate(methodId, {
              flowId: id,
              setInteraction: (interaction, respond) =>
                Effect.gen(function* () {
                  if (active !== flow) return;
                  flow.respond = respond;
                  yield* publish(flow, {
                    phase: "waiting",
                    interaction,
                    authorizationUrl:
                      interaction.type === "browser" || interaction.type === "deviceCode"
                        ? interaction.url
                        : null,
                    message: "Complete sign-in to continue.",
                  });
                }),
              verifying: Effect.gen(function* () {
                flow.respond = undefined;
                yield* publish(flow, {
                  phase: "verifying",
                  interaction: null,
                  authorizationUrl: null,
                  message: "Checking provider sign-in.",
                });
              }),
            });
          }).pipe(
            Effect.scoped,
            Effect.timeoutOrElse({
              duration: timeoutMs,
              orElse: () => Effect.fail(failure("start", "Sign-in expired. Start again.")),
            }),
            Effect.exit,
            Effect.flatMap((result) =>
              lock.withPermit(
                Effect.gen(function* () {
                  if (active !== flow) return;
                  yield* publish(flow, {
                    phase: Exit.isSuccess(result) ? "succeeded" : "failed",
                    interaction: null,
                    authorizationUrl: null,
                    expiresAt: null,
                    message: Exit.isSuccess(result)
                      ? "Sign-in complete."
                      : "Sign-in failed or expired. Start again.",
                  });
                  active = undefined;
                  operation = "idle";
                }),
              ),
            ),
            Effect.interruptible,
            Effect.forkIn(scope),
          );
          return state;
        }).pipe(Effect.uninterruptible),
      ),
    respond: (owner, input) =>
      lock.withPermit(
        Effect.gen(function* () {
          const flow = yield* requireFlow(owner, input.flowId);
          const interaction = snapshot.value.state.interaction;
          if (
            !interaction ||
            interaction.id !== input.interactionId ||
            interaction.type !== input.response.type ||
            !flow.respond
          )
            return yield* failure("respond", "This sign-in interaction is no longer available.");
          yield* flow.respond(input.response);
          return snapshot.value.state;
        }),
      ),
    complete: () =>
      Effect.fail(failure("complete", "This provider does not accept a pasted redirect URL.")),
    cancel: (owner, id) =>
      Effect.gen(function* () {
        const flow = yield* lock.withPermit(
          Effect.gen(function* () {
            const flow = yield* requireFlow(owner, id);
            yield* publish(flow, {
              phase: "cancelled",
              interaction: null,
              authorizationUrl: null,
              expiresAt: null,
              message: "Sign-in cancelled.",
            });
            active = undefined;
            operation = "stopping";
            return flow;
          }),
        );
        if (flow.fiber) yield* Fiber.interrupt(flow.fiber);
        operation = "idle";
        return snapshot.value.state;
      }).pipe(Effect.uninterruptible),
    logout: (stopSessions) =>
      Effect.gen(function* () {
        const flow = yield* lock.withPermit(
          Effect.gen(function* () {
            if (operation !== "idle" && operation !== "auth")
              return yield* failure("logout", "Provider setup is already stopping.");
            operation = "stopping";
            const flow = active;
            active = undefined;
            return flow;
          }),
        );
        const result = yield* Effect.gen(function* () {
          if (flow?.fiber) yield* Fiber.interrupt(flow.fiber);
          yield* stopSessions.pipe(Effect.ensuring(stopOwnedSessions));
          yield* options.logout;
        }).pipe(Effect.exit);
        operation = "idle";
        const state: ProviderAuthState = {
          ...empty,
          methods: snapshot.value.state.methods ?? [],
          phase: Exit.isSuccess(result) ? "idle" : "failed",
          message: Exit.isSuccess(result) ? "Signed out." : "Could not sign out. Try again.",
        };
        yield* SubscriptionRef.set(snapshot, { owner: null, state });
        if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause);
        return state;
      }).pipe(Effect.uninterruptible),
    subscribe: (owner) =>
      SubscriptionRef.changes(snapshot).pipe(
        Stream.map((current) =>
          current.owner === null || current.owner === owner
            ? current.state
            : {
                ...current.state,
                flowId: null,
                authorizationUrl: null,
                interaction: null,
                expiresAt: null,
                message: active
                  ? "Sign-in is in progress in another client."
                  : current.state.message,
              },
        ),
      ),
  };
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      operation = "closed";
      const flow = active;
      active = undefined;
      if (flow?.fiber) yield* Fiber.interrupt(flow.fiber);
      yield* stopOwnedSessions;
    }),
  );
  return controller;
});
