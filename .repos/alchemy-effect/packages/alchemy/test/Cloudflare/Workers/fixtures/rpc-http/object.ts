import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import { DoRpcs } from "./group.ts";

/**
 * Durable Object backing the `*DO` RPCs on the Worker. It exposes the
 * `InnerRpcs` group via `RpcServer.toHttpEffect`. The Worker constructs
 * an `RpcClient` whose transport calls into this DO's `fetch`, so the
 * Worker's `*DO` handlers transparently delegate here.
 */
export default class RpcHttpTestObject extends Cloudflare.DurableObjectNamespace<RpcHttpTestObject>()(
  "RpcHttpTestObject",
  Effect.gen(function* () {
    return Effect.gen(function* () {
      let counter = 0;

      const handlersLayer = DoRpcs.toLayer({
        PingDO: ({ message }) => {
          console.log("Ping");
          return Effect.sync(() => {
            console.log("Ping inside");
            return {
              echo: message,
              n: ++counter,
            };
          });
        },
        CountDO: ({ upto }) =>
          Stream.fromReadableStream<number, never>({
            evaluate: () => {
              let next = 1;
              return new ReadableStream<number>({
                pull(controller) {
                  if (next > upto) {
                    controller.close();
                    return;
                  }
                  controller.enqueue(next++);
                },
              });
            },
            onError: (cause) => cause as never,
          }),
        EchoDO: ({ messages }) =>
          Stream.fromIterable(
            messages.map((message, index) => ({ index, message })),
          ),
      });

      return {
        fetch: RpcServer.toHttpEffect(DoRpcs).pipe(
          Effect.provide(
            Layer.mergeAll(handlersLayer, RpcSerialization.layerNdjson),
          ),
        ),
      };
    });
  }),
) {}
