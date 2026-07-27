import * as Lambda from "@/AWS/Lambda";
import * as S3 from "@/AWS/S3";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export class S3PresignTestFunction extends Lambda.Function<S3PresignTestFunction>()(
  "S3PresignTestFunction",
) {}

export default S3PresignTestFunction.make(
  {
    main: import.meta.url,
    url: true,
  },
  Effect.gen(function* () {
    const bucket = yield* S3.Bucket("PresignBucket", {
      forceDestroy: true,
    });

    const presignGetObject = yield* S3.PresignGetObject(bucket);
    const presignPutObject = yield* S3.PresignPutObject(bucket);
    const deleteObjects = yield* S3.DeleteObjects(bucket);
    const getObjectTagging = yield* S3.GetObjectTagging(bucket);
    const putObjectTagging = yield* S3.PutObjectTagging(bucket);
    const deleteObjectTagging = yield* S3.DeleteObjectTagging(bucket);
    const getObjectAttributes = yield* S3.GetObjectAttributes(bucket);
    const listObjectVersions = yield* S3.ListObjectVersions(bucket);
    const createMultipartUpload = yield* S3.CreateMultipartUpload(bucket);
    const uploadPart = yield* S3.UploadPart(bucket);
    const uploadPartCopy = yield* S3.UploadPartCopy(bucket);
    const listParts = yield* S3.ListParts(bucket);
    const listMultipartUploads = yield* S3.ListMultipartUploads(bucket);
    const completeMultipartUpload = yield* S3.CompleteMultipartUpload(bucket);
    const abortMultipartUpload = yield* S3.AbortMultipartUpload(bucket);
    const restoreObject = yield* S3.RestoreObject(bucket);
    const getObjectRetention = yield* S3.GetObjectRetention(bucket);
    const putObjectRetention = yield* S3.PutObjectRetention(bucket);
    const getObjectLegalHold = yield* S3.GetObjectLegalHold(bucket);
    const putObjectLegalHold = yield* S3.PutObjectLegalHold(bucket);
    const BucketName = yield* bucket.bucketName;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        // The first event after a cold start can observe not-yet-hydrated
        // resource Outputs (they resolve to `undefined` until the runtime
        // finishes hydrating resource state). Answer 503 so callers retry
        // instead of receiving presigned URLs for a bucket named
        // "undefined".
        const bucketName = yield* BucketName;
        if (!bucketName) {
          return HttpServerResponse.text("Outputs not hydrated yet", {
            status: 503,
          });
        }

        const key = url.searchParams.get("key");
        const requireKey = () =>
          HttpServerResponse.text("Missing key", { status: 400 });

        if (request.method === "GET" && pathname === "/bucket-name") {
          return yield* HttpServerResponse.json({ bucketName });
        }

        if (request.method === "GET" && pathname === "/presign-get") {
          if (!key) return requireKey();
          const expiresIn = url.searchParams.get("expiresIn");
          const contentType = url.searchParams.get("contentType");
          const presignedUrl = yield* presignGetObject({
            key,
            expiresIn: expiresIn ? Number(expiresIn) : undefined,
            contentType: contentType ?? undefined,
          });
          return yield* HttpServerResponse.json({ url: presignedUrl });
        }

        if (request.method === "GET" && pathname === "/presign-put") {
          if (!key) return requireKey();
          const expiresIn = url.searchParams.get("expiresIn");
          const contentType = url.searchParams.get("contentType");
          const presignedUrl = yield* presignPutObject({
            key,
            expiresIn: expiresIn ? Number(expiresIn) : undefined,
            contentType: contentType ?? undefined,
          });
          return yield* HttpServerResponse.json({ url: presignedUrl });
        }

        if (request.method === "GET" && pathname === "/delete-objects") {
          const keys = (url.searchParams.get("keys") ?? "")
            .split(",")
            .filter((k) => k.length > 0);
          const result = yield* deleteObjects({
            Delete: { Objects: keys.map((Key) => ({ Key })) },
          });
          return yield* HttpServerResponse.json({
            deleted: (result.Deleted ?? []).map((d) => d.Key),
            errors: (result.Errors ?? []).map((e) => e.Code),
          });
        }

        if (request.method === "GET" && pathname === "/put-tagging") {
          if (!key) return requireKey();
          const tagKey = url.searchParams.get("tagKey") ?? "status";
          const tagValue = url.searchParams.get("tagValue") ?? "test";
          yield* putObjectTagging({
            Key: key,
            Tagging: { TagSet: [{ Key: tagKey, Value: tagValue }] },
          });
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "GET" && pathname === "/get-tagging") {
          if (!key) return requireKey();
          const result = yield* getObjectTagging({ Key: key });
          return yield* HttpServerResponse.json({
            tags: Object.fromEntries(
              (result.TagSet ?? []).map((t) => [t.Key, t.Value]),
            ),
          });
        }

        if (request.method === "GET" && pathname === "/delete-tagging") {
          if (!key) return requireKey();
          yield* deleteObjectTagging({ Key: key });
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "GET" && pathname === "/attributes") {
          if (!key) return requireKey();
          const result = yield* getObjectAttributes({
            Key: key,
            ObjectAttributes: ["ObjectSize", "ETag", "StorageClass"],
          });
          return yield* HttpServerResponse.json({
            size: result.ObjectSize,
            etag: result.ETag,
            storageClass: result.StorageClass ?? "STANDARD",
          });
        }

        if (request.method === "GET" && pathname === "/versions") {
          const prefix = url.searchParams.get("prefix") ?? undefined;
          const result = yield* listObjectVersions({ Prefix: prefix });
          return yield* HttpServerResponse.json({
            versions: (result.Versions ?? []).map((v) => v.Key),
            deleteMarkers: (result.DeleteMarkers ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/multipart-list") {
          if (!key) return requireKey();
          // create → upload one part → observe via ListParts and
          // ListMultipartUploads → abort (leave nothing behind).
          const created = yield* createMultipartUpload({ Key: key });
          const uploadId = created.UploadId!;
          yield* uploadPart({
            Key: key,
            UploadId: uploadId,
            PartNumber: 1,
            Body: "multipart list probe",
          });
          const parts = yield* listParts({ Key: key, UploadId: uploadId });
          const uploads = yield* listMultipartUploads({ Prefix: key });
          yield* abortMultipartUpload({ Key: key, UploadId: uploadId });
          return yield* HttpServerResponse.json({
            parts: (parts.Parts ?? []).map((p) => p.PartNumber),
            uploads: (uploads.Uploads ?? []).map((u) => u.Key),
          });
        }

        if (request.method === "GET" && pathname === "/multipart-copy") {
          const src = url.searchParams.get("src");
          const dest = url.searchParams.get("dest");
          if (!src || !dest) {
            return HttpServerResponse.text("Missing src/dest", {
              status: 400,
            });
          }
          // single part sourced via UploadPartCopy (the only part may be
          // any size), then complete.
          const created = yield* createMultipartUpload({ Key: dest });
          const uploadId = created.UploadId!;
          const copied = yield* uploadPartCopy({
            Key: dest,
            UploadId: uploadId,
            PartNumber: 1,
            CopySource: `${bucketName}/${src}`,
          });
          const completed = yield* completeMultipartUpload({
            Key: dest,
            UploadId: uploadId,
            MultipartUpload: {
              Parts: [{ ETag: copied.CopyPartResult!.ETag!, PartNumber: 1 }],
            },
          });
          return yield* HttpServerResponse.json({ etag: completed.ETag });
        }

        // The routes below exercise bindings whose success path needs an
        // archived object or an Object Lock bucket. They return the typed
        // error tag so tests can assert the binding + IAM wiring works and
        // the failure is the *expected, typed* platform rejection.
        if (request.method === "GET" && pathname === "/restore") {
          if (!key) return requireKey();
          const outcome = yield* restoreObject({
            Key: key,
            RestoreRequest: {
              Days: 1,
              GlacierJobParameters: { Tier: "Standard" },
            },
          }).pipe(
            Effect.map((): { tag: string } => ({ tag: "success" })),
            Effect.catch((e) =>
              Effect.succeed<{ tag: string }>({ tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(outcome);
        }

        if (request.method === "GET" && pathname === "/retention") {
          if (!key) return requireKey();
          const outcome = yield* getObjectRetention({ Key: key }).pipe(
            Effect.map((): { tag: string } => ({ tag: "success" })),
            Effect.catch((e) =>
              Effect.succeed<{ tag: string }>({ tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(outcome);
        }

        if (request.method === "GET" && pathname === "/retention-put") {
          if (!key) return requireKey();
          const outcome = yield* putObjectRetention({
            Key: key,
            Retention: {
              Mode: "GOVERNANCE",
              RetainUntilDate: new Date(Date.now() + 60_000),
            },
          }).pipe(
            Effect.map((): { tag: string } => ({ tag: "success" })),
            Effect.catch((e) =>
              Effect.succeed<{ tag: string }>({ tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(outcome);
        }

        if (request.method === "GET" && pathname === "/legal-hold") {
          if (!key) return requireKey();
          const outcome = yield* getObjectLegalHold({ Key: key }).pipe(
            Effect.map((): { tag: string } => ({ tag: "success" })),
            Effect.catch((e) =>
              Effect.succeed<{ tag: string }>({ tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(outcome);
        }

        if (request.method === "GET" && pathname === "/legal-hold-put") {
          if (!key) return requireKey();
          const outcome = yield* putObjectLegalHold({
            Key: key,
            LegalHold: { Status: "ON" },
          }).pipe(
            Effect.map((): { tag: string } => ({ tag: "success" })),
            Effect.catch((e) =>
              Effect.succeed<{ tag: string }>({ tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(outcome);
        }

        return yield* HttpServerResponse.json(
          {
            error: "Not found",
            method: request.method,
            pathname,
          },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        S3.PresignGetObjectHttp,
        S3.PresignPutObjectHttp,
        S3.DeleteObjectsHttp,
        S3.GetObjectTaggingHttp,
        S3.PutObjectTaggingHttp,
        S3.DeleteObjectTaggingHttp,
        S3.GetObjectAttributesHttp,
        S3.ListObjectVersionsHttp,
        S3.CreateMultipartUploadHttp,
        S3.UploadPartHttp,
        S3.UploadPartCopyHttp,
        S3.ListPartsHttp,
        S3.ListMultipartUploadsHttp,
        S3.CompleteMultipartUploadHttp,
        S3.AbortMultipartUploadHttp,
        S3.RestoreObjectHttp,
        S3.GetObjectRetentionHttp,
        S3.PutObjectRetentionHttp,
        S3.GetObjectLegalHoldHttp,
        S3.PutObjectLegalHoldHttp,
      ),
    ),
  ),
);
