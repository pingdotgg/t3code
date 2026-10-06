import * as Lambda from "@/AWS/Lambda";
import * as S3 from "@/AWS/S3";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export class VersionedObjectFunction extends Lambda.Function<VersionedObjectFunction>()(
  "VersionedObjectFunction",
) {}

const bucket = (name: string) =>
  S3.Bucket(name, {
    versioning: "Enabled",
    forceDestroy: true,
  });

const Tags = Schema.Array(
  Schema.Struct({ Key: Schema.String, Value: Schema.String }),
);
const Objects = Schema.Array(
  Schema.Struct({
    Key: Schema.String,
    VersionId: Schema.optional(Schema.String),
  }),
);

export default VersionedObjectFunction.make(
  {
    main: import.meta.url,
    functionUrl: true,
    timeout: Duration.seconds(30),
    memorySize: 512,
  },
  Effect.gen(function* () {
    const buckets = yield* Effect.all({
      GetObject: bucket("GetObjectBucket"),
      PutObject: bucket("PutObjectBucket"),
      HeadObject: bucket("HeadObjectBucket"),
      GetObjectAttributes: bucket("GetObjectAttributesBucket"),
      CopyObject: bucket("CopyObjectBucket"),
      CopySource: bucket("CopySourceBucket"),
      UnboundSource: bucket("UnboundSourceBucket"),
      DeleteObject: bucket("DeleteObjectBucket"),
      DeleteObjects: bucket("DeleteObjectsBucket"),
      ListObjectsV2: bucket("ListObjectsV2Bucket"),
      ListObjectVersions: bucket("ListObjectVersionsBucket"),
      GetObjectTagging: bucket("GetObjectTaggingBucket"),
      PutObjectTagging: bucket("PutObjectTaggingBucket"),
      DeleteObjectTagging: bucket("DeleteObjectTaggingBucket"),
      PresignPutObject: bucket("PresignPutObjectBucket"),
    });
    const info = yield* Effect.forEach(
      Object.entries(buckets),
      ([name, resource]) =>
        Effect.gen(function* () {
          const bucketName = yield* resource.bucketName;
          const bucketArn = yield* resource.bucketArn;
          return Effect.gen(function* () {
            return [
              name,
              { bucketName: yield* bucketName, bucketArn: yield* bucketArn },
            ] as const;
          });
        }),
    );
    const get = yield* S3.GetObject(buckets.GetObject);
    const put = yield* S3.PutObject(buckets.PutObject);
    const head = yield* S3.HeadObject(buckets.HeadObject);
    const attributes = yield* S3.GetObjectAttributes(
      buckets.GetObjectAttributes,
    );
    const copy = yield* S3.CopyObject(buckets.CopyObject);
    yield* S3.GetObject(buckets.CopySource);
    const remove = yield* S3.DeleteObject(buckets.DeleteObject);
    const removeMany = yield* S3.DeleteObjects(buckets.DeleteObjects);
    const list = yield* S3.ListObjectsV2(buckets.ListObjectsV2);
    const versions = yield* S3.ListObjectVersions(buckets.ListObjectVersions);
    const getTags = yield* S3.GetObjectTagging(buckets.GetObjectTagging);
    const putTags = yield* S3.PutObjectTagging(buckets.PutObjectTagging);
    const deleteTags = yield* S3.DeleteObjectTagging(
      buckets.DeleteObjectTagging,
    );
    const presignPut = yield* S3.PresignPutObject(buckets.PresignPutObject);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = yield* Effect.sync(() => new URL(request.originalUrl));
        const operation = url.pathname.slice(1);
        if (operation === "info") {
          return yield* HttpServerResponse.json(
            Object.fromEntries(yield* Effect.all(info)),
          );
        }
        const Key = url.searchParams.get("key") ?? "versions.txt";
        const VersionId = url.searchParams.get("versionId") ?? undefined;
        switch (operation) {
          case "GetObject":
            return yield* get({ Key, VersionId }).pipe(
              Effect.flatMap((result) =>
                Effect.gen(function* () {
                  const body = yield* Stream.mkString(
                    Stream.decodeText(result.Body!),
                  );
                  return yield* HttpServerResponse.json({
                    body,
                    versionId: result.VersionId,
                  });
                }),
              ),
              Effect.catchTag(
                ["NoSuchKey", "NoSuchVersion", "MethodNotAllowed"],
                (error) =>
                  HttpServerResponse.json(
                    { tag: error._tag },
                    { status: error._tag === "MethodNotAllowed" ? 405 : 404 },
                  ),
              ),
            );
          case "PutObject":
            return yield* HttpServerResponse.json(
              yield* put({ Key, Body: yield* request.text }),
            );
          case "HeadObject":
            return yield* head({ Key, VersionId }).pipe(
              Effect.flatMap((result) =>
                HttpServerResponse.json({
                  versionId: result.VersionId,
                  length: result.ContentLength,
                }),
              ),
              Effect.catchTag("NotFound", (error) =>
                HttpServerResponse.json({ tag: error._tag }, { status: 404 }),
              ),
              Effect.catchTag("MethodNotAllowed", (error) =>
                HttpServerResponse.json(
                  {
                    tag: error._tag,
                    deleteMarker: error.DeleteMarker,
                    lastModified: error.LastModified,
                  },
                  { status: 405 },
                ),
              ),
            );
          case "GetObjectAttributes":
            return yield* attributes({
              Key,
              VersionId,
              ObjectAttributes: ["ETag", "ObjectSize"],
            }).pipe(
              Effect.flatMap((result) => HttpServerResponse.json(result)),
              Effect.catchTag(["NoSuchVersion", "MethodNotAllowed"], (error) =>
                HttpServerResponse.json(
                  { tag: error._tag },
                  { status: error._tag === "MethodNotAllowed" ? 405 : 404 },
                ),
              ),
            );
          case "CopyObject":
            return yield* copy({
              Key,
              CopySource: url.searchParams.get("source")!,
            }).pipe(
              Effect.flatMap((result) => HttpServerResponse.json(result)),
              Effect.catchTag("AccessDeniedException", (error) =>
                HttpServerResponse.json(
                  { tag: error._tag, message: error.message },
                  { status: 403 },
                ),
              ),
              Effect.catchTag(
                ["NoSuchVersion", "NoSuchKey", "InvalidRequest"],
                (error) =>
                  HttpServerResponse.json(
                    { tag: error._tag },
                    { status: error._tag === "InvalidRequest" ? 400 : 404 },
                  ),
              ),
            );
          case "DeleteObject":
            return yield* HttpServerResponse.json(
              yield* remove({ Key, VersionId }),
            );
          case "DeleteObjects": {
            const objects = yield* request.json.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Objects)),
            );
            return yield* HttpServerResponse.json(
              yield* removeMany({ Delete: { Objects: [...objects] } }),
            );
          }
          case "ListObjectsV2":
            return yield* HttpServerResponse.json(
              yield* list({
                Prefix: url.searchParams.get("prefix") ?? undefined,
                MaxKeys: 1,
                ContinuationToken: url.searchParams.get("token") ?? undefined,
              }),
            );
          case "ListObjectVersions":
            return yield* HttpServerResponse.json(
              yield* versions({
                Prefix: url.searchParams.get("prefix") ?? undefined,
                MaxKeys: 1,
                KeyMarker: url.searchParams.get("keyMarker") ?? undefined,
                VersionIdMarker:
                  url.searchParams.get("versionMarker") ?? undefined,
              }),
            );
          case "GetObjectTagging":
            return yield* getTags({ Key, VersionId }).pipe(
              Effect.flatMap((result) => HttpServerResponse.json(result)),
              Effect.catchTag(
                [
                  "NoSuchVersion",
                  "NoSuchKey",
                  "MethodNotAllowed",
                  "AccessDeniedException",
                ],
                (error) =>
                  HttpServerResponse.json(
                    { tag: error._tag },
                    {
                      status:
                        error._tag === "MethodNotAllowed"
                          ? 405
                          : error._tag === "AccessDeniedException"
                            ? 403
                            : 404,
                    },
                  ),
              ),
            );
          case "PutObjectTagging": {
            const tags = yield* request.json.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Tags)),
            );
            return yield* putTags({
              Key,
              VersionId,
              Tagging: { TagSet: [...tags] },
            }).pipe(
              Effect.flatMap((result) => HttpServerResponse.json(result)),
              Effect.catchTag(
                [
                  "NoSuchVersion",
                  "NoSuchKey",
                  "MethodNotAllowed",
                  "AccessDeniedException",
                ],
                (error) =>
                  HttpServerResponse.json(
                    { tag: error._tag },
                    {
                      status:
                        error._tag === "MethodNotAllowed"
                          ? 405
                          : error._tag === "AccessDeniedException"
                            ? 403
                            : 404,
                    },
                  ),
              ),
            );
          }
          case "DeleteObjectTagging":
            return yield* deleteTags({ Key, VersionId }).pipe(
              Effect.flatMap((result) => HttpServerResponse.json(result)),
              Effect.catchTag(
                [
                  "NoSuchVersion",
                  "NoSuchKey",
                  "MethodNotAllowed",
                  "AccessDeniedException",
                ],
                (error) =>
                  HttpServerResponse.json(
                    { tag: error._tag },
                    {
                      status:
                        error._tag === "MethodNotAllowed"
                          ? 405
                          : error._tag === "AccessDeniedException"
                            ? 403
                            : 404,
                    },
                  ),
              ),
            );
          case "PresignPutObject":
            return yield* HttpServerResponse.json({
              url: yield* presignPut({ key: Key, contentType: "text/plain" }),
            });
          default:
            return HttpServerResponse.text("Not found", { status: 404 });
        }
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        S3.GetObjectHttp,
        S3.PutObjectHttp,
        S3.HeadObjectHttp,
        S3.GetObjectAttributesHttp,
        S3.CopyObjectHttp,
        S3.DeleteObjectHttp,
        S3.DeleteObjectsHttp,
        S3.ListObjectsV2Http,
        S3.ListObjectVersionsHttp,
        S3.GetObjectTaggingHttp,
        S3.PutObjectTaggingHttp,
        S3.DeleteObjectTaggingHttp,
        S3.PresignPutObjectHttp,
      ),
    ),
  ),
);
