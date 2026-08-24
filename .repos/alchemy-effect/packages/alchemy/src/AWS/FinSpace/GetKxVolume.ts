import type * as SVC from "@distilled.cloud/aws/finspace";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { KxEnvironment } from "./KxEnvironment.ts";

/**
 * Runtime binding for `finspace:GetKxVolume` — reads a volume's status, NAS configuration, and the clusters attached to it in the bound environment.
 * Provide the implementation with
 * `Effect.provide(AWS.FinSpace.GetKxVolumeHttp)`.
 * @binding
 * @section Managing Volumes
 * @example Poll a Volume to Active
 * ```typescript
 * const getVolume = yield* AWS.FinSpace.GetKxVolume(kdb);
 *
 * const volume = yield* getVolume({ volumeName: "tp-logs" });
 * if (volume.status === "ACTIVE") {
 *   yield* Effect.log(`attached: ${volume.attachedClusters?.length ?? 0}`);
 * }
 * ```
 */
export interface GetKxVolume extends Binding.Service<
  GetKxVolume,
  "AWS.FinSpace.GetKxVolume",
  <K extends KxEnvironment>(
    environment: K,
  ) => Effect.Effect<
    (
      request: Omit<SVC.GetKxVolumeRequest, "environmentId">,
    ) => Effect.Effect<SVC.GetKxVolumeResponse, SVC.GetKxVolumeError>
  >
> {}
export const GetKxVolume = Binding.Service<GetKxVolume>(
  "AWS.FinSpace.GetKxVolume",
);
