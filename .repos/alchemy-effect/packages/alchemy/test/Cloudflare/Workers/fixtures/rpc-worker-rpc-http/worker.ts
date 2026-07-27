import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import { WorkerRpcs } from "./group.ts";
import RpcWorkerRpcHttpObject from "./object.ts";

let counter = 0;

/**
 * {@link Cloudflare.RpcWorker} variant of the manual `rpc-http`
 * fixture. Local handlers (`Ping`, `Count`) live on the worker; `*DO`
 * handlers forward through the typed
 * {@link RpcWorkerRpcHttpObject} client returned by yielding the
 * {@link Cloudflare.RpcDurableObject} class. The piped
 * `RpcServer.toHttpEffect(WorkerRpcs)` is returned directly — no
 * `{ fetch }` wrapper.
 */
export default class RpcWorkerRpcHttpWorker extends Cloudflare.RpcWorker<RpcWorkerRpcHttpWorker>()(
  "RpcWorkerRpcHttpWorker",
  { main: import.meta.url, schema: WorkerRpcs },
  Effect.gen(function* () {
    const objects = yield* RpcWorkerRpcHttpObject;

    const handlers = WorkerRpcs.toLayer({
      Ping: ({ message }) =>
        Effect.sync(() => ({ echo: message, n: ++counter })),
      Count: ({ upto }) =>
        Stream.fromIterable(
          Array.from({ length: Math.max(0, upto) }, (_, i) => i + 1),
        ),
      PingDO: ({ message }) =>
        Effect.gen(function* () {
          const client = yield* objects.getByName("default");
          return yield* client.PingDO({ message });
        }).pipe(Effect.orDie),
      CountDO: ({ upto }) =>
        Stream.unwrap(
          Effect.map(objects.getByName("default"), (client) =>
            client.CountDO({ upto }).pipe(Stream.orDie),
          ),
        ),
    });

    return RpcServer.toHttpEffect(WorkerRpcs).pipe(
      Effect.provide(Layer.mergeAll(handlers, RpcSerialization.layerNdjson)),
    );
  }),
) {}
