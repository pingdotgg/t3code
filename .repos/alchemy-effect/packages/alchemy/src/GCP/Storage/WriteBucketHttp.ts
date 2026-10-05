import * as Layer from "effect/Layer";
import { makeStorageBucketBinding } from "./BucketHttp.ts";
import { WriteBucket } from "./WriteBucket.ts";

/**
 * HTTP implementation of {@link WriteBucket} over the Cloud Storage JSON API.
 *
 * @layer
 * @provides GCP.Storage.WriteBucket
 * @category Storage
 */
export const WriteBucketHttp = Layer.effect(
  WriteBucket,
  makeStorageBucketBinding({
    tag: "GCP.Storage.WriteBucket",
    role: "roles/storage.objectUser",
    makeClient: (helpers, name) => helpers.makeWrite(name),
  }),
);
