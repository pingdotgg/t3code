import type * as S3 from "@distilled.cloud/aws/s3";
import type * as Config from "effect/Config";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Bucket } from "./Bucket.ts";
import type { RailwayS3CredentialsMissing } from "./BucketBinding.ts";

export interface HeadObjectRequest extends Omit<
  S3.HeadObjectRequest,
  "Bucket"
> {}

/**
 * Runtime binding for Railway `HeadObject` over the S3 API.
 *
 * Bind this operation to a {@link Bucket} in Service init. Provide
 * {@link HeadObjectHttp}.
 *
 *
 * ### Inspecting Objects
 * **Example:** Check an Object's Metadata
 * ```typescript
 * const headObject = yield* Railway.HeadObject(Data);
 * const head = yield* headObject({ Key: "hello.txt" });
 * ```
 *
 * @binding
 */
export interface HeadObject extends Binding.Service<
  HeadObject,
  "Railway.HeadObject",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request?: HeadObjectRequest,
    ) => Effect.Effect<
      S3.HeadObjectOutput,
      S3.HeadObjectError | Config.ConfigError | RailwayS3CredentialsMissing,
      RuntimeContext
    >
  >
> {}

export const HeadObject = Binding.Service<HeadObject>("Railway.HeadObject");
