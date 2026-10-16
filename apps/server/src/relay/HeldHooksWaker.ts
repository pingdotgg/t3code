import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as CloudManagedEndpointRuntime from "../cloud/ManagedEndpointRuntime.ts";
import { readHoldWebhooksWhileOffline, readRelayConnection } from "../cloud/config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { makeRelayEnvironmentClient } from "./relayEnvironmentClient.ts";

const wakeHeldHooks = Effect.fn("HeldHooksWaker.wake")(function* () {
  if (!(yield* readHoldWebhooksWhileOffline)) return false;
  const connection = yield* readRelayConnection;
  if (connection === null) return false;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const client = yield* makeRelayEnvironmentClient(connection);
  const { pending } = yield* client.server.wakeHeldHooks({ params: { environmentId } });
  yield* Effect.annotateCurrentSpan({ "relay.inbox.pending": pending });
  return pending;
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const runtime = yield* CloudManagedEndpointRuntime.CloudManagedEndpointRuntime;
    const wake = wakeHeldHooks().pipe(
      Effect.timeout("10 seconds"),
      Effect.retry({ schedule: Schedule.exponential("2 seconds"), times: 3 }),
      Effect.tap((pending) =>
        pending ? Effect.logInfo("T3 Connect is delivering held webhook requests") : Effect.void,
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not ask T3 Connect to deliver held webhook requests", { cause }),
      ),
    );
    yield* runtime.tunnelConnected.pipe(
      // cloudflared registers several connections per (re)connect within a
      // few seconds; they are one wake.
      Stream.debounce("3 seconds"),
      Stream.runForEach(() => wake),
      Effect.forkScoped,
    );
  }),
);
