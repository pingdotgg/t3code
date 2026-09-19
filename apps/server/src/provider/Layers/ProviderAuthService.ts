import { ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ProviderSessionManagerV2 } from "../../orchestration-v2/ProviderSessionManager.ts";
import { ProviderAuthService } from "../Services/ProviderAuthService.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";

export const makeProviderAuthService = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry;
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

  // The session manager's own records are the authority on what still owns
  // provider resources: projected status cannot see in-flight startups, and a
  // session whose cleanup failed keeps owning its process and credentials
  // behind an "error" status. closeInstance fences new opens, joins pending
  // startups and tracked credential revocations, and propagates a cleanup
  // failure instead of reporting success over owned resources.
  const stopSessions = Effect.fn("ProviderAuthService.stopSessions")(function* (
    instanceId: ProviderInstanceId,
  ) {
    yield* providerSessions.closeInstance(instanceId).pipe(
      Effect.mapError(
        () =>
          new ProviderSetupError({
            instanceId,
            operation: "stopSessions",
            detail: "Could not stop all sessions for this provider. Try again.",
          }),
      ),
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
