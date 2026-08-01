import type * as cf from "@cloudflare/workers-types";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import * as Binding from "../Workers/Binding.ts";
import type { ImagesBinding } from "./ImagesBinding.ts";

const TypeId = "Cloudflare.Images.Images" as const;
type TypeId = typeof TypeId;

export class ImagesError extends Data.TaggedError("ImagesError")<{
  message: string;
  code?: number;
  cause: unknown;
}> {}

/**
 * A Cloudflare Images binding for image transformation inside Workers — a
 * Worker-only binding with no backing cloud resource.
 *
 * `Images` is a single value that is at once the `Binding.Service` tag, the
 * callable that produces an {@link ImagesBinding}, and the type. Declare it on a
 * Worker's `env` (it flows through `InferEnv` → `cf.ImagesBinding`) or `yield*`
 * it inside an Effect-native Worker to attach the binding and obtain the
 * {@link ImagesClient}.
 *
 * @binding
 * @product Images
 * @category Media
 * @section Effect-style Worker (recommended)
 * @example Read image format and dimensions from the request body
 * ```typescript
 * import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
 *
 * Cloudflare.Worker("ImageWorker", { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const images = yield* Cloudflare.Images.Images("PIPELINE");
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         const info = yield* images.info(request.stream);
 *         return yield* HttpServerResponse.json(info);
 *       }),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.Images.ImagesBinding)),
 * );
 * ```
 *
 * @section Binding to a Worker (declarative)
 * @example
 * ```typescript
 * export const Worker = Cloudflare.Worker("Worker", {
 *   main: "./src/worker.ts",
 *   env: { MEDIA: Cloudflare.Images.Images("PIPELINE") },
 * });
 *
 * export type WorkerEnv = Cloudflare.InferEnv<typeof Worker>;
 * //   { MEDIA: ImagesBinding }
 * ```
 *
 * @see https://developers.cloudflare.com/images/transform-images/bindings/
 */
export interface Images extends Binding.Service<Images, TypeId, ImagesClient> {
  /**
   * @param name Binding name (logical id) — the `env` key it resolves to.
   * @default "IMAGES"
   */
  (name?: string): ImagesBinding;
}

export const Images = Binding.Service<Images>({
  id: TypeId,
  defaultName: "IMAGES",
  toWorkerBinding: (binding) => ({ type: "images", name: binding.name }),
});

export const isImages = (value: unknown): value is ImagesBinding =>
  Binding.isBinding(value) && value.kind === TypeId;

/**
 * Effect-native client for a Cloudflare Images binding. Wraps the runtime
 * {@link cf.ImagesBinding} so each method returns an Effect tagged with
 * {@link ImagesError}.
 */
export interface ImagesClient {
  /** Effect resolving to the raw Cloudflare runtime binding. */
  raw: Effect.Effect<cf.ImagesBinding, never, RuntimeContext>;
  /**
   * Read image format and dimensions from a stream of bytes. Fails with
   * {@link ImagesError} (code 9412) if the input is not a recognized image.
   */
  info<E = never, R = never>(
    stream: Stream.Stream<Uint8Array, E, R>,
    options?: cf.ImageInputOptions,
  ): Effect.Effect<cf.ImageInfoResponse, ImagesError, RuntimeContext | R>;
  /**
   * Begin a transformation pipeline. Subsequent `.transform()` / `.draw()`
   * calls are pure; `.output(opts)` runs the pipeline.
   */
  input<E = never, R = never>(
    stream: Stream.Stream<Uint8Array, E, R>,
    options?: cf.ImageInputOptions,
  ): Effect.Effect<ImageTransformer, never, RuntimeContext | R>;
}

/**
 * Effect-native handle to the result of `input(...).output(...)`. Mirrors the
 * runtime `ImageTransformationResult` but exposes side effects as sync effects.
 */
export interface ImageTransformationResult {
  raw: cf.ImageTransformationResult;
  response: Effect.Effect<cf.Response>;
  contentType: Effect.Effect<string>;
  image(
    options?: cf.ImageTransformationOutputOptions,
  ): Effect.Effect<cf.ReadableStream<Uint8Array>>;
}

/**
 * Effect-native chainable transformer. `transform`/`draw` are pure; `output` is
 * the only step that crosses into Cloudflare's runtime and returns an Effect.
 */
export interface ImageTransformer {
  raw: cf.ImageTransformer;
  transform(transform: cf.ImageTransform): ImageTransformer;
  draw<E = never, R = never>(
    image: Stream.Stream<Uint8Array, E, R> | ImageTransformer,
    options?: cf.ImageDrawOptions,
  ): Effect.Effect<ImageTransformer, never, R>;
  output(
    options: cf.ImageOutputOptions,
  ): Effect.Effect<ImageTransformationResult, ImagesError>;
}
