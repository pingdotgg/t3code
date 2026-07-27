import type * as route53 from "@distilled.cloud/aws/route-53";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { HostedZone } from "./HostedZone.ts";

/**
 * Runtime binding for the `GetHostedZone` operation (IAM action
 * `route53:GetHostedZone` on the hosted zone ARN).
 *
 * Reads the bound {@link HostedZone}'s detail — the authoritative name
 * servers (delegation set), record count, and associated VPCs. Useful for
 * compute that hands out NS records or verifies delegation at runtime.
 * Provide the implementation with
 * `Effect.provide(AWS.Route53.GetHostedZoneHttp)`.
 * @binding
 * @section Inspecting Zones
 * @example Read the zone's name servers
 * ```typescript
 * const getHostedZone = yield* AWS.Route53.GetHostedZone(zone);
 *
 * const { DelegationSet } = yield* getHostedZone();
 * yield* Effect.log(DelegationSet?.NameServers);
 * ```
 */
export interface GetHostedZone extends Binding.Service<
  GetHostedZone,
  "AWS.Route53.GetHostedZone",
  (
    zone: HostedZone,
  ) => Effect.Effect<
    () => Effect.Effect<
      route53.GetHostedZoneResponse,
      route53.GetHostedZoneError
    >
  >
> {}
export const GetHostedZone = Binding.Service<GetHostedZone>(
  "AWS.Route53.GetHostedZone",
);
