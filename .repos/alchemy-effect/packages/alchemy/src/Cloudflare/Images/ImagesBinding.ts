import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Binding from "../Workers/Binding.ts";
import { makeBindingLayer } from "../Workers/BindingLayer.ts";
import {
  Images,
  ImagesError,
  type ImagesClient,
  type ImageTransformationResult,
  type ImageTransformer,
} from "./Images.ts";

/** The binding value produced by calling {@link Images} (declared on `env` or `yield*`-ed). */
export type ImagesBinding = Binding.Binding<
  Images["key"],
  ImagesClient,
  Images
>;

/**
 * The layer that provides the Effect-native interface for the Cloudflare
 * Workers Images binding.
 *
 * Provide it on the Worker effect (`Effect.provide(Cloudflare.Images.ImagesBinding)`)
 * so that yielding an {@link Images} binding attaches the native `images`
 * binding to the surrounding Worker at deploy time and, at runtime, resolves to
 * the Effect-native {@link ImagesClient} (wrapping the raw `cf.ImagesBinding` so every
 * `info` / `input(...).transform(...).output(...)` call returns an `Effect`).
 */
export const ImagesBinding = makeBindingLayer<
  Images,
  cf.ImagesBinding,
  ImagesClient
>(
  Images,
  (raw) =>
    ({
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
    }) satisfies ImagesClient,
);

/**
 * Wrap a runtime `ImageTransformer` as the Effect-native chainable client.
 * `transform`/`draw` stay pure; `output` crosses into the runtime.
 */
const wrapTransformer = (raw: cf.ImageTransformer): ImageTransformer => ({
  raw,
  transform: (transform) => wrapTransformer(raw.transform(transform)),
  draw: <E, R>(
    image: Stream.Stream<Uint8Array, E, R> | ImageTransformer,
    options?: cf.ImageDrawOptions,
  ): Effect.Effect<ImageTransformer, never, R> => {
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

/** Wrap a runtime `ImageTransformationResult` as the Effect-native result client. */
const wrapResult = (
  raw: cf.ImageTransformationResult,
): ImageTransformationResult => ({
  raw,
  response: Effect.sync(() => raw.response()),
  contentType: Effect.sync(() => raw.contentType()),
  image: (options) => Effect.sync(() => raw.image(options)),
});

/**
 * Convert an Effect `Stream<Uint8Array>` into the `cf.ReadableStream<Uint8Array>`
 * shape the Images runtime binding expects (identical at runtime).
 */
const toCfReadable = <E, R>(
  stream: Stream.Stream<Uint8Array, E, R>,
): Effect.Effect<cf.ReadableStream<Uint8Array>, never, R> =>
  Stream.toReadableStreamEffect(stream).pipe(
    Effect.map((s) => s as unknown as cf.ReadableStream<Uint8Array>),
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

const isTransformerClient = (image: unknown): image is ImageTransformer =>
  typeof image === "object" && image !== null && "raw" in image;
