import type { CredentialsError } from "@distilled.cloud/aws/Credentials";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Bucket } from "./Bucket.ts";

export interface PresignGetObjectRequest {
  /**
   * Key of the object to mint a presigned download URL for.
   */
  key: string;
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
 * on the bucket's objects to the host Function.
 *
 * @section Presigning Download URLs
 * @example Mint a presigned GET URL
 * ```typescript
 * const presignGetObject = yield* S3.PresignGetObject(bucket);
 * const url = yield* presignGetObject({ key: "reports/2026.pdf" });
 * // hand `url` to a browser — it can download the object without AWS credentials
 * ```
 *
 * @example Custom expiry and response Content-Type
 * ```typescript
 * const url = yield* presignGetObject({
 *   key: "reports/2026.pdf",
 *   expiresIn: 3600, // valid for 1 hour
 *   contentType: "application/pdf",
 * });
 * ```
 *
 * @binding
 */
export interface PresignGetObject extends Binding.Service<
  PresignGetObject,
  "AWS.S3.PresignGetObject",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: PresignGetObjectRequest,
    ) => Effect.Effect<string, CredentialsError>
  >
> {}

export const PresignGetObject = Binding.Service<PresignGetObject>(
  "AWS.S3.PresignGetObject",
);
