/** Options for a local Cloudflare Stream binding. */
export interface StreamProps {
  /** Binding name exposed on `env`. */
  readonly binding: string;
}

/**
 * A single `stream` service hosts the whole simulator: the `StreamBinding`
 * RPC entrypoint (the surface `stream` bindings target) and the
 * `StreamObject` Durable Object holding all video/caption/watermark/download
 * state, mirroring Miniflare's stream plugin
 * (`workers-sdk/packages/miniflare/src/plugins/stream/index.ts`) collapsed
 * into one service (direct cross-service Durable Object references are not
 * supported by this runtime; see the queue simulator for the same pattern).
 */
export const SERVICE_STREAM = "stream";
export const SERVICE_STREAM_STORAGE = "stream:storage";
export const STREAM_OBJECT_CLASS_NAME = "StreamObject";
export const STREAM_BINDING_ENTRYPOINT = "StreamBinding";

/**
 * Name of the single Durable Object instance (and `BlobStore` namespace) all
 * stream data lives in — Miniflare's `idFromName("stream-data")` /
 * `BLOB_NAMESPACE` (`workers/stream/{binding,object}.worker.ts`).
 */
export const STREAM_OBJECT_NAME = "stream-data";

/** Durable Object namespace binding on the `stream` service. */
export const BINDING_STREAM_OBJECT = "STREAM_OBJECT";
/** Blob-storage disk service binding on the `stream` service. */
export const BINDING_STREAM_BLOBS = "STREAM_BLOBS";
/** Loopback fetcher binding used to resolve the runtime's public URL. */
export const BINDING_STREAM_LOOPBACK = "STREAM_LOOPBACK";
/** Set when control endpoints (fake timers, storage inspection) are enabled. */
export const BINDING_STREAM_ENABLE_CONTROL_ENDPOINTS =
  "STREAM_ENABLE_CONTROL_ENDPOINTS";

/** Reserved header carrying `{ name, args }` control operations in tests. */
export const HEADER_STREAM_CONTROL_OP = "cf-stream-control-op";

/** Loopback route target for the stream plugin's node-side handler. */
export const LOOPBACK_TARGET_STREAM = "stream";
/**
 * Loopback path returning the runtime's public URL as a JSON string (or
 * `null` before the entry socket is bound) — the equivalent of Miniflare's
 * `/core/public-url` loopback route (`workers/shared/public-url.ts`).
 */
export const PATH_STREAM_PUBLIC_URL = "/stream/public-url";

/**
 * Path prefix videos are served under, mirroring Miniflare's
 * `CorePaths.STREAM_VIDEO` (`workers/core/constants.ts`): the preview URL of
 * every video is `{publicUrl}/cdn-cgi/mf/stream/<id>/watch`.
 */
export const PATH_STREAM_VIDEO = "/cdn-cgi/mf/stream";
