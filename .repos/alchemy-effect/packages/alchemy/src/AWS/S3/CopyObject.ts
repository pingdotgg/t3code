// @ts-nocheck
import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Bucket } from "./Bucket.ts";

export interface CopyObjectRequest extends Omit<
  S3.CopyObjectRequest,
  "Bucket"
> {}

/**
 * Runtime binding for `s3:CopyObject`.
 *
 * Bind this operation to the destination bucket to get a callable that copies
 * objects server-side — no download/re-upload round trip. `CopySource` names
 * the source as `"source-bucket/key"`. Provide the implementation with
 * `Effect.provide(AWS.S3.CopyObjectHttp)`. The binding grants reads of current
 * and specific source versions within the bound bucket. Cross-bucket copies
 * require a separate read grant on the source bucket.
 *
 * ### Copying Objects
 * **Example:** Copy an Object Within a Bucket
 * ```typescript
 * // init — bind the operation to the destination bucket
 * const copyObject = yield* AWS.S3.CopyObject(bucket);
 *
 * // runtime — promote a staged upload to its final key
 * yield* copyObject({
 *   CopySource: `${bucketName}/incoming/report.pdf`,
 *   Key: "published/report.pdf",
 * });
 * ```
 *
 * ### Copying a Specific Version
 * **Example:** Restore an Older Version to a New Key
 * ```typescript
 * const sourceKey = "reports/annual report.pdf";
 * const encodedKey = sourceKey.split("/").map(encodeURIComponent).join("/");
 * yield* copyObject({
 *   CopySource: `${bucketName}/${encodedKey}?versionId=${encodeURIComponent(versionId)}`,
 *   Key: "restored/annual report.pdf",
 * });
 * ```
 *
 * The source version remains unchanged. In a versioned destination bucket,
 * the copy creates a new version and returns its `VersionId`.
 *
 * ### Copying Between Buckets
 * **Example:** Grant reads on a separate source bucket
 * ```typescript
 * yield* AWS.S3.GetObject(sourceBucket);
 * const copyObject = yield* AWS.S3.CopyObject(destinationBucket);
 * // Provide both AWS.S3.GetObjectHttp and AWS.S3.CopyObjectHttp on the host.
 * ```
 *
 * The source read binding grants current and version-specific reads without
 * granting writes to the source. Copying tags, ACLs, Object Lock settings, or
 * KMS-encrypted data requires the corresponding additional permissions.
 *
 * @binding
 */
export interface CopyObject extends Binding.Service<
  CopyObject,
  "AWS.S3.CopyObject",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: CopyObjectRequest,
    ) => Effect.Effect<S3.CopyObjectOutput, S3.CopyObjectError>
  >
> {}

export const CopyObject = Binding.Service<CopyObject>("AWS.S3.CopyObject");
