import type * as SVC from "@distilled.cloud/aws/finspace";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { KxEnvironment } from "./KxEnvironment.ts";

/**
 * Runtime binding for `finspace:ListKxVolumes` — lists the volumes of the bound environment, optionally filtered by volume type.
 * Provide the implementation with
 * `Effect.provide(AWS.FinSpace.ListKxVolumesHttp)`.
 * @binding
 * @section Managing Volumes
 * @example List NAS_1 Volumes
 * ```typescript
 * const listVolumes = yield* AWS.FinSpace.ListKxVolumes(kdb);
 *
 * const { kxVolumeSummaries } = yield* listVolumes({ volumeType: "NAS_1" });
 * ```
 */
export interface ListKxVolumes extends Binding.Service<
  ListKxVolumes,
  "AWS.FinSpace.ListKxVolumes",
  <K extends KxEnvironment>(
    environment: K,
  ) => Effect.Effect<
    (
      request?: Omit<SVC.ListKxVolumesRequest, "environmentId">,
    ) => Effect.Effect<SVC.ListKxVolumesResponse, SVC.ListKxVolumesError>
  >
> {}
export const ListKxVolumes = Binding.Service<ListKxVolumes>(
  "AWS.FinSpace.ListKxVolumes",
);
