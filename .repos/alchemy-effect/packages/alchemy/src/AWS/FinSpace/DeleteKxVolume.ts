import type * as SVC from "@distilled.cloud/aws/finspace";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { KxEnvironment } from "./KxEnvironment.ts";

/**
 * Runtime binding for `finspace:DeleteKxVolume` — deletes a volume from the bound environment. The volume must not be attached to any cluster.
 * Provide the implementation with
 * `Effect.provide(AWS.FinSpace.DeleteKxVolumeHttp)`.
 * @binding
 * @section Managing Volumes
 * @example Delete a Volume
 * ```typescript
 * const deleteVolume = yield* AWS.FinSpace.DeleteKxVolume(kdb);
 *
 * yield* deleteVolume({
 *   volumeName: "tp-logs",
 *   clientToken: crypto.randomUUID(),
 * });
 * ```
 */
export interface DeleteKxVolume extends Binding.Service<
  DeleteKxVolume,
  "AWS.FinSpace.DeleteKxVolume",
  <K extends KxEnvironment>(
    environment: K,
  ) => Effect.Effect<
    (
      request: Omit<SVC.DeleteKxVolumeRequest, "environmentId">,
    ) => Effect.Effect<SVC.DeleteKxVolumeResponse, SVC.DeleteKxVolumeError>
  >
> {}
export const DeleteKxVolume = Binding.Service<DeleteKxVolume>(
  "AWS.FinSpace.DeleteKxVolume",
);
