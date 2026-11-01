import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Bucket } from "./Bucket.ts";
import { GetObject, type GetObjectRequest } from "./GetObject.ts";
import { grantOnBucket } from "./ObjectHttp.ts";
import { makeObjectMedia } from "./ObjectMedia.ts";

/**
 * HTTP implementation of {@link GetObject}.
 *
 * @layer
 * @provides GCP.Storage.GetObject
 */
export const GetObjectHttp = Layer.effect(
  GetObject,
  Effect.gen(function* () {
    const media = yield* makeObjectMedia;
    return Effect.fn(function* (bucket: Bucket) {
      yield* grantOnBucket(
        "GCP.Storage.GetObject",
        bucket,
        "roles/storage.objectViewer",
      );
      const bucketName = yield* bucket.bucketName;
      return Effect.fn(`GCP.Storage.GetObject(${bucket.LogicalId})`)(function* (
        request: GetObjectRequest,
      ) {
        return yield* media.download({
          bucket: yield* bucketName,
          object: request.object,
          generation: request.generation,
        });
      });
    });
  }),
);
