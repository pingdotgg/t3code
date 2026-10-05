import type * as iamcredentials from "@distilled.cloud/gcp/iamcredentials_v1";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Bucket } from "./Bucket.ts";

export interface SignGetObjectUrlRequest {
  /** Object name (key) to mint a signed download URL for. */
  object: string;
  /** Serve this generation instead of the live one. */
  generation?: string;
  /**
   * Seconds the URL stays valid (at most 604800, seven days).
   * @default 900
   */
  expiresIn?: number;
  /** Override the `Content-Type` Cloud Storage responds with. */
  contentType?: string;
}

/** The runtime could not resolve its own service account to sign with. */
export class SignedUrlFailed extends Data.TaggedError(
  "GCP.Storage.SignedUrlFailed",
)<{
  message: string;
  cause?: unknown;
}> {}

export type SignGetObjectUrlError =
  | SignedUrlFailed
  | iamcredentials.SignBlobProjectsServiceAccountsError;

/**
 * Mint V4 signed download (GET) URLs for objects in a Cloud Storage
 * {@link Bucket}, so a browser can fetch an object without Google
 * credentials.
 *
 * The URL is signed with the host's own runtime service account through
 * the IAM Credentials `signBlob` API (no key file). The binding grants the
 * host `roles/storage.objectViewer` on the bucket (a signed URL carries the
 * signer's permissions) and `roles/iam.serviceAccountTokenCreator` on its
 * own service account only. See the [signed URL
 * guide](https://cloud.google.com/storage/docs/access-control/signed-urls).
 *
 * ### Signing Download URLs
 * **Example:** Mint a signed GET URL
 * ```typescript
 * const signGetObjectUrl = yield* GCP.Storage.SignGetObjectUrl(bucket);
 * const url = yield* signGetObjectUrl({ object: "reports/2026.pdf" });
 * // hand `url` to a browser — it downloads the object without credentials
 * // …provided with Effect.provide(GCP.Storage.SignGetObjectUrlHttp)
 * ```
 *
 * **Example:** Custom expiry and response Content-Type
 * ```typescript
 * const url = yield* signGetObjectUrl({
 *   object: "reports/2026.pdf",
 *   expiresIn: 3600,
 *   contentType: "application/pdf",
 * });
 * ```
 *
 * @binding
 * @category Storage
 */
export interface SignGetObjectUrl extends Binding.Service<
  SignGetObjectUrl,
  "GCP.Storage.SignGetObjectUrl",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: SignGetObjectUrlRequest,
    ) => Effect.Effect<string, SignGetObjectUrlError, RuntimeContext>
  >
> {}

export const SignGetObjectUrl = Binding.Service<SignGetObjectUrl>(
  "GCP.Storage.SignGetObjectUrl",
);
