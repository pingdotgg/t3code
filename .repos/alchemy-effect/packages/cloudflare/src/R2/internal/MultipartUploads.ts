import * as AwsCredentials from "@distilled.cloud/aws/Credentials";
import * as AwsEndpoint from "@distilled.cloud/aws/Endpoint";
import type { RegionName } from "@distilled.cloud/aws/Region";
import * as s3 from "@distilled.cloud/aws/s3";
import * as accounts from "@distilled.cloud/cloudflare/accounts";
import * as user from "@distilled.cloud/cloudflare/user";
import { sha256 } from "alchemy/Util/sha256";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { Credentials } from "../../Credentials.ts";
import type { Bucket } from "../Bucket.ts";
import { liveEndpoint } from "../S3CredentialsBinding.ts";

/**
 * The outcome of {@link abortMultipartUploads}: how many uploads were
 * aborted, or why they could not be.
 */
export type AbortMultipartUploadsResult = { aborted: number } | { skipped: string };

/**
 * Best-effort: abort every incomplete multipart upload in a bucket.
 *
 * R2 refuses to delete a bucket that holds incomplete multipart uploads, and
 * the Cloudflare REST API cannot list or abort them — only R2's S3 API can.
 * S3 credentials derive from an API token (access key id = token id, secret
 * = SHA-256 of the token value), so this only works when alchemy is
 * authenticated with an API token that may write the bucket's objects. It
 * never creates a token: with OAuth or a global API key, or when the token
 * lacks the permission, it reports why it skipped instead of failing.
 */
export const abortMultipartUploads = Effect.fn("R2.abortMultipartUploads")(
  function* (accountId: string, bucketName: string, jurisdiction: Bucket.Jurisdiction) {
    const resolved = yield* yield* Credentials;
    if (resolved.type !== "apiToken") {
      return {
        skipped: `alchemy is authenticated with ${resolved.type}, not an API token`,
      } as AbortMultipartUploadsResult;
    }
    // Account-owned and user-owned tokens verify on different routes.
    const { id: accessKeyId } = yield* accounts
      .verifyToken({ accountId })
      .pipe(Effect.catch(() => user.verifyToken({})));
    const secretAccessKey = yield* resolved.apiToken.pipe(Redacted.value, sha256);
    const r2S3 = Layer.mergeAll(
      Layer.succeed(
        AwsCredentials.Credentials,
        Effect.succeed({
          accessKeyId: Redacted.make(accessKeyId),
          secretAccessKey: Redacted.make(secretAccessKey),
          sessionToken: undefined,
          // R2 signs with the `auto` region.
          region: "auto" as RegionName,
        }),
      ),
      AwsEndpoint.of(liveEndpoint(accountId, jurisdiction)),
    );

    const aborted = yield* Stream.paginate(
      {
        keyMarker: undefined as string | undefined,
        uploadIdMarker: undefined as string | undefined,
      },
      (markers) =>
        s3
          .listMultipartUploads({
            Bucket: bucketName,
            KeyMarker: markers.keyMarker,
            UploadIdMarker: markers.uploadIdMarker,
          })
          .pipe(
            Effect.map(
              (page) =>
                [
                  page.Uploads ?? [],
                  page.IsTruncated && (page.NextKeyMarker || page.NextUploadIdMarker)
                    ? Option.some({
                        keyMarker: page.NextKeyMarker,
                        uploadIdMarker: page.NextUploadIdMarker,
                      })
                    : Option.none(),
                ] as const,
            ),
          ),
    ).pipe(
      Stream.filter(
        (upload): upload is s3.MultipartUpload & { Key: string; UploadId: string } =>
          upload.Key !== undefined && upload.UploadId !== undefined,
      ),
      Stream.mapEffect(
        (upload) =>
          s3
            .abortMultipartUpload({
              Bucket: bucketName,
              Key: upload.Key,
              UploadId: upload.UploadId,
            })
            // Completed or aborted by someone else in the meantime.
            .pipe(Effect.catchTag("NoSuchUpload", () => Effect.void)),
        { concurrency: 10 },
      ),
      Stream.runCount,
      Effect.provide(r2S3),
    );
    return { aborted } as AbortMultipartUploadsResult;
  },
  Effect.catch((error) => Effect.succeed<AbortMultipartUploadsResult>({ skipped: error.message })),
);
