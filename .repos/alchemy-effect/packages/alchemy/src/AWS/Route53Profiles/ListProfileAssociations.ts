import type * as profiles from "@distilled.cloud/aws/route53profiles";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Profile } from "./Profile.ts";

/**
 * Request for {@link ListProfileAssociations} — the bound profile's id is
 * injected as `ProfileId`, so only the optional VPC filter and pagination
 * knobs remain.
 */
export interface ListProfileAssociationsRequest extends Omit<
  profiles.ListProfileAssociationsRequest,
  "ProfileId"
> {}

/**
 * Runtime binding for `route53profiles:ListProfileAssociations` — enumerate
 * the VPC associations of the bound {@link Profile} (each item carries the
 * association id, VPC `ResourceId`, and its `Status`), so an ops function
 * can audit which VPCs a shared DNS configuration currently applies to or
 * wait for an association to reach `COMPLETE`. The profile's id is injected
 * automatically.
 *
 * Provide `AWS.Route53Profiles.ListProfileAssociationsHttp` on the hosting
 * Lambda Function to satisfy the requirement.
 * @binding
 * @section Listing VPC Associations
 * @example Enumerate the VPCs a Profile applies to
 * ```typescript
 * // init — grants route53profiles:ListProfileAssociations
 * const listProfileAssociations =
 *   yield* AWS.Route53Profiles.ListProfileAssociations(profile);
 *
 * // runtime
 * const { ProfileAssociations = [] } = yield* listProfileAssociations();
 * for (const association of ProfileAssociations) {
 *   yield* Effect.log(`${association.ResourceId}: ${association.Status}`);
 * }
 * ```
 */
export interface ListProfileAssociations extends Binding.Service<
  ListProfileAssociations,
  "AWS.Route53Profiles.ListProfileAssociations",
  (
    profile: Profile,
  ) => Effect.Effect<
    (
      request?: ListProfileAssociationsRequest,
    ) => Effect.Effect<
      profiles.ListProfileAssociationsResponse,
      profiles.ListProfileAssociationsError
    >
  >
> {}

export const ListProfileAssociations = Binding.Service<ListProfileAssociations>(
  "AWS.Route53Profiles.ListProfileAssociations",
);
