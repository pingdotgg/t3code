/**
 * The local S3-compatible endpoint every locally-emulated (`dev:`) R2 bucket
 * is served on during `alchemy dev`: `{worker url}/cdn-cgi/local/r2/s3/{bucket}`,
 * hosted by the dev runtime of each Worker that binds the bucket.
 *
 * The credentials are a fixed, well-known pair. They only guard localhost
 * and exist so SigV4-signed requests and presigned URLs verify exactly like
 * they do against R2.
 *
 * Kept dependency-free: it is bundled into deployed Workers (presign
 * bindings) as well as imported by the dev runtime bindings.
 *
 * NOT exported from `index.ts`.
 */
export const LOCAL_R2_S3_PATH = "/cdn-cgi/local/r2/s3";

export const LOCAL_R2_S3_CREDENTIALS = {
  accessKeyId: "alchemy-local-r2",
  secretAccessKey: "alchemy-local-r2-secret",
} as const;
