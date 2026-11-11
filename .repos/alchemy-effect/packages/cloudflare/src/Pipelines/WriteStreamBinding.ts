import type { Pipeline } from "cloudflare:pipelines";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Worker, WorkerEnvironment } from "../Workers/Worker.ts";
import { isLegacyPipeline, type LegacyPipeline } from "./LegacyPipeline.ts";
import type { Stream } from "./Stream.ts";
import { makeStreamClient, recordSchemaOf, toStreamSendError } from "./StreamCodec.ts";
import { WriteStream, type WriteStreamClient } from "./WriteStream.ts";

/**
 * Implementation of the {@link WriteStream} service over a native Worker
 * `pipelines` binding. Registers the binding on the host Worker and, when
 * the stream has an Effect Schema, encodes records with it before
 * `send`.
 * ### Providing the Layer
 * **Example:** Send from a Worker
 * ```typescript
 * Effect.gen(function* () {
 *   const views = yield* Cloudflare.Basin.WriteStream(PageViews);
 *   // ...
 * }).pipe(Effect.provide(Cloudflare.Basin.WriteStreamBinding));
 * ```
 *
 * @layer
 * @provides Cloudflare.Pipelines.WriteStream
 * @product Pipelines
 * @category Storage & Databases
 */
export const WriteStreamBinding = Layer.effect(
  WriteStream,
  Effect.gen(function* () {
    const env = yield* WorkerEnvironment;
    const host = yield* Worker;

    return Effect.fn(function* (stream: Stream<any> | LegacyPipeline) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* host.bind`${stream}`({
          bindings: [
            {
              type: "pipelines",
              name: stream.LogicalId,
              // A stream is bound by id; a legacy pipeline by name (the
              // API identifier of the legacy generation).
              pipeline: isLegacyPipeline(stream) ? stream.name : stream.streamId,
            },
          ],
        });
      }

      return makeWriteStreamClient(env, stream);
    });
  }),
);

/** Build the producer client over a native Worker `pipelines` binding. */
export const makeWriteStreamClient = (
  env: Record<string, any>,
  stream: Stream<any> | LegacyPipeline,
): WriteStreamClient<any> => {
  const raw = Effect.sync(() => (env as Record<string, Pipeline>)[stream.LogicalId]!);
  return makeStreamClient({
    schema: recordSchemaOf(stream),
    raw,
    sendEncoded: (records) =>
      raw.pipe(
        Effect.flatMap((pipeline) =>
          Effect.tryPromise({
            try: () => pipeline.send([...records]),
            catch: toStreamSendError,
          }),
        ),
      ),
  });
};
