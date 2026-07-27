import type * as route53 from "@distilled.cloud/aws/route-53";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `ListHostedZones` operation (IAM action
 * `route53:ListHostedZones`; list actions do not support resource-level
 * permissions, so it is granted on `*`).
 *
 * Pages through the account's hosted zones — zone discovery for multi-tenant
 * DNS automation that resolves a zone id before editing records. Provide the
 * implementation with `Effect.provide(AWS.Route53.ListHostedZonesHttp)`.
 * @binding
 * @section Discovering Zones
 * @example List the account's zones
 * ```typescript
 * const listHostedZones = yield* AWS.Route53.ListHostedZones();
 *
 * const { HostedZones } = yield* listHostedZones({ MaxItems: 100 });
 * ```
 */
export interface ListHostedZones extends Binding.Service<
  ListHostedZones,
  "AWS.Route53.ListHostedZones",
  () => Effect.Effect<
    (
      request?: route53.ListHostedZonesRequest,
    ) => Effect.Effect<
      route53.ListHostedZonesResponse,
      route53.ListHostedZonesError
    >
  >
> {}
export const ListHostedZones = Binding.Service<ListHostedZones>(
  "AWS.Route53.ListHostedZones",
);
