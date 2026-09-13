import type * as cf from "@cloudflare/workers-types";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import * as Binding from "../Workers/Binding.ts";
import type { StreamBinding } from "./StreamBinding.ts";

const TypeId = "Cloudflare.Stream.Stream" as const;
type TypeId = typeof TypeId;

/**
 * Error produced by a {@link StreamClient} operation. Mirrors the runtime's
 * `StreamBindingError` shape (`code` is the Cloudflare Stream error code,
 * `statusCode` the HTTP status it maps to) when the failure crosses the
 * binding boundary.
 */
export class StreamError extends Data.TaggedError("StreamError")<{
  message: string;
  code?: number;
  statusCode?: number;
  cause: unknown;
}> {}

/** An Effect produced by a {@link StreamClient} operation. */
type StreamEffect<A> = Effect.Effect<A, StreamError, RuntimeContext>;

/**
 * A Cloudflare Stream binding for managing videos, captions, downloads and
 * watermarks from Workers — a Worker-only binding with no backing cloud
 * resource.
 *
 * `Stream` is a single value that is at once the `Binding.Service` tag, the
 * callable that produces a {@link StreamBinding}, and the type. Declare it on a
 * Worker's `env` (it flows through `InferEnv` → the runtime `StreamBinding`
 * handle) or `yield*` it inside an Effect-native Worker to attach the binding
 * and obtain the {@link StreamClient}.
 *
 * In `alchemy dev` the binding is emulated locally: uploads land in a local
 * video store and each video's `preview` URL is served unmodified at
 * `{devUrl}/cdn-cgi/mf/stream/<id>/watch`. The local store performs no
 * transcoding (the `hlsPlaybackUrl`/`dashPlaybackUrl` point at a placeholder
 * host), no signed URLs, and `createDirectUpload` is unsupported. Pipe the
 * binding through `Alchemy.remote()` to proxy to the real Stream service
 * instead.
 *
 * ### Effect-style Worker (recommended)
 * **Example:** Upload a video by URL and read back its details
 * ```typescript
 * import * as Effect from "effect/Effect";
 *
 * Cloudflare.Worker(
 *   "StreamWorker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const stream = yield* Cloudflare.Stream.Stream("STREAM");
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const video = yield* stream.upload("https://example.com/video.mp4");
 *         const details = yield* stream.video(video.id).details();
 *         return yield* HttpServerResponse.json(details);
 *       }),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.Stream.StreamBinding)),
 * );
 * ```
 *
 * ### Worker binding metadata
 * **Example:** Declare the binding on `env`
 * ```typescript
 * export const Worker = Cloudflare.Worker("Worker", {
 *   main: "./src/worker.ts",
 *   env: { STREAM: Cloudflare.Stream.Stream() },
 * });
 *
 * export type WorkerEnv = Cloudflare.InferEnv<typeof Worker>;
 * //   { STREAM: StreamBinding }
 * ```
 *
 * ### Local development
 * **Example:** Proxy to the real Stream service in dev
 * ```typescript
 * // Default: videos land in the local video store under `alchemy dev`.
 * // Alchemy.remote() opts the binding into the real Stream service
 * // instead — in an Effect-native Worker:
 * const stream = yield* Cloudflare.Stream.Stream("STREAM").pipe(Alchemy.remote());
 *
 * // or declared on an async Worker's env:
 * env: { STREAM: Cloudflare.Stream.Stream("STREAM").pipe(Alchemy.remote()) }
 * ```
 *
 * @see https://developers.cloudflare.com/stream/
 *
 * @binding
 * @product Stream
 * @category Media
 */
export interface Stream extends Binding.Service<Stream, TypeId, StreamClient> {
  /**
   * @param name Binding name (logical id) — the `env` key it resolves to.
   * @default "STREAM"
   */
  (name?: string): StreamBinding;
}

export const Stream = Binding.Service<Stream>({
  id: TypeId,
  defaultName: "STREAM",
  toWorkerBinding: (binding) => ({
    type: "stream",
    name: binding.name,
  }),
});

export const isStream = (value: unknown): value is StreamBinding =>
  Binding.isBinding(value) && value.kind === TypeId;

/**
 * Effect-native client for a Cloudflare Stream binding. Mirrors the runtime
 * {@link cf.StreamBinding} handle: each operation returns an Effect tagged with
 * {@link StreamError}; `video(id)` returns a pure per-video handle.
 */
export interface StreamClient {
  /** Effect resolving to the raw Cloudflare Stream runtime binding. */
  raw: Effect.Effect<cf.StreamBinding, never, RuntimeContext>;
  /** Upload a new video from a URL. */
  upload(
    url: string,
    params?: cf.StreamUrlUploadParams,
  ): StreamEffect<cf.StreamVideo>;
  /**
   * Create a direct-creator upload (video uploads without an API key).
   * Unsupported by the local dev simulator — fails with {@link StreamError}.
   */
  createDirectUpload(
    params: cf.StreamDirectUploadCreateParams,
  ): StreamEffect<cf.StreamDirectUpload>;
  /** A handle scoped to a single video for per-video operations. */
  video(id: string): StreamVideoClient;
  /** Account-level video operations. */
  videos: {
    /** List videos. */
    list(params?: cf.StreamVideosListParams): StreamEffect<cf.StreamVideo[]>;
  };
  /** Watermark profile operations. */
  watermarks: {
    /** Create a watermark profile from an image stream or URL. */
    generate(
      input: ReadableStream | string,
      params: cf.StreamWatermarkCreateParams,
    ): StreamEffect<cf.StreamWatermark>;
    /** List watermark profiles. */
    list(): StreamEffect<cf.StreamWatermark[]>;
    /** Get a watermark profile. */
    get(watermarkId: string): StreamEffect<cf.StreamWatermark>;
    /** Delete a watermark profile. */
    delete(watermarkId: string): StreamEffect<void>;
  };
}

/** Effect-native handle for operations scoped to a single Stream video. */
export interface StreamVideoClient {
  /** The unique identifier for the video. */
  readonly id: string;
  /** Get the full video details. */
  details(): StreamEffect<cf.StreamVideo>;
  /** Update details for the video. */
  update(params: cf.StreamUpdateVideoParams): StreamEffect<cf.StreamVideo>;
  /** Delete the video and its copies. */
  delete(): StreamEffect<void>;
  /** Create a signed URL token for the video. */
  generateToken(): StreamEffect<string>;
  /** MP4 download operations for the video. */
  downloads: {
    /** Generate a download of the given type. */
    generate(
      downloadType?: cf.StreamDownloadType,
    ): StreamEffect<cf.StreamDownloadGetResponse>;
    /** Get the video's downloads. */
    get(): StreamEffect<cf.StreamDownloadGetResponse>;
    /** Delete a download of the given type. */
    delete(downloadType?: cf.StreamDownloadType): StreamEffect<void>;
  };
  /** Caption operations for the video. */
  captions: {
    /** Upload a WebVTT caption file for a language. */
    upload(
      language: string,
      input: ReadableStream,
    ): StreamEffect<cf.StreamCaption>;
    /** Generate a caption via AI for a language. */
    generate(language: string): StreamEffect<cf.StreamCaption>;
    /** List the video's captions, optionally filtered by language. */
    list(language?: string): StreamEffect<cf.StreamCaption[]>;
    /** Delete the caption for a language. */
    delete(language: string): StreamEffect<void>;
  };
}
