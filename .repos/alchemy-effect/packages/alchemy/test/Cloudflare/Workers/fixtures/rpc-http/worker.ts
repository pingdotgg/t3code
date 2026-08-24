import * as Cloudflare from "@/Cloudflare";
import type { HttpEffect } from "@/Http";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import { DoRpcs, WorkerRpcs } from "./group.ts";
import RpcHttpTestObject from "./object.ts";

let counter = 0;

export default class RpcHttpTestWorker extends Cloudflare.Worker<RpcHttpTestWorker>()(
  "RpcHttpTestWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const rpcDO = yield* RpcHttpTestObject;

    // Per-request RpcClient transport: dispatches HTTP requests to the
    // DO's fetch handler (which serves `InnerRpcs` via
    // `RpcServer.toHttpEffect`). Mirrors the `Cloudflare.toHttpClient`
    // pattern used by the HttpApi fixture's `getTaskDO` factory.
    const makeDOClient = (id: string = "default") =>
      RpcClient.make(DoRpcs).pipe(
        Effect.provide(
          RpcClient.layerProtocolHttp({ url: "http://localhost" }).pipe(
            Layer.provide(
              Layer.succeed(
                HttpClient.HttpClient,
                Cloudflare.toHttpClient(rpcDO.getByName(id)),
              ),
            ),
            Layer.provide(RpcSerialization.layerNdjson),
          ),
        ),
      );

    const handlersLayer = WorkerRpcs.toLayer({
      Ping: ({ message }) =>
        Effect.sync(() => ({
          echo: message,
          n: ++counter,
        })),
      Count: ({ upto }) =>
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
      Echo: ({ messages }) =>
        Stream.fromIterable(
          messages.map((message, index) => ({ index, message })),
        ),
      PingDO: (payload) =>
        Effect.gen(function* () {
          const client = yield* makeDOClient();
          const result = yield* client.PingDO(payload);
          return result;
        }).pipe(Effect.orDie),
      CountDO: (payload) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const client = yield* makeDOClient();
            return client.CountDO(payload).pipe(Stream.orDie);
          }),
        ),
      EchoDO: (payload) =>
        Stream.unwrap(
          Effect.gen(function* () {
            return (yield* makeDOClient()).EchoDO(payload).pipe(Stream.orDie);
          }),
        ),
    });

    return {
      fetch: RpcServer.toHttpEffect(WorkerRpcs).pipe(
        Effect.provide(
          Layer.mergeAll(handlersLayer, RpcSerialization.layerNdjson),
        ),
      ) as unknown as HttpEffect,
    };
  }),
) {}
