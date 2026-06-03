import type * as cf from "@cloudflare/workers-types";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Binding from "../../Binding.ts";
import type { ResourceLike } from "../../Resource.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { isWorker, WorkerEnvironment } from "../Workers/Worker.ts";
import { type Images as ImagesLike } from "./Images.ts";

export class ImagesError extends Data.TaggedError("ImagesError")<{
  message: string;
  code?: number;
  cause: unknown;
}> {}

/**
 * Effect-native handle to the result of `input(...).output(...)`.
 * Mirrors the runtime `ImageTransformationResult` but exposes side
 * effects (response/image/contentType reads) as plain sync effects.
 */
export interface ImageTransformationResultClient {
  raw: cf.ImageTransformationResult;
  response: Effect.Effect<cf.Response>;
  contentType: Effect.Effect<string>;
  image(
    options?: cf.ImageTransformationOutputOptions,
  ): Effect.Effect<cf.ReadableStream<Uint8Array>>;
}

/**
 * Effect-native chainable transformer. `transform`/`draw` are pure
 * (return a new client wrapping the next runtime transformer);
 * `output` is the only step that crosses into Cloudflare's runtime
 * and therefore returns an Effect.
 */
export interface ImageTransformerClient {
  raw: cf.ImageTransformer;
  transform(transform: cf.ImageTransform): ImageTransformerClient;
  draw<E = never, R = never>(
    image: Stream.Stream<Uint8Array, E, R> | ImageTransformerClient,
    options?: cf.ImageDrawOptions,
  ): Effect.Effect<ImageTransformerClient, never, R>;
  output(
    options: cf.ImageOutputOptions,
  ): Effect.Effect<ImageTransformationResultClient, ImagesError>;
}

/**
 * Effect-native client for a Cloudflare Images binding.
 *
 * Wraps the runtime {@link cf.ImagesBinding} so each method returns
 * an Effect tagged with {@link ImagesError}. Use
 * `Cloudflare.Images.bind(images)` inside a Worker's init phase.
 */
export interface ImagesClient {
  /** Effect resolving to the raw Cloudflare runtime binding. */
  raw: Effect.Effect<cf.ImagesBinding, never, RuntimeContext>;
  /**
   * Read image format and dimensions from a stream of bytes.
   * Fails with {@link ImagesError} (code 9412) if the input is not
   * a recognized image.
   */
  info<E = never, R = never>(
    stream: Stream.Stream<Uint8Array, E, R>,
    options?: cf.ImageInputOptions,
  ): Effect.Effect<cf.ImageInfoResponse, ImagesError, RuntimeContext | R>;
  /**
   * Begin a transformation pipeline. Subsequent `.transform()` /
   * `.draw()` calls are pure; `.output(opts)` runs the pipeline.
   */
  input<E = never, R = never>(
    stream: Stream.Stream<Uint8Array, E, R>,
    options?: cf.ImageInputOptions,
  ): Effect.Effect<ImageTransformerClient, never, RuntimeContext | R>;
}

export class ImagesBinding extends Binding.Service<
  ImagesBinding,
  (images: ImagesLike) => Effect.Effect<ImagesClient>
>()("Cloudflare.Images.Binding") {}

export const ImagesBindingLive = Layer.effect(
  ImagesBinding,
  Effect.gen(function* () {
    const Policy = yield* ImagesBindingPolicy;
    const env = yield* WorkerEnvironment;

    return Effect.fn(function* (images: ImagesLike) {
      yield* Policy(images);
      const raw = Effect.sync(
        // this must be lazy because the WorkerEnvironment is not available yet
        () => (env as Record<string, cf.ImagesBinding>)[images.name]!,
      );

      return {
        raw,
        info: (stream, options) =>
          Effect.gen(function* () {
            const binding = yield* raw;
            const readable = yield* toCfReadable(stream);
            return yield* tryPromise(() => binding.info(readable, options));
          }),
        input: (stream, options) =>
          Effect.gen(function* () {
            const binding = yield* raw;
            const readable = yield* toCfReadable(stream);
            return wrapTransformer(binding.input(readable, options));
          }),
      } satisfies ImagesClient;
    });
  }),
);

export class ImagesBindingPolicy extends Binding.Policy<
  ImagesBindingPolicy,
  (images: ImagesLike) => Effect.Effect<void>
>()("Cloudflare.Images.Binding") {}

export const ImagesBindingPolicyLive = ImagesBindingPolicy.layer.succeed(
  Effect.fn(function* (host: ResourceLike, images: ImagesLike) {
    if (isWorker(host)) {
      yield* host.bind(images.name, {
        bindings: [
          {
            type: "images",
            name: images.name,
          },
        ],
      });
    } else {
      return yield* Effect.die(
        new Error(`ImagesBinding does not support runtime '${host.Type}'`),
      );
    }
  }),
);

const tryPromise = <T>(fn: () => Promise<T>): Effect.Effect<T, ImagesError> =>
  Effect.tryPromise({
    try: fn,
    catch: (error: any) =>
      new ImagesError({
        message: error?.message ?? "Unknown error",
        code: typeof error?.code === "number" ? error.code : undefined,
        cause: error,
      }),
  });

/**
 * Convert an Effect `Stream<Uint8Array>` into the `cf.ReadableStream<Uint8Array>`
 * shape that the Cloudflare Images runtime binding expects. The two
 * `ReadableStream` types only differ at the type level; at runtime they
 * are the same Web Streams API.
 */
const toCfReadable = <E, R>(
  stream: Stream.Stream<Uint8Array, E, R>,
): Effect.Effect<cf.ReadableStream<Uint8Array>, never, R> =>
  Stream.toReadableStreamEffect(stream).pipe(
    Effect.map((s) => s as unknown as cf.ReadableStream<Uint8Array>),
  );

const isTransformerClient = (image: unknown): image is ImageTransformerClient =>
  typeof image === "object" && image !== null && "raw" in image;

const wrapTransformer = (raw: cf.ImageTransformer): ImageTransformerClient => ({
  raw,
  transform: (transform) => wrapTransformer(raw.transform(transform)),
  draw: <E, R>(
    image: Stream.Stream<Uint8Array, E, R> | ImageTransformerClient,
    options?: cf.ImageDrawOptions,
  ): Effect.Effect<ImageTransformerClient, never, R> => {
    if (isTransformerClient(image)) {
      return Effect.succeed(wrapTransformer(raw.draw(image.raw, options)));
    }
    return toCfReadable(image).pipe(
      Effect.map((readable) => wrapTransformer(raw.draw(readable, options))),
    );
  },
  output: (options) =>
    tryPromise(() => raw.output(options)).pipe(Effect.map(wrapResult)),
});

const wrapResult = (
  raw: cf.ImageTransformationResult,
): ImageTransformationResultClient => ({
  raw,
  response: Effect.sync(() => raw.response()),
  contentType: Effect.sync(() => raw.contentType()),
  image: (options) => Effect.sync(() => raw.image(options)),
});
