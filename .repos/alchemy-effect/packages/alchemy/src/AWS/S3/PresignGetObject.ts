import type { PresignError } from "@distilled.cloud/aws/Presign";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Bucket } from "./Bucket.ts";

export interface PresignGetObjectRequest {
  /**
   * Key of the object to mint a presigned download URL for.
   */
  key: string;
  /**
   * Specific object version to download. Signed as the `versionId` query
   * parameter. If omitted, downloads the current version when the URL is used.
   * Use the string `"null"` to select an existing null version.
   */
  versionId?: string;
  /**
   * Number of seconds the URL remains valid.
   * @default 900
   */
  expiresIn?: number;
  /**
   * Override the `Content-Type` S3 responds with (signed as the
   * `response-content-type` query parameter).
   */
  contentType?: string;
}

/**
 * Mint presigned download (GET) URLs for objects in a {@link Bucket}.
 *
 * Presigning is a pure SigV4 computation performed client-side with the
 * Function's own credentials — no S3 API call is made. Because the URL
 * inherits the signer's IAM permissions, the binding grants `s3:GetObject`
 * and `s3:GetObjectVersion` on the bucket's objects to the host Function.
 * See the [S3 presigned URL
 * guide](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html).
 *
 * ### Presigning Download URLs
 * **Example:** Mint a presigned GET URL
 * ```typescript
 * const presignGetObject = yield* S3.PresignGetObject(bucket);
 * const url = yield* presignGetObject({ key: "reports/2026.pdf" });
 * // hand `url` to a browser — it can download the object without AWS credentials
 * ```
 *
 * ### Downloading a Specific Version
 * **Example:** Mint a presigned GET URL for an older version
 * ```typescript
 * const presignGetObject = yield* S3.PresignGetObject(bucket);
 * const url = yield* presignGetObject({
 *   key: "reports/2026.pdf",
 *   versionId: "3HL4kqtJlcpXroDTDmJ+rmSpXd3dIbrHY+MTRCxf3vjVBH40Nrjfkd",
 * });
 * // downloads this version even if the key has since been overwritten
 * ```
 *
 * ### Customizing Download URLs
 * **Example:** Custom expiry and response Content-Type
 * ```typescript
 * const url = yield* presignGetObject({
 *   key: "reports/2026.pdf",
 *   expiresIn: 3600, // valid for 1 hour
 *   contentType: "application/pdf",
 * });
 * ```
 *
 * @see https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html
 *
 * @binding
 */
export interface PresignGetObject extends Binding.Service<
  PresignGetObject,
  "AWS.S3.PresignGetObject",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (request: PresignGetObjectRequest) => Effect.Effect<string, PresignError>
  >
> {}

export const PresignGetObject = Binding.Service<PresignGetObject>(
  "AWS.S3.PresignGetObject",
);
