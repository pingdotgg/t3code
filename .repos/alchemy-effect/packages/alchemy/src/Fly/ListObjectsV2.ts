import type * as S3 from "@distilled.cloud/aws/s3";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Bucket } from "./Bucket.ts";
import type { TigrisCredentialsMissing } from "./Errors.ts";

export interface ListObjectsV2Request extends Omit<
  S3.ListObjectsV2Request,
  "Bucket"
> {}

/**
 * Runtime binding for Tigris `ListObjectsV2` over the S3 API.
 *
 * Bind this operation to a {@link Bucket} in Service init. Provide
 * {@link ListObjectsV2Http}.
 *
 *
 * ### Listing Objects
 * **Example:** List Objects Under a Prefix
 * ```typescript
 * const listObjects = yield* Fly.ListObjectsV2(Data);
 * const result = yield* listObjects({ Prefix: "jobs/", MaxKeys: 100 });
 * ```
 *
 * @binding
 */
export interface ListObjectsV2 extends Binding.Service<
  ListObjectsV2,
  "Fly.ListObjectsV2",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request?: ListObjectsV2Request,
    ) => Effect.Effect<
      S3.ListObjectsV2Output,
      S3.ListObjectsV2Error | TigrisCredentialsMissing,
      RuntimeContext
    >
  >
> {}

export const ListObjectsV2 =
  Binding.Service<ListObjectsV2>("Fly.ListObjectsV2");
