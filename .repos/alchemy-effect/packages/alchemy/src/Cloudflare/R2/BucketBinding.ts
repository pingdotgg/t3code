import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Output from "../../Output.ts";
import { Worker, WorkerEnvironment } from "../Workers/Worker.ts";
import type { Bucket } from "./Bucket.ts";
import type { R2Object, ObjectBody } from "./BucketTypes.ts";
import { R2Error } from "./BucketTypes.ts";

/**
 * Shared scaffolding for the Worker-binding implementations of the R2 services.
 *
 * Resolves the {@link WorkerEnvironment} and host {@link Worker}, registers the
 * `r2_bucket` binding at deploy time, then delegates to `makeClient` with the
 * shared {@link Helpers} to build the read/write/read-write client.
 */
export const makeBucketBinding = <Client>(options: {
  makeClient: (helpers: ReturnType<typeof makeHelpers>) => Client;
}) =>
  Effect.gen(function* () {
    const env = yield* WorkerEnvironment;
    const host = yield* Worker;

    return Effect.fn(function* (bucket: Bucket) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* host.bind`${bucket}`({
          bindings: [
            {
              type: "r2_bucket",
              name: bucket.LogicalId,
              bucketName: bucket.bucketName,
              jurisdiction: bucket.jurisdiction.pipe(
                Output.map((jurisdiction) =>
                  jurisdiction === "default" ? undefined : jurisdiction,
                ),
              ),
            },
          ],
        });
      }

      return options.makeClient(makeHelpers(env, bucket));
    });
  });

/**
 * Helpers shared by both the read and write halves of the binding client.
 *
 * Read-only (`wrapR2Objects`) and write-only (`wrapR2MultipartUpload`) wrappers
 * live in {@link makeRead}/{@link makeWrite} respectively — only the primitives
 * used by both sides are exposed here.
 */
export const makeHelpers = (env: Record<string, any>, bucket: Bucket) => {
  const raw = Effect.sync(
    () => (env as Record<string, runtime.R2Bucket>)[bucket.LogicalId]!,
  );
  const tryPromise = <T>(fn: () => Promise<T>): Effect.Effect<T, R2Error> =>
    Effect.tryPromise({
      try: fn,
      catch: (error: any) =>
        new R2Error({
          message: error.message ?? "Unknown error",
          cause: error,
        }),
    });

  const use = <T>(
    fn: (raw: runtime.R2Bucket) => Promise<T>,
  ): Effect.Effect<T, R2Error> =>
    raw.pipe(Effect.flatMap((raw) => tryPromise(() => fn(raw))));

  const wrapR2Object = (object: runtime.R2Object): R2Object => ({
    ...object,
    writeHttpMetadata: (headers: Headers) =>
      Effect.sync(() => object.writeHttpMetadata(headers)),
  });
  const wrapR2ObjectBody = (object: runtime.R2ObjectBody): ObjectBody => ({
    ...wrapR2Object(object),
    body: Stream.fromReadableStream({
      evaluate: () =>
        object.body as any as ReadableStream<Uint8Array<ArrayBufferLike>>,
      onError: (error: any) =>
        new R2Error({
          message: error.message ?? "Unknown error",
          cause: error,
        }),
    }),
    bodyUsed: object.bodyUsed,
    arrayBuffer: () => tryPromise(() => object.arrayBuffer()),
    bytes: () => tryPromise(() => object.bytes()),
    text: () => tryPromise(() => object.text()),
    json: <T>() => tryPromise(() => object.json<T>()),
    blob: () => tryPromise(() => object.blob()),
  });

  const isR2ObjectBody = (object: any): object is runtime.R2ObjectBody =>
    object !== null && typeof object === "object" && "body" in object;

  const wrapR2ObjectOrBody = (
    object: runtime.R2Object | runtime.R2ObjectBody | null,
  ): R2Object | ObjectBody | null =>
    object === null
      ? object
      : isR2ObjectBody(object)
        ? wrapR2ObjectBody(object)
        : wrapR2Object(object);

  return {
    raw,
    use,
    tryPromise,
    wrapR2Object,
    wrapR2ObjectOrBody,
  };
};
