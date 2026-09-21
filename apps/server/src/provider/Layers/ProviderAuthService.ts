import {
  ProviderSetupError,
  type ProviderInstanceId,
  type ProviderSessionId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";

import { ProviderSessionManagerV2 } from "../../orchestration-v2/ProviderSessionManager.ts";
import { ProjectionStoreV2 } from "../../orchestration-v2/ProjectionStore.ts";
import { ProviderAuthService } from "../Services/ProviderAuthService.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";

export const makeProviderAuthService = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry;
  const projections = yield* ProjectionStoreV2;
  const providerSessions = yield* ProviderSessionManagerV2;
  const credentialChanges = yield* Semaphore.make(1);

  const getController = Effect.fn("ProviderAuthService.getController")(function* (
    instanceId: ProviderInstanceId,
    operation: string,
  ) {
    const instance = yield* registry.getInstance(instanceId);
    if (!instance?.auth) {
      return yield* new ProviderSetupError({
        instanceId,
        operation,
        detail: instance
          ? "This provider does not support sign-in in T3 Code."
          : "This provider instance is no longer available.",
      });
    }
    return instance.auth;
  });

  // Native sessions may still belong to the previous provider after the
  // selected model changes. Read session bindings, not the selected model,
  // when invalidating credentials for sign-in or sign-out.
  const stopSessions = Effect.fn("ProviderAuthService.stopSessions")(function* (
    instanceId: ProviderInstanceId,
  ) {
    const failure = (detail: string) =>
      new ProviderSetupError({ instanceId, operation: "stopSessions", detail });
    const target = yield* registry.getInstance(instanceId);
    const binding = target?.auth?.credentialBinding;
    const affectedIds = new Set(
      binding === undefined
        ? [instanceId]
        : (yield* registry.listInstances)
            .filter(
              (instance) =>
                instance.auth?.credentialBinding?.key === binding.key &&
                instance.auth.credentialBinding.owner === binding.owner,
            )
            .map((instance) => instance.instanceId),
    );
    if (binding) {
      yield* Effect.forEach(
        (yield* registry.listInstances).filter(
          (instance) => instance.instanceId !== instanceId && affectedIds.has(instance.instanceId),
        ),
        (instance) => instance.auth?.invalidate ?? Effect.void,
        { discard: true },
      );
    }
    const threadIds = yield* projections
      .getRecoveryThreadIds("runtime")
      .pipe(
        Effect.mapError(() => failure("Could not read the provider's active sessions. Try again.")),
      );
    const released = new Set<ProviderSessionId>();
    yield* Effect.forEach(
      threadIds,
      (threadId) =>
        projections.getThreadRecords(threadId, ["providerSessions"]).pipe(
          Effect.flatMap((projection) =>
            Effect.forEach(
              projection.providerSessions.filter(
                (session) =>
                  affectedIds.has(session.providerInstanceId) &&
                  session.status !== "stopped" &&
                  session.status !== "error" &&
                  !released.has(session.id),
              ),
              (session) =>
                providerSessions
                  .release({
                    providerSessionId: session.id,
                    reason: "manual_shutdown",
                    detail: "Provider sign-in changed.",
                  })
                  .pipe(Effect.tap(() => Effect.sync(() => released.add(session.id)))),
              { discard: true },
            ),
          ),
          Effect.mapError(() =>
            failure("Could not stop all sessions for this provider. Try again."),
          ),
        ),
      { discard: true },
    );
  });

  const checkSharedBinding = Effect.fnUntraced(function* (instanceId: ProviderInstanceId) {
    const auth = yield* getController(instanceId, "start");
    const binding = auth.credentialBinding;
    if (!binding) return;
    const instances = yield* registry.listInstances;
    for (const instance of instances) {
      if (
        instance.instanceId !== instanceId &&
        instance.auth?.credentialBinding?.key === binding.key &&
        instance.auth.credentialBinding.owner === binding.owner &&
        instance.auth.isChangingCredentials &&
        (yield* instance.auth.isChangingCredentials)
      ) {
        return yield* new ProviderSetupError({
          instanceId,
          operation: "start",
          detail:
            "Another provider instance is changing this shared sign-in. Finish or cancel it first.",
        });
      }
    }
  });

  return ProviderAuthService.of({
    start: Effect.fn("ProviderAuthService.start")(function* (input, ownerSessionId) {
      return yield* credentialChanges.withPermit(
        Effect.gen(function* () {
          yield* checkSharedBinding(input.instanceId);
          const auth = yield* getController(input.instanceId, "start");
          return yield* auth.start(ownerSessionId, stopSessions(input.instanceId), input.methodId);
        }),
      );
    }),
    respond: Effect.fn("ProviderAuthService.respond")(function* (input, ownerSessionId) {
      const auth = yield* getController(input.instanceId, "respond");
      if (!auth.respond) {
        return yield* new ProviderSetupError({
          instanceId: input.instanceId,
          operation: "respond",
          detail: "This provider does not accept this sign-in interaction.",
        });
      }
      return yield* auth.respond(ownerSessionId, input);
    }),
    complete: Effect.fn("ProviderAuthService.complete")(function* (input, ownerSessionId) {
      const auth = yield* getController(input.instanceId, "complete");
      return yield* auth.complete(ownerSessionId, input);
    }),
    cancel: Effect.fn("ProviderAuthService.cancel")(function* (input, ownerSessionId) {
      const auth = yield* getController(input.instanceId, "cancel");
      return yield* auth.cancel(ownerSessionId, input.flowId);
    }),
    logout: Effect.fn("ProviderAuthService.logout")(function* (input) {
      return yield* credentialChanges.withPermit(
        Effect.gen(function* () {
          yield* checkSharedBinding(input.instanceId);
          const auth = yield* getController(input.instanceId, "logout");
          return yield* auth.logout(stopSessions(input.instanceId));
        }),
      );
    }),
    subscribe: (input, ownerSessionId) =>
      Effect.gen(function* () {
        const changes = yield* registry.subscribeChanges;
        const initial = yield* getController(input.instanceId, "subscribe");
        return Stream.concat(
          Stream.succeed(initial),
          Stream.fromSubscription(changes).pipe(
            Stream.mapEffect(() => getController(input.instanceId, "subscribe")),
          ),
        ).pipe(
          Stream.changesWith((previous, next) => previous === next),
          Stream.switchMap((auth) => auth.subscribe(ownerSessionId)),
        );
      }).pipe(Stream.unwrap),
    tryHandlePromptCommand: Effect.fn("ProviderAuthService.tryHandlePromptCommand")(
      function* (input) {
        const instance = yield* registry.getInstance(input.instanceId);
        if (!instance?.auth?.isLogoutPrompt?.(input.text, input.hasAttachments)) {
          return false;
        }
        yield* credentialChanges.withPermit(
          Effect.gen(function* () {
            yield* checkSharedBinding(input.instanceId);
            yield* instance.auth!.logout(stopSessions(input.instanceId));
          }),
        );
        return true;
      },
    ),
  });
});

export const ProviderAuthServiceLive = Layer.effect(ProviderAuthService, makeProviderAuthService);
