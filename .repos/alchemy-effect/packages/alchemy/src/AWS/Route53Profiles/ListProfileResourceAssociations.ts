import type * as profiles from "@distilled.cloud/aws/route53profiles";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Profile } from "./Profile.ts";

/**
 * Request for {@link ListProfileResourceAssociations} — the bound profile's
 * id is injected as `ProfileId`, so only the optional `ResourceType` filter
 * and pagination knobs remain.
 */
export interface ListProfileResourceAssociationsRequest extends Omit<
  profiles.ListProfileResourceAssociationsRequest,
  "ProfileId"
> {}

/**
 * Runtime binding for `route53profiles:ListProfileResourceAssociations` —
 * enumerate the DNS resources attached to the bound {@link Profile}
 * (private hosted zones, Resolver rules, DNS Firewall rule groups; each item
 * carries the resource's ARN, type, properties, and `Status`), so an ops
 * function can audit what DNS configuration a shared profile bundles. The
 * profile's id is injected automatically.
 *
 * Provide `AWS.Route53Profiles.ListProfileResourceAssociationsHttp` on the
 * hosting Lambda Function to satisfy the requirement.
 * @binding
 * @section Listing Attached DNS Resources
 * @example Enumerate the DNS resources attached to a Profile
 * ```typescript
 * // init — grants route53profiles:ListProfileResourceAssociations
 * const listProfileResourceAssociations =
 *   yield* AWS.Route53Profiles.ListProfileResourceAssociations(profile);
 *
 * // runtime
 * const { ProfileResourceAssociations = [] } =
 *   yield* listProfileResourceAssociations();
 * for (const association of ProfileResourceAssociations) {
 *   yield* Effect.log(`${association.ResourceType}: ${association.ResourceArn}`);
 * }
 * ```
 */
export interface ListProfileResourceAssociations extends Binding.Service<
  ListProfileResourceAssociations,
  "AWS.Route53Profiles.ListProfileResourceAssociations",
  (
    profile: Profile,
  ) => Effect.Effect<
    (
      request?: ListProfileResourceAssociationsRequest,
    ) => Effect.Effect<
      profiles.ListProfileResourceAssociationsResponse,
      profiles.ListProfileResourceAssociationsError
    >
  >
> {}

export const ListProfileResourceAssociations =
  Binding.Service<ListProfileResourceAssociations>(
    "AWS.Route53Profiles.ListProfileResourceAssociations",
  );
