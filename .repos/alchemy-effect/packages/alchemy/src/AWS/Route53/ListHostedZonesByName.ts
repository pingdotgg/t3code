import type * as route53 from "@distilled.cloud/aws/route-53";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `ListHostedZonesByName` operation (IAM action
 * `route53:ListHostedZonesByName`; list actions do not support
 * resource-level permissions, so it is granted on `*`).
 *
 * Looks hosted zones up by DNS name in lexicographic order — the direct way
 * to resolve "which zone owns `example.com`?" at runtime. Provide the
 * implementation with
 * `Effect.provide(AWS.Route53.ListHostedZonesByNameHttp)`.
 * @binding
 * @section Discovering Zones
 * @example Find a zone by name
 * ```typescript
 * const listByName = yield* AWS.Route53.ListHostedZonesByName();
 *
 * const { HostedZones } = yield* listByName({
 *   DNSName: "example.com.",
 *   MaxItems: 1,
 * });
 * ```
 */
export interface ListHostedZonesByName extends Binding.Service<
  ListHostedZonesByName,
  "AWS.Route53.ListHostedZonesByName",
  () => Effect.Effect<
    (
      request?: route53.ListHostedZonesByNameRequest,
    ) => Effect.Effect<
      route53.ListHostedZonesByNameResponse,
      route53.ListHostedZonesByNameError
    >
  >
> {}
export const ListHostedZonesByName = Binding.Service<ListHostedZonesByName>(
  "AWS.Route53.ListHostedZonesByName",
);
