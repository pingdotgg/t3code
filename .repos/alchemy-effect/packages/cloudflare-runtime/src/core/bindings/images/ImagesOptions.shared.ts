/** Options for a local Images binding. */
export interface ImagesProps {
  /** Binding name exposed on `env`. */
  readonly binding: string;
}

/**
 * A single `images` service hosts every Images binding in a worker (all
 * bindings share the same hosted-image store, mirroring Miniflare where every
 * binding's service reads the shared `images:ns:data` KV namespace).
 */
export const SERVICE_IMAGES = "images";
/** KV-protocol service fronting the shared hosted-image store. */
export const SERVICE_IMAGES_STORE = "images:store";
/** Disk service backing the hosted-image store's Durable Object storage. */
export const SERVICE_IMAGES_STORAGE = "images:storage";

export const BINDING_IMAGES_STORE = "IMAGES_STORE";
export const BINDING_IMAGES_LOOPBACK = "LOOPBACK";

/**
 * Path prefix for locally-hosted image delivery, mirroring Miniflare's
 * `CorePaths.IMAGE_DELIVERY` (`workers-sdk/packages/miniflare/src/workers/core/constants.ts`).
 * Variant URLs returned by the hosted-image CRUD surface point here; an entry
 * middleware routes the prefix to the images service.
 */
export const PATH_IMAGE_DELIVERY = "/cdn-cgi/mf/imagedelivery";

/**
 * Loopback path the images worker queries to resolve the runtime entry URL
 * for building absolute variant URLs (Miniflare's `/core/public-url`).
 */
export const PATH_IMAGES_PUBLIC_URL = "/images/public-url";

/**
 * Fixed KV namespace id for the shared hosted-image store (Miniflare routes
 * every images binding to the `"images-data"` namespace).
 */
export const IMAGES_STORE_NAMESPACE = "images-data";
