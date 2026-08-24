import type * as licensemanager from "@distilled.cloud/aws/license-manager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link DeleteGrant}.
 */
export interface DeleteGrantRequest extends licensemanager.DeleteGrantRequest {}

/**
 * Runtime binding for `license-manager:DeleteGrant` — retire a grant (e.g.
 * when a customer's subscription lapses). The grant's current version must
 * be passed as `Version`.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.LicenseManager.DeleteGrantHttp)`.
 * @binding
 * @section Managing Grants
 * @example Delete a Grant
 * ```typescript
 * // init
 * const deleteGrant = yield* AWS.LicenseManager.DeleteGrant();
 *
 * // runtime
 * const { Grant } = yield* getGrant({ GrantArn: grantArn });
 * yield* deleteGrant({ GrantArn: grantArn, Version: Grant!.Version! });
 * ```
 */
export interface DeleteGrant extends Binding.Service<
  DeleteGrant,
  "AWS.LicenseManager.DeleteGrant",
  () => Effect.Effect<
    (
      request: DeleteGrantRequest,
    ) => Effect.Effect<
      licensemanager.DeleteGrantResponse,
      licensemanager.DeleteGrantError
    >
  >
> {}
export const DeleteGrant = Binding.Service<DeleteGrant>(
  "AWS.LicenseManager.DeleteGrant",
);
