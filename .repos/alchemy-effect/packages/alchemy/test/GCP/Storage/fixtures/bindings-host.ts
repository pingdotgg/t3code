import * as GCP from "@/GCP";
import { ObjectRequestFailed } from "@/GCP/Storage/ObjectMedia.ts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";

/** Object key and content seeded into the read-side buckets. */
export const SEED_KEY = "seed/hello.txt";
export const SEED_TEXT = "hello from the seed object";

/**
 * One bucket per binding, so each bucket's IAM policy shows exactly the
 * role that binding grants.
 */
const bucket = (id: string) =>
  GCP.Storage.Bucket(id, { location: "US-CENTRAL1", forceDestroy: true });

const seeded = (id: string) =>
  Effect.gen(function* () {
    const target = yield* bucket(id);
    yield* GCP.Storage.Object(`${id}Seed`, {
      bucketName: target.bucketName,
      key: SEED_KEY,
      content: SEED_TEXT,
      contentType: "text/plain",
    });
    return target;
  });

export const ReadAssets = seeded("ReadAssets");
export const WriteAssets = bucket("WriteAssets");
export const ReadWriteAssets = bucket("ReadWriteAssets");
export const GetAssets = seeded("GetAssets");
export const PutAssets = bucket("PutAssets");
export const DeleteAssets = seeded("DeleteAssets");
export const SignAssets = seeded("SignAssets");

/**
 * A 403 from the media endpoints: the fresh bucket grant has not
 * propagated yet (`callProbe` retries on this tag).
 */
class Forbidden extends Data.TaggedError("Forbidden")<{ message: string }> {}

const forbiddenAsTag = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((error) =>
      error instanceof ObjectRequestFailed && error.status === 403
        ? new Forbidden({ message: error.message })
        : error,
    ),
  );

const text = (body: Uint8Array) => new TextDecoder().decode(body);

/**
 * Effect-native Cloud Run service exercising every Cloud Storage binding
 * as its own runtime service account. Deployed from
 * {@link ../Bindings.test.ts}.
 */
export default class StorageBindingsHost extends GCP.Function<StorageBindingsHost>()(
  "StorageBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const readBucket = yield* GCP.Storage.ReadBucket(ReadAssets);
    const writeBucket = yield* GCP.Storage.WriteBucket(WriteAssets);
    const readWriteBucket = yield* GCP.Storage.ReadWriteBucket(ReadWriteAssets);
    const getObject = yield* GCP.Storage.GetObject(GetAssets);
    const putObject = yield* GCP.Storage.PutObject(PutAssets);
    const deleteObject = yield* GCP.Storage.DeleteObject(DeleteAssets);
    const signGetObjectUrl = yield* GCP.Storage.SignGetObjectUrl(SignAssets);

    return {
      fetch: serveProbes({
        readBucket: forbiddenAsTag(
          Effect.gen(function* () {
            const head = yield* readBucket.head(SEED_KEY);
            const object = yield* readBucket.get(SEED_KEY);
            const listed = yield* readBucket.list({ prefix: "seed/" });
            const missingHead = yield* readBucket.head("missing.txt");
            const missingGet = yield* readBucket.get("missing.txt");
            return {
              headName: head?.name,
              headSize: head?.size,
              text: object && text(object.body),
              contentType: object?.contentType,
              listed: listed.objects.map((item) => item.name),
              missingHead: missingHead === undefined,
              missingGet: missingGet === undefined,
            };
          }),
        ),
        writeBucketPut: forbiddenAsTag(
          writeBucket
            .put("written.txt", "hello from WriteBucket", {
              contentType: "text/plain",
              metadata: { source: "write-bucket" },
            })
            .pipe(Effect.map((object) => ({ name: object.name }))),
        ),
        writeBucketDelete: Effect.gen(function* () {
          yield* writeBucket.delete("written.txt");
          // Deleting a missing object succeeds.
          yield* writeBucket.delete("missing.txt");
          return { deleted: "written.txt" };
        }),
        readWriteBucket: forbiddenAsTag(
          Effect.gen(function* () {
            const put = yield* readWriteBucket.put(
              "round-trip.txt",
              "hello from ReadWriteBucket",
            );
            const object = yield* readWriteBucket.get("round-trip.txt");
            const listed = yield* readWriteBucket.list();
            return {
              putName: put.name,
              text: object && text(object.body),
              listed: listed.objects.map((item) => item.name),
            };
          }),
        ),
        readWriteBucketDelete: Effect.gen(function* () {
          yield* readWriteBucket.delete("round-trip.txt");
          const after = yield* readWriteBucket.head("round-trip.txt");
          return { gone: after === undefined };
        }),
        getObject: forbiddenAsTag(
          Effect.gen(function* () {
            const object = yield* getObject({ object: SEED_KEY });
            return { text: text(object.body), contentType: object.contentType };
          }),
        ),
        getObjectMissing: forbiddenAsTag(getObject({ object: "missing.txt" })),
        putObject: forbiddenAsTag(
          putObject({
            name: "put.bin",
            body: new TextEncoder().encode("hello from PutObject"),
            contentType: "application/octet-stream",
            metadata: { source: "put-object" },
          }).pipe(
            Effect.map((object) => ({
              name: object.name,
              metadata: object.metadata,
            })),
          ),
        ),
        deleteObject: deleteObject({ object: SEED_KEY }).pipe(
          Effect.as({ deleted: SEED_KEY }),
        ),
        deleteObjectMissing: deleteObject({ object: "missing.txt" }),
        signGetObjectUrl: signGetObjectUrl({
          object: SEED_KEY,
          expiresIn: 600,
          contentType: "text/plain",
        }).pipe(Effect.map((url) => ({ url }))),
      }),
    };
  }).pipe(
    Effect.provide(GCP.Storage.ReadBucketHttp),
    Effect.provide(GCP.Storage.WriteBucketHttp),
    Effect.provide(GCP.Storage.ReadWriteBucketHttp),
    Effect.provide(GCP.Storage.GetObjectHttp),
    Effect.provide(GCP.Storage.PutObjectHttp),
    Effect.provide(GCP.Storage.DeleteObjectHttp),
    Effect.provide(GCP.Storage.SignGetObjectUrlHttp),
  ),
) {}
