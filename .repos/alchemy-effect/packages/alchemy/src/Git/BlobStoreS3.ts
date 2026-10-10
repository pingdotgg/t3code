/**
 * `Git.BlobStoreS3` — AWS S3 implementation of {@link BlobStore}.
 *
 * Runs the git service's bulk bytes (packs, clone bundles, oversize
 * objects, push spill) on an S3 bucket while compute stays on Cloudflare.
 * It is built over the S3 bindings (`AWS.S3.GetObject`, `PutObject`, …),
 * so one provision serves the Worker and the Repo DO alike, exactly like
 * {@link BlobStoreR2}: the bucket is an `AWS.S3.Bucket` resource, the
 * Worker gets a least-privilege IAM identity minted for it, and every
 * request is signed with credentials assumed at runtime, in the bucket's
 * region.
 *
 * Latency note: every blob operation crosses the internet to S3 (no
 * Cloudflare-internal path), so serving-path reads are slower than R2.
 * The window-coalescing in `ObjectStore`/`PackSource` keeps request
 * counts low, but R2 remains the recommended default for
 * Cloudflare-hosted assemblies.
 *
 * ### Providing the store
 * **Example:** Packs on S3, compute on Cloudflare
 * ```typescript
 * const GitObjects = AWS.S3.Bucket("GitObjects");
 *
 * const GitLive = Git.ApiLive.pipe(
 *   Layer.provide(Git.ApiHandlersLive),
 *   Layer.provide(Git.ReposDurableObject),
 *   Layer.provide(Git.RegistryDurableObject),
 *   Layer.provide(Git.BlobStoreS3(GitObjects)),
 * );
 * ```
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AbortMultipartUpload } from "../AWS/S3/AbortMultipartUpload.ts";
import { AbortMultipartUploadHttp } from "../AWS/S3/AbortMultipartUploadHttp.ts";
import { CompleteMultipartUpload } from "../AWS/S3/CompleteMultipartUpload.ts";
import { CompleteMultipartUploadHttp } from "../AWS/S3/CompleteMultipartUploadHttp.ts";
import { CreateMultipartUpload } from "../AWS/S3/CreateMultipartUpload.ts";
import { CreateMultipartUploadHttp } from "../AWS/S3/CreateMultipartUploadHttp.ts";
import { DeleteObjects } from "../AWS/S3/DeleteObjects.ts";
import { DeleteObjectsHttp } from "../AWS/S3/DeleteObjectsHttp.ts";
import { GetObject } from "../AWS/S3/GetObject.ts";
import { GetObjectHttp } from "../AWS/S3/GetObjectHttp.ts";
import { HeadObject } from "../AWS/S3/HeadObject.ts";
import { HeadObjectHttp } from "../AWS/S3/HeadObjectHttp.ts";
import { ListObjectsV2 } from "../AWS/S3/ListObjectsV2.ts";
import { ListObjectsV2Http } from "../AWS/S3/ListObjectsV2Http.ts";
import { PutObject } from "../AWS/S3/PutObject.ts";
import { PutObjectHttp } from "../AWS/S3/PutObjectHttp.ts";
import { UploadPart } from "../AWS/S3/UploadPart.ts";
import { UploadPartHttp } from "../AWS/S3/UploadPartHttp.ts";
import {
  BlobStore,
  BlobStoreError,
  type BlobBody,
  type BlobMeta,
  orderedParts,
  type BlobMultipart,
  type BlobStoreShape,
} from "./BlobStore.ts";

const s3Error =
  (what: string) =>
  (error: { readonly _tag?: string; readonly message?: string }) =>
    new BlobStoreError({
      reason: `${what}: ${error._tag ?? "S3Error"}${
        error.message ? `: ${error.message}` : ""
      }`,
    });

const collectBytes = (
  stream: Stream.Stream<Uint8Array, Error>,
  what: string,
): Effect.Effect<Uint8Array, BlobStoreError> =>
  Stream.runCollect(stream).pipe(
    Effect.mapError((error) => s3Error(what)({ message: String(error) })),
    Effect.map((chunks) => {
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const out = new Uint8Array(total);
      let at = 0;
      for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.length;
      }
      return out;
    }),
  );

/**
 * S3-backed {@link BlobStore} using the given bucket. Accepts an
 * `AWS.S3.Bucket` resource or its declaration Effect, like {@link BlobStoreR2}.
 * See the module doc for identity and latency semantics.
 *
 * @layer
 * @provides Git.BlobStore
 */
export const BlobStoreS3 = (
  bucket: Parameters<typeof GetObject>[0],
): Layer.Layer<BlobStore> =>
  Layer.effect(
    BlobStore,
    Effect.gen(function* () {
      const getObject = yield* GetObject(bucket);
      const putObject = yield* PutObject(bucket);
      const headObject = yield* HeadObject(bucket);
      const deleteObjects = yield* DeleteObjects(bucket);
      const listObjectsV2 = yield* ListObjectsV2(bucket);
      const createMultipart = yield* CreateMultipartUpload(bucket);
      const uploadPart = yield* UploadPart(bucket);
      const completeMultipart = yield* CompleteMultipartUpload(bucket);
      const abortMultipart = yield* AbortMultipartUpload(bucket);

      return {
        get: (key, range) =>
          getObject({
            Key: key,
            Range:
              range === undefined
                ? undefined
                : `bytes=${range.offset}-${range.offset + range.length - 1}`,
          }).pipe(
            Effect.map((output): BlobBody | null => {
              const body = output.Body ?? Stream.empty;
              return {
                size: output.ContentLength ?? 0,
                bytes: collectBytes(body, `get ${key}`),
                stream: body.pipe(
                  Stream.mapError((error) =>
                    s3Error(`stream ${key}`)({ message: String(error) }),
                  ),
                ),
              };
            }),
            Effect.catchTag("NoSuchKey", () => Effect.succeed(null)),
            Effect.mapError(s3Error(`get ${key}`)),
          ),

        put: (key, body, opts) =>
          putObject({
            Key: key,
            Body: body,
            ContentLength:
              body instanceof Uint8Array ? body.length : opts?.contentLength,
          }).pipe(Effect.mapError(s3Error(`put ${key}`)), Effect.asVoid),

        head: (key) =>
          headObject({ Key: key }).pipe(
            Effect.map((output): BlobMeta => ({
              key,
              size: output.ContentLength ?? 0,
            })),
            Effect.catchTag("NotFound", () => Effect.succeed(null)),
            Effect.mapError(s3Error(`head ${key}`)),
          ),

        multipart: (key) =>
          createMultipart({ Key: key }).pipe(
            Effect.mapError(s3Error(`multipart ${key}`)),
            Effect.map((created): BlobMultipart => {
              const UploadId = created.UploadId ?? "";
              return {
                uploadId: UploadId,
                uploadPart: (partNumber, part) =>
                  uploadPart({
                    Key: key,
                    UploadId,
                    PartNumber: partNumber,
                    Body: part,
                    ContentLength: part.length,
                  }).pipe(
                    Effect.mapError(s3Error(`part ${partNumber} of ${key}`)),
                    Effect.map((uploaded) => ({
                      partNumber,
                      etag: uploaded.ETag ?? "",
                    })),
                  ),
                complete: (parts) =>
                  completeMultipart({
                    Key: key,
                    UploadId,
                    MultipartUpload: {
                      Parts: orderedParts(parts).map((p) => ({
                        PartNumber: p.partNumber,
                        ETag: p.etag,
                      })),
                    },
                  }).pipe(
                    Effect.mapError(s3Error(`complete ${key}`)),
                    Effect.asVoid,
                  ),
                abort: abortMultipart({ Key: key, UploadId }).pipe(
                  Effect.mapError(s3Error(`abort ${key}`)),
                  Effect.asVoid,
                ),
              };
            }),
          ),
        uploadPart: (key, uploadId, partNumber, part) =>
          uploadPart({
            Key: key,
            UploadId: uploadId,
            PartNumber: partNumber,
            Body: part,
            ContentLength: part.length,
          }).pipe(
            Effect.mapError(s3Error(`part ${partNumber} of ${key}`)),
            Effect.map((uploaded) => ({
              partNumber,
              etag: uploaded.ETag ?? "",
            })),
          ),
        delete: (keys) => {
          const list = typeof keys === "string" ? [keys] : [...keys];
          if (list.length === 0) return Effect.void;
          return deleteObjects({
            Delete: {
              Objects: list.map((Key) => ({ Key })),
              Quiet: true,
            },
          }).pipe(Effect.mapError(s3Error("delete")), Effect.asVoid);
        },

        list: (prefix) =>
          Stream.paginate(
            undefined as string | undefined,
            (ContinuationToken) =>
              listObjectsV2({
                Prefix: prefix,
                ContinuationToken,
                MaxKeys: 1000,
              }).pipe(
                Effect.mapError(s3Error(`list ${prefix}`)),
                Effect.map((page) => {
                  const metas = (page.Contents ?? []).flatMap(
                    (object): Array<BlobMeta> =>
                      object.Key === undefined
                        ? []
                        : [{ key: object.Key, size: object.Size ?? 0 }],
                  );
                  return [
                    metas,
                    page.IsTruncated && page.NextContinuationToken
                      ? Option.some(page.NextContinuationToken)
                      : Option.none<string>(),
                  ] as const;
                }),
              ),
          ),
      } satisfies BlobStoreShape;
    }),
  ).pipe(
    Layer.provide([
      GetObjectHttp,
      PutObjectHttp,
      HeadObjectHttp,
      DeleteObjectsHttp,
      ListObjectsV2Http,
      CreateMultipartUploadHttp,
      UploadPartHttp,
      CompleteMultipartUploadHttp,
      AbortMultipartUploadHttp,
    ]),
  ) as never;
