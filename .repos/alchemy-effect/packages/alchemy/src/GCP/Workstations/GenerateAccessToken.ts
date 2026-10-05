import type * as workstations from "@distilled.cloud/gcp/workstations_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { WorkstationClustersWorkstationConfigsWorkstation } from "./WorkstationClustersWorkstationConfigsWorkstation.ts";

export interface GenerateAccessTokenRequest extends Omit<
  workstations.GenerateAccessTokenProjectsLocationsWorkstationClustersWorkstationConfigsWorkstationsRequest,
  "workstation"
> {}

/**
 * Runtime binding for Cloud Workstations `workstations.generateAccessToken`.
 *
 * Bind this operation to a
 * {@link WorkstationClustersWorkstationConfigsWorkstation} in a
 * Function/Action init phase. Provide {@link GenerateAccessTokenHttp}.
 * Grants `roles/workstations.user` on the workstation only.
 *
 * ### Authenticating to a Workstation
 * **Example:** Mint a short-lived access token
 * ```typescript
 * const generate = yield* GCP.Workstations.GenerateAccessToken(dev);
 * const { accessToken, expireTime } = yield* generate({
 *   body: { ttl: "3600s" },
 * });
 * ```
 *
 * @binding
 * @category Workstations
 */
export interface GenerateAccessToken extends Binding.Service<
  GenerateAccessToken,
  "GCP.Workstations.GenerateAccessToken",
  (
    workstation: WorkstationClustersWorkstationConfigsWorkstation,
  ) => Effect.Effect<
    (
      request?: GenerateAccessTokenRequest,
    ) => Effect.Effect<
      workstations.GenerateAccessTokenResponse,
      workstations.GenerateAccessTokenProjectsLocationsWorkstationClustersWorkstationConfigsWorkstationsError,
      RuntimeContext
    >
  >
> {}

export const GenerateAccessToken = Binding.Service<GenerateAccessToken>(
  "GCP.Workstations.GenerateAccessToken",
);
