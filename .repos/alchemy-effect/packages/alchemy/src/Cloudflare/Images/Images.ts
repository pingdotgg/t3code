import type * as Effect from "effect/Effect";
import { SingleShotGen } from "effect/Utils";
import { ImagesBinding, type ImagesClient } from "./ImagesBinding.ts";

type ImagesTypeId = typeof ImagesTypeId;
const ImagesTypeId = "Cloudflare.Images" as const;

export type ImagesProps = {
  /**
   * Binding name used when `Images` is bound from inside a Worker init phase
   * (`yield* Cloudflare.Images(...)`). When passed through
   * `Worker({ env: { ... } })`, the object key remains the binding name.
   *
   * @default "IMAGES"
   */
  name?: string;
};

/**
 * The Effect yielded when an `Images` marker is used inside a Worker init
 * phase: it attaches the `images` binding to the surrounding Worker and
 * resolves to the runtime {@link ImagesClient}.
 */
type BindEffect = Effect.Effect<ImagesClient, never, ImagesBinding>;

/**
 * Marker for a Cloudflare Images binding.
 *
 * It is a plain data structure (so it can be declared directly on a Worker's
 * `env`) that is **also** yieldable inside an Effect-native Worker. Yielding it
 * (`yield* Cloudflare.Images(...)`) attaches the binding to the surrounding
 * Worker and returns the runtime {@link ImagesClient} — no separate `.bind(...)`
 * step required.
 *
 * The divergence is achieved via `[Symbol.iterator]`: the object is not an
 * `Effect` (so `InferEnv` resolves it to the native `ImagesBinding` in the
 * `env` position), but it is iterable as one when `yield*`-ed.
 */
export interface Images {
  kind: ImagesTypeId;
  name: string;
  asEffect(): BindEffect;
  [Symbol.iterator](): SingleShotGen<BindEffect, ImagesClient>;
}

export const isImages = (value: unknown): value is Images =>
  typeof value === "object" &&
  value !== null &&
  "kind" in value &&
  (value as Images).kind === ImagesTypeId;

/**
 * A Cloudflare Images binding for image transformation and manipulation inside
 * Workers.
 *
 * The Effect-native interface (`Cloudflare.Images.bind(...)`) returns an
 * `ImagesClient` whose methods take Effect `Stream.Stream<Uint8Array>`
 * inputs and return `Effect`s — `info`, `input(...).transform(...)
 * .draw(...).output(...)`. The runtime conversion to Cloudflare's
 * `ReadableStream` is handled internally.
 *
 * @section Effect-style Worker (recommended)
 * @example Read image format and dimensions from the request body
 * ```typescript
 * import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
 *
 * Cloudflare.Worker("ImageWorker", { main: import.meta.filename },
 *   Effect.gen(function* () {
 *     // Attaches the binding to this Worker AND returns the runtime client.
 *     const images = yield* Cloudflare.Images({ name: "PIPELINE" });
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         // request.stream is Stream.Stream<Uint8Array>
 *         const info = yield* images.info(request.stream);
 *         return yield* HttpServerResponse.json(info);
 *       }),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.ImagesBindingLive)),
 * );
 * ```
 *
 * @example Transform an image — chainable pipeline, single Effect at the end
 * ```typescript
 * const result = yield* (yield* images.input(request.stream))
 *   .transform({ width: 128 })
 *   .output({ format: "image/jpeg" });
 *
 * const response = yield* result.response;
 * ```
 *
 * @section Binding to a Worker (declarative)
 * @example
 * ```typescript
 * export const Worker = Cloudflare.Worker("Worker", {
 *   main: "./src/worker.ts",
 *   env: { MEDIA: Cloudflare.Images({ name: "PIPELINE" }) },
 * });
 *
 * export type WorkerEnv = Cloudflare.InferEnv<typeof Worker>;
 * //   { MEDIA: ImagesBinding }
 * ```
 *
 * Inside the Worker, the raw Cloudflare runtime binding is reachable via
 * `client.raw` if you need to call `info()` / `input()` directly with
 * `async`/`await`. The Effect-native interface is preferred — it returns
 * tagged `ImagesError`s, threads `WorkerEnvironment`, and lets you stream
 * Effect `Stream<Uint8Array>` sources without manual conversion.
 *
 * @see https://developers.cloudflare.com/images/transform-images/bindings/
 */
export const Images: {
  (props?: ImagesProps): Images;
  /**
   * Bind an existing `Images` marker to the surrounding Worker, returning the
   * Effect-native client. Equivalent to `yield* images` — prefer yielding the
   * marker directly.
   */
  bind: typeof ImagesBinding.bind;
} = Object.assign(
  (props?: ImagesProps): Images => {
    const self: Images = {
      kind: ImagesTypeId,
      name: props?.name ?? "IMAGES",
      asEffect: () => ImagesBinding.bind(self),
      [Symbol.iterator]: () => new SingleShotGen(ImagesBinding.bind(self)),
    };
    return self;
  },
  {
    bind: (...args: Parameters<typeof ImagesBinding.bind>) =>
      ImagesBinding.bind(...args),
  },
);
