import * as Layer from "effect/Layer";
import { makeStorageBucketBinding } from "./BucketHttp.ts";
import { ReadBucket } from "./ReadBucket.ts";

/**
 * HTTP implementation of {@link ReadBucket} over the Cloud Storage JSON API.
 *
 * @layer
 * @provides GCP.Storage.ReadBucket
 * @category Storage
 */
export const ReadBucketHttp = Layer.effect(
  ReadBucket,
  makeStorageBucketBinding({
    tag: "GCP.Storage.ReadBucket",
    role: "roles/storage.objectViewer",
    makeClient: (helpers, name) => helpers.makeRead(name),
  }),
);
