/**
 * vinext data-cache adapter builder for S3.
 *
 * AWS.Website.Vinext injects this adapter automatically.
 * The runtime factory reads `CACHE_BUCKET_NAME` from the Lambda
 * environment (Alchemy's `AWS.Website.Vinext` sets it). The runtime
 * talks distilled `@distilled.cloud/aws/s3`, the same client
 * `AWS.S3.GetObject` / `PutObject` wrap.
 *
 * If the bucket env is missing (local `vinext start`), vinext logs and
 * falls back to the in-memory handler.
 */
import { fileURLToPath } from "node:url";
import type { S3AdapterOptions } from "./s3-runtime.ts";

export type { S3AdapterOptions } from "./s3-runtime.ts";

export const DEFAULT_CACHE_BUCKET_ENV = "CACHE_BUCKET_NAME";
export const DEFAULT_CACHE_PREFIX = "vinext-cache/";

export const s3Adapter = (options?: S3AdapterOptions) => {
  if (
    options?.bucketEnv !== undefined &&
    typeof options.bucketEnv !== "string"
  ) {
    throw new TypeError(
      "[vinext] s3Adapter({ bucketEnv }) must be a string env var name.",
    );
  }
  return {
    adapter: fileURLToPath(new URL("./s3-runtime.js", import.meta.url)),
    options,
  };
};
