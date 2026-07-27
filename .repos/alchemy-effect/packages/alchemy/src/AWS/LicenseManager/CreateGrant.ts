import type * as licensemanager from "@distilled.cloud/aws/license-manager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link CreateGrant}.
 */
export interface CreateGrantRequest extends licensemanager.CreateGrantRequest {}

/**
 * Runtime binding for `license-manager:CreateGrant` — share a seller-issued
 * license's entitlements with an Amazon Web Services account, organization,
 * or organizational unit. The distribution half of an ISV fulfillment
 * backend: after minting a license with `CreateLicense`, grant it to the
 * customer's account.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.LicenseManager.CreateGrantHttp)`.
 * @binding
 * @section Managing Grants
 * @example Grant a License to a Customer Account
 * ```typescript
 * // init
 * const createGrant = yield* AWS.LicenseManager.CreateGrant();
 *
 * // runtime
 * const { GrantArn } = yield* createGrant({
 *   GrantName: "customer-grant",
 *   LicenseArn: licenseArn,
 *   HomeRegion: region,
 *   Principals: [`arn:aws:iam::${customerAccountId}:root`],
 *   AllowedOperations: ["CheckoutLicense", "CheckInLicense", "ExtendConsumptionLicense", "ListPurchasedLicenses"],
 *   ClientToken: crypto.randomUUID(),
 * });
 * ```
 */
export interface CreateGrant extends Binding.Service<
  CreateGrant,
  "AWS.LicenseManager.CreateGrant",
  () => Effect.Effect<
    (
      request: CreateGrantRequest,
    ) => Effect.Effect<
      licensemanager.CreateGrantResponse,
      licensemanager.CreateGrantError
    >
  >
> {}
export const CreateGrant = Binding.Service<CreateGrant>(
  "AWS.LicenseManager.CreateGrant",
);
