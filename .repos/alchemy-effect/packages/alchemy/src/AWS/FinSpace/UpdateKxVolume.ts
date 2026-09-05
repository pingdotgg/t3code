import type * as SVC from "@distilled.cloud/aws/finspace";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { KxEnvironment } from "./KxEnvironment.ts";

/**
 * Runtime binding for `finspace:UpdateKxVolume` — changes a volume's description or NAS_1 size/throughput in the bound environment.
 * Provide the implementation with
 * `Effect.provide(AWS.FinSpace.UpdateKxVolumeHttp)`.
 * @binding
 * @section Managing Volumes
 * @example Grow a Volume
 * ```typescript
 * const updateVolume = yield* AWS.FinSpace.UpdateKxVolume(kdb);
 *
 * yield* updateVolume({
 *   volumeName: "tp-logs",
 *   nas1Configuration: { type: "SSD_250", size: 2400 },
 *   clientToken: crypto.randomUUID(),
 * });
 * ```
 */
export interface UpdateKxVolume extends Binding.Service<
  UpdateKxVolume,
  "AWS.FinSpace.UpdateKxVolume",
  <K extends KxEnvironment>(
    environment: K,
  ) => Effect.Effect<
    (
      request: Omit<SVC.UpdateKxVolumeRequest, "environmentId">,
    ) => Effect.Effect<SVC.UpdateKxVolumeResponse, SVC.UpdateKxVolumeError>
  >
> {}
export const UpdateKxVolume = Binding.Service<UpdateKxVolume>(
  "AWS.FinSpace.UpdateKxVolume",
);
