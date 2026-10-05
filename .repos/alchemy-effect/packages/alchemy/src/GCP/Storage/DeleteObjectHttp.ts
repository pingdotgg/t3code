import * as storage from "@distilled.cloud/gcp/storage_v1";
import * as Layer from "effect/Layer";
import { DeleteObject } from "./DeleteObject.ts";
import { makeObjectHttpBinding } from "./ObjectHttp.ts";

/**
 * HTTP implementation of {@link DeleteObject}.
 *
 * @layer
 * @provides GCP.Storage.DeleteObject
 */
export const DeleteObjectHttp = Layer.effect(
  DeleteObject,
  makeObjectHttpBinding({
    tag: "GCP.Storage.DeleteObject",
    role: "roles/storage.objectUser",
    operation: storage.deleteObjects,
  }),
);
