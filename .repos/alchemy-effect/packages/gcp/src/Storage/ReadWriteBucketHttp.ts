import * as Layer from "effect/Layer";
import { makeStorageBucketBinding } from "./BucketHttp.ts";
import { ReadWriteBucket } from "./ReadWriteBucket.ts";

/**
 * HTTP implementation of {@link ReadWriteBucket} over the Cloud Storage JSON API.
 *
 * @layer
 * @provides GCP.Storage.ReadWriteBucket
 * @category Storage
 */
export const ReadWriteBucketHttp = Layer.effect(
  ReadWriteBucket,
  makeStorageBucketBinding({
    tag: "GCP.Storage.ReadWriteBucket",
    role: "roles/storage.objectUser",
    makeClient: (helpers, name) => ({
      ...helpers.makeRead(name),
      ...helpers.makeWrite(name),
    }),
  }),
);
