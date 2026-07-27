import type * as organizations from "@distilled.cloud/aws/organizations";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `organizations:ListHandshakesForOrganization`.
 *
 * Lists the handshakes sent by the organization's management account — outstanding and recently concluded invitations.
 * Account-level operation — Organizations is a management-account-scoped
 * global service, so the binding takes no resource argument. Provide the
 * implementation with `Effect.provide(AWS.Organizations.ListHandshakesForOrganizationHttp)`.
 * @binding
 * @section Handshakes & Invitations
 * @example List the Organization's Handshakes
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listHandshakesForOrganization = yield* AWS.Organizations.ListHandshakesForOrganization();
 *
 * // runtime
 * const { Handshakes } = yield* listHandshakesForOrganization();
 * ```
 */
export interface ListHandshakesForOrganization extends Binding.Service<
  ListHandshakesForOrganization,
  "AWS.Organizations.ListHandshakesForOrganization",
  () => Effect.Effect<
    (
      request?: organizations.ListHandshakesForOrganizationRequest,
    ) => Effect.Effect<
      organizations.ListHandshakesForOrganizationResponse,
      organizations.ListHandshakesForOrganizationError
    >
  >
> {}
export const ListHandshakesForOrganization =
  Binding.Service<ListHandshakesForOrganization>(
    "AWS.Organizations.ListHandshakesForOrganization",
  );
