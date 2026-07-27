import type * as route53 from "@distilled.cloud/aws/route-53";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { HostedZone } from "./HostedZone.ts";

/**
 * `ChangeResourceRecordSets` request with `HostedZoneId` injected from the
 * bound {@link HostedZone}.
 */
export interface ChangeResourceRecordSetsRequest extends Omit<
  route53.ChangeResourceRecordSetsRequest,
  "HostedZoneId"
> {}

/**
 * Runtime binding for the `ChangeResourceRecordSets` operation (IAM action
 * `route53:ChangeResourceRecordSets` on the hosted zone ARN).
 *
 * Creates, upserts, and deletes DNS record sets in the bound
 * {@link HostedZone} at runtime — the core dynamic-DNS primitive (ACME
 * `dns-01` challenges, service discovery, failover flips). Pair with
 * {@link GetChange} to wait until the change is `INSYNC`. Provide the
 * implementation with
 * `Effect.provide(AWS.Route53.ChangeResourceRecordSetsHttp)`.
 * @binding
 * @section Managing Records at Runtime
 * @example Upsert a TXT record
 * ```typescript
 * const changeRecordSets = yield* AWS.Route53.ChangeResourceRecordSets(zone);
 *
 * const { ChangeInfo } = yield* changeRecordSets({
 *   ChangeBatch: {
 *     Changes: [{
 *       Action: "UPSERT",
 *       ResourceRecordSet: {
 *         Name: "_acme-challenge.example.com.",
 *         Type: "TXT",
 *         TTL: 60,
 *         ResourceRecords: [{ Value: '"token"' }],
 *       },
 *     }],
 *   },
 * });
 * ```
 */
export interface ChangeResourceRecordSets extends Binding.Service<
  ChangeResourceRecordSets,
  "AWS.Route53.ChangeResourceRecordSets",
  (
    zone: HostedZone,
  ) => Effect.Effect<
    (
      request: ChangeResourceRecordSetsRequest,
    ) => Effect.Effect<
      route53.ChangeResourceRecordSetsResponse,
      route53.ChangeResourceRecordSetsError
    >
  >
> {}
export const ChangeResourceRecordSets =
  Binding.Service<ChangeResourceRecordSets>(
    "AWS.Route53.ChangeResourceRecordSets",
  );
