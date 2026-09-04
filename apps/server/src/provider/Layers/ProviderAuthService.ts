import {
  ProviderSetupError,
  type ProviderInstanceId,
  type ProviderSessionId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ProviderSessionManagerV2 } from "../../orchestration-v2/ProviderSessionManager.ts";
import { ProjectionStoreV2 } from "../../orchestration-v2/ProjectionStore.ts";
import { ProviderAuthService } from "../Services/ProviderAuthService.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";

export const makeProviderAuthService = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry;
  const projections = yield* ProjectionStoreV2;
  const providerSessions = yield* ProviderSessionManagerV2;

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
    const threadIds = yield* projections
      .getRecoveryThreadIds("runtime")
      .pipe(
        Effect.mapError(() => failure("Could not read the provider's active sessions. Try again.")),
      );
    const released = new Set<ProviderSessionId>();
    yield* Effect.forEach(
      threadIds,
      (threadId) =>
        projections.getThreadProjection(threadId).pipe(
          Effect.flatMap((projection) =>
            Effect.forEach(
              projection.providerSessions.filter(
                (session) =>
                  session.providerInstanceId === instanceId &&
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

  return ProviderAuthService.of({
    start: Effect.fn("ProviderAuthService.start")(function* (input, ownerSessionId) {
      const auth = yield* getController(input.instanceId, "start");
      return yield* auth.start(ownerSessionId, stopSessions(input.instanceId));
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
      const auth = yield* getController(input.instanceId, "logout");
      return yield* auth.logout(stopSessions(input.instanceId));
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
        yield* instance.auth.logout(stopSessions(input.instanceId));
        return true;
      },
    ),
  });
});

export const ProviderAuthServiceLive = Layer.effect(ProviderAuthService, makeProviderAuthService);
