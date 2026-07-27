import type * as SVC from "@distilled.cloud/aws/finspace";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { KxEnvironment } from "./KxEnvironment.ts";

/**
 * Runtime binding for `finspace:CreateKxVolume` — provisions a NAS_1 storage volume in the bound environment that clusters mount for tickerplant logs and shared savedown space.
 * Provide the implementation with
 * `Effect.provide(AWS.FinSpace.CreateKxVolumeHttp)`.
 * @binding
 * @section Managing Volumes
 * @example Provision a Tickerplant Log Volume
 * ```typescript
 * const createVolume = yield* AWS.FinSpace.CreateKxVolume(kdb);
 *
 * const volume = yield* createVolume({
 *   volumeName: "tp-logs",
 *   volumeType: "NAS_1",
 *   nas1Configuration: { type: "SSD_250", size: 1200 },
 *   azMode: "SINGLE",
 *   availabilityZoneIds: ["use1-az2"],
 *   clientToken: crypto.randomUUID(),
 * });
 * ```
 */
export interface CreateKxVolume extends Binding.Service<
  CreateKxVolume,
  "AWS.FinSpace.CreateKxVolume",
  <K extends KxEnvironment>(
    environment: K,
  ) => Effect.Effect<
    (
      request: Omit<SVC.CreateKxVolumeRequest, "environmentId">,
    ) => Effect.Effect<SVC.CreateKxVolumeResponse, SVC.CreateKxVolumeError>
  >
> {}
export const CreateKxVolume = Binding.Service<CreateKxVolume>(
  "AWS.FinSpace.CreateKxVolume",
);
