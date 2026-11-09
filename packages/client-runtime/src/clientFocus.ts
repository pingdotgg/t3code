import {
  WS_METHODS,
  type ClientFocusHost,
  type ClientFocusRequest,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { EnvironmentRegistry } from "./connection/registry.ts";
import { subscribe } from "./rpc/client.ts";

export type ClientFocusHandler = (
  environmentId: EnvironmentId,
  request: ClientFocusRequest,
) => void | Promise<void>;

/**
 * Keeps this client focusable on every connected environment: an agent can then
 * ask the environment to bring a thread or file on screen here. Environments
 * that predate `clients.connectFocus` are skipped.
 */
export function makeClientFocusLayer<R>(input: {
  /** Read when the layer starts; null keeps the client unfocusable. */
  readonly host: Effect.Effect<ClientFocusHost | null, never, R>;
  readonly onRequest: ClientFocusHandler;
}): Layer.Layer<never, never, EnvironmentRegistry | R> {
  return Layer.effectDiscard(
    Effect.gen(function* () {
      const host = yield* input.host;
      if (host === null) return;
      const registry = yield* EnvironmentRegistry;
      const followEnvironment = (environmentId: EnvironmentId) =>
        registry.followStream(environmentId, subscribe(WS_METHODS.clientsConnectFocus, host)).pipe(
          Stream.catchCause(() => Stream.empty),
          Stream.map((request) => [environmentId, request] as const),
        );
      yield* Stream.concat(
        Stream.fromEffect(SubscriptionRef.get(registry.entries)),
        SubscriptionRef.changes(registry.entries),
      ).pipe(
        Stream.map((entries) => [...entries.keys()].sort()),
        Stream.changesWith(
          (left, right) =>
            left.length === right.length && left.every((id, index) => id === right[index]),
        ),
        Stream.switchMap((environmentIds) =>
          Stream.mergeAll(environmentIds.map(followEnvironment), { concurrency: "unbounded" }),
        ),
        Stream.runForEach(([environmentId, request]) =>
          Effect.promise(async () => input.onRequest(environmentId, request)).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Client focus request failed.", { cause, environmentId }),
            ),
          ),
        ),
        Effect.forkScoped,
      );
    }),
  );
}

/**
 * Hands focus requests from the connection layer to UI code that can navigate.
 * The latest request that arrives before navigation mounts is applied on mount.
 */
export function makeClientFocusDispatcher() {
  let handler: ClientFocusHandler | null = null;
  let pending: { environmentId: EnvironmentId; request: ClientFocusRequest } | null = null;
  return {
    onRequest: (async (environmentId, request) => {
      if (handler) return handler(environmentId, request);
      pending = { environmentId, request };
    }) satisfies ClientFocusHandler,
    setHandler: (next: ClientFocusHandler | null): void => {
      handler = next;
      if (next && pending) {
        const { environmentId, request } = pending;
        pending = null;
        void next(environmentId, request);
      }
    },
  };
}
