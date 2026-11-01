import * as Lambda from "@/AWS/Lambda";
import * as S3 from "@/AWS/S3";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export class S3VersionedMultipartFunction extends Lambda.Function<S3VersionedMultipartFunction>()(
  "S3VersionedMultipartFunction",
) {}

const uploadRequest = Schema.Struct({
  Key: Schema.String,
  UploadId: Schema.String,
});

export default S3VersionedMultipartFunction.make(
  {
    main: import.meta.url,
    functionUrl: true,
    timeout: Duration.seconds(30),
    memorySize: 512,
  },
  Effect.gen(function* () {
    const props = { versioning: "Enabled", forceDestroy: true } as const;
    const buckets = {
      CreateMultipartUpload: yield* S3.Bucket(
        "VersionedMultipartCreateBucket",
        props,
      ),
      UploadPart: yield* S3.Bucket("VersionedMultipartUploadPartBucket", props),
      UploadPartCopy: yield* S3.Bucket("VersionedMultipartCopyBucket", props),
      UploadPartCopySource: yield* S3.Bucket(
        "VersionedMultipartCopySourceBucket",
        props,
      ),
      UploadPartCopyUnboundSource: yield* S3.Bucket(
        "VersionedMultipartCopyUnboundSourceBucket",
        props,
      ),
      ListParts: yield* S3.Bucket("VersionedMultipartListPartsBucket", props),
      ListMultipartUploads: yield* S3.Bucket(
        "VersionedMultipartListUploadsBucket",
        props,
      ),
      CompleteMultipartUpload: yield* S3.Bucket(
        "VersionedMultipartCompleteBucket",
        props,
      ),
      AbortMultipartUpload: yield* S3.Bucket(
        "VersionedMultipartAbortBucket",
        props,
      ),
    };
    const create = yield* S3.CreateMultipartUpload(
      buckets.CreateMultipartUpload,
    );
    const upload = yield* S3.UploadPart(buckets.UploadPart);
    const copy = yield* S3.UploadPartCopy(buckets.UploadPartCopy);
    yield* S3.GetObject(buckets.UploadPartCopySource);
    const parts = yield* S3.ListParts(buckets.ListParts);
    const uploads = yield* S3.ListMultipartUploads(
      buckets.ListMultipartUploads,
    );
    const complete = yield* S3.CompleteMultipartUpload(
      buckets.CompleteMultipartUpload,
    );
    const abort = yield* S3.AbortMultipartUpload(buckets.AbortMultipartUpload);
    const info = yield* Effect.forEach(
      Object.entries(buckets),
      ([binding, bucket]) =>
        Effect.gen(function* () {
          return {
            binding,
            bucketName: yield* bucket.bucketName,
            bucketArn: yield* bucket.bucketArn,
          };
        }),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = yield* Effect.sync(() => new URL(request.originalUrl));
        if (url.pathname === "/info") {
          const resolved = yield* Effect.forEach(info, (bucket) =>
            Effect.gen(function* () {
              return {
                binding: bucket.binding,
                bucketName: yield* bucket.bucketName,
                bucketArn: yield* bucket.bucketArn,
              };
            }),
          );
          if (
            resolved.some((bucket) => !bucket.bucketName || !bucket.bucketArn)
          ) {
            return HttpServerResponse.text("Outputs not hydrated yet", {
              status: 503,
            });
          }
          return yield* HttpServerResponse.json(resolved);
        }
        if (request.method !== "POST") {
          return HttpServerResponse.text("Use POST", { status: 405 });
        }
        const body = yield* request.json;
        switch (url.pathname) {
          case "/create": {
            const input = yield* Schema.decodeUnknownEffect(
              Schema.Struct({
                Key: Schema.String,
                ContentType: Schema.String,
              }),
            )(body);
            return yield* HttpServerResponse.json(yield* create(input));
          }
          case "/upload": {
            const input = yield* Schema.decodeUnknownEffect(
              Schema.Struct({
                ...uploadRequest.fields,
                PartNumber: Schema.Number,
                Body: Schema.String,
                Repeat: Schema.optional(Schema.Number),
              }),
            )(body);
            // Expand fixture bytes in Lambda to stay below invocation payload limits.
            const Body = yield* Effect.sync(() =>
              input.Body.repeat(input.Repeat ?? 1),
            );
            return yield* upload({
              Key: input.Key,
              UploadId: input.UploadId,
              PartNumber: input.PartNumber,
              Body,
            }).pipe(
              Effect.flatMap(HttpServerResponse.json),
              Effect.catchTag("NoSuchUpload", (error) =>
                HttpServerResponse.json({ tag: error._tag }, { status: 404 }),
              ),
            );
          }
          case "/copy": {
            const input = yield* Schema.decodeUnknownEffect(
              Schema.Struct({
                ...uploadRequest.fields,
                PartNumber: Schema.Number,
                CopySource: Schema.String,
              }),
            )(body);
            return yield* copy(input).pipe(
              Effect.flatMap(HttpServerResponse.json),
              Effect.catchTag("AccessDeniedException", () =>
                HttpServerResponse.json(
                  { tag: "AccessDeniedException" },
                  { status: 403 },
                ),
              ),
              Effect.catchTag(
                ["NoSuchUpload", "NoSuchVersion", "NoSuchKey"],
                (error) =>
                  HttpServerResponse.json({ tag: error._tag }, { status: 404 }),
              ),
              Effect.catchTag("InvalidRequest", (error) =>
                HttpServerResponse.json({ tag: error._tag }, { status: 400 }),
              ),
            );
          }
          case "/parts": {
            const input = yield* Schema.decodeUnknownEffect(
              Schema.Struct({
                ...uploadRequest.fields,
                MaxParts: Schema.optional(Schema.Number),
                PartNumberMarker: Schema.optional(Schema.String),
              }),
            )(body);
            return yield* parts(input).pipe(
              Effect.flatMap(HttpServerResponse.json),
              Effect.catchTag("NoSuchUpload", (error) =>
                HttpServerResponse.json({ tag: error._tag }, { status: 404 }),
              ),
            );
          }
          case "/uploads": {
            const input = yield* Schema.decodeUnknownEffect(
              Schema.Struct({
                Prefix: Schema.String,
                KeyMarker: Schema.optional(Schema.String),
                UploadIdMarker: Schema.optional(Schema.String),
                MaxUploads: Schema.optional(Schema.Number),
              }),
            )(body);
            return yield* HttpServerResponse.json(yield* uploads(input));
          }
          case "/complete": {
            const input = yield* Schema.decodeUnknownEffect(
              Schema.Struct({
                ...uploadRequest.fields,
                MultipartUpload: Schema.Struct({
                  Parts: Schema.Array(
                    Schema.Struct({
                      ETag: Schema.String,
                      PartNumber: Schema.Number,
                    }),
                  ),
                }),
              }),
            )(body);
            return yield* complete({
              ...input,
              MultipartUpload: { Parts: [...input.MultipartUpload.Parts] },
            }).pipe(
              Effect.flatMap(HttpServerResponse.json),
              Effect.catchTag("NoSuchUpload", (error) =>
                HttpServerResponse.json({ tag: error._tag }, { status: 404 }),
              ),
            );
          }
          case "/abort": {
            const input =
              yield* Schema.decodeUnknownEffect(uploadRequest)(body);
            return yield* abort(input).pipe(
              Effect.flatMap(() => HttpServerResponse.json({ aborted: true })),
              Effect.catchTag("NoSuchUpload", () =>
                HttpServerResponse.json(
                  { tag: "NoSuchUpload" },
                  { status: 404 },
                ),
              ),
            );
          }
          default:
            return HttpServerResponse.text("Not found", { status: 404 });
        }
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        S3.CreateMultipartUploadHttp,
        S3.UploadPartHttp,
        S3.UploadPartCopyHttp,
        S3.GetObjectHttp,
        S3.ListPartsHttp,
        S3.ListMultipartUploadsHttp,
        S3.CompleteMultipartUploadHttp,
        S3.AbortMultipartUploadHttp,
      ),
    ),
  ),
);
