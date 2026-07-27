import type * as location from "@distilled.cloud/aws/location";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { GeofenceCollection } from "./GeofenceCollection.ts";

/**
 * `ListGeofences` request with `CollectionName` injected from the bound
 * resource.
 */
export interface ListGeofencesRequest extends Omit<
  location.ListGeofencesRequest,
  "CollectionName"
> {}

/**
 * Lists the geofences stored in the collection.
 *
 * Runtime binding for the `ListGeofences` operation (IAM action
 * `geo:ListGeofences`), scoped to one {@link GeofenceCollection}. Provide the implementation with
 * `Effect.provide(AWS.Location.ListGeofencesHttp)`.
 *
 * @binding
 * @section Reading Geofences
 * @example List Geofences
 * ```typescript
 * const listGeofences = yield* Location.ListGeofences(collection);
 *
 * const page = yield* listGeofences();
 * // page.Entries → [{ GeofenceId, Geometry, Status }, …]
 * ```
 */
export interface ListGeofences extends Binding.Service<
  ListGeofences,
  "AWS.Location.ListGeofences",
  (
    collection: GeofenceCollection,
  ) => Effect.Effect<
    (
      request?: ListGeofencesRequest,
    ) => Effect.Effect<
      location.ListGeofencesResponse,
      location.ListGeofencesError
    >
  >
> {}
export const ListGeofences = Binding.Service<ListGeofences>(
  "AWS.Location.ListGeofences",
);
