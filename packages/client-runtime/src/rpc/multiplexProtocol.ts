import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type { RpcClient } from "effect/unstable/rpc";

/** Keep a slow subscription's receive queue from blocking the socket's other RPCs. */
export const multiplexProtocol = (
  protocol: RpcClient.Protocol["Service"],
): RpcClient.Protocol["Service"] => ({
  ...protocol,
  run: (clientId, receive) =>
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Effect.scope;
        const pending = new Map<string | number, Fiber.Fiber<void>>();
        return yield* protocol.run(clientId, (message) =>
          Effect.gen(function* () {
            if (!("requestId" in message)) {
              // Connection failure must unblock even subscriptions whose consumer
              // has stopped. Their bounded receive queues are closed by receive.
              yield* Effect.forEach(pending.values(), Fiber.interrupt, {
                concurrency: "unbounded",
              });
              pending.clear();
              return yield* receive(message);
            }
            const requestId = message.requestId;
            const previous = pending.get(requestId);
            const delivery = yield* (previous ? Fiber.await(previous) : Effect.void).pipe(
              Effect.andThen(() => receive(message)),
              Effect.forkIn(scope),
            );
            pending.set(requestId, delivery);
            delivery.addObserver(() => {
              if (pending.get(requestId) === delivery) pending.delete(requestId);
            });
            // RPC ACKs still follow delivery into each bounded queue. The server
            // cannot send that subscription's next batch until it is accepted.
          }),
        );
      }),
    ),
});
