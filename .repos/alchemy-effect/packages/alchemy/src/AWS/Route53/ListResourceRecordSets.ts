import type * as route53 from "@distilled.cloud/aws/route-53";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { HostedZone } from "./HostedZone.ts";

/**
 * `ListResourceRecordSets` request with `HostedZoneId` injected from the
 * bound {@link HostedZone}.
 */
export interface ListResourceRecordSetsRequest extends Omit<
  route53.ListResourceRecordSetsRequest,
  "HostedZoneId"
> {}

/**
 * Runtime binding for the `ListResourceRecordSets` operation (IAM action
 * `route53:ListResourceRecordSets` on the hosted zone ARN).
 *
 * Pages through the bound {@link HostedZone}'s record sets — read the
 * current DNS state before computing a change batch, or audit what a
 * dynamic-DNS workflow has written. Provide the implementation with
 * `Effect.provide(AWS.Route53.ListResourceRecordSetsHttp)`.
 * @binding
 * @section Managing Records at Runtime
 * @example List records from a name
 * ```typescript
 * const listRecordSets = yield* AWS.Route53.ListResourceRecordSets(zone);
 *
 * const { ResourceRecordSets } = yield* listRecordSets({
 *   StartRecordName: "www.example.com.",
 *   MaxItems: 10,
 * });
 * ```
 */
export interface ListResourceRecordSets extends Binding.Service<
  ListResourceRecordSets,
  "AWS.Route53.ListResourceRecordSets",
  (
    zone: HostedZone,
  ) => Effect.Effect<
    (
      request?: ListResourceRecordSetsRequest,
    ) => Effect.Effect<
      route53.ListResourceRecordSetsResponse,
      route53.ListResourceRecordSetsError
    >
  >
> {}
export const ListResourceRecordSets = Binding.Service<ListResourceRecordSets>(
  "AWS.Route53.ListResourceRecordSets",
);
