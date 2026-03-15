import { Deferred, Effect } from "effect";

export interface ServerReadiness {
  readonly awaitServerReady: Effect.Effect<void>;
  readonly markHttpListening: Effect.Effect<void>;
  readonly markPushBusReady: Effect.Effect<void>;
  readonly markKeybindingsReady: Effect.Effect<void>;
  readonly markTerminalSubscriptionsReady: Effect.Effect<void>;
  readonly markOrchestrationSubscriptionsReady: Effect.Effect<void>;
}

export const makeServerReadiness = Effect.gen(function* () {
  const httpListening = yield* Deferred.make<void>();
  const pushBusReady = yield* Deferred.make<void>();
  const keybindingsReady = yield* Deferred.make<void>();
  const terminalSubscriptionsReady = yield* Deferred.make<void>();
  const orchestrationSubscriptionsReady = yield* Deferred.make<void>();

  const complete = (deferred: Deferred.Deferred<void>) =>
    Deferred.succeed(deferred, undefined).pipe(Effect.orDie);

  return {
    awaitServerReady: Effect.all([
      Deferred.await(httpListening),
      Deferred.await(pushBusReady),
      Deferred.await(keybindingsReady),
      Deferred.await(terminalSubscriptionsReady),
      Deferred.await(orchestrationSubscriptionsReady),
    ]).pipe(Effect.asVoid),
    markHttpListening: complete(httpListening),
    markPushBusReady: complete(pushBusReady),
    markKeybindingsReady: complete(keybindingsReady),
    markTerminalSubscriptionsReady: complete(terminalSubscriptionsReady),
    markOrchestrationSubscriptionsReady: complete(orchestrationSubscriptionsReady),
  } satisfies ServerReadiness;
});
