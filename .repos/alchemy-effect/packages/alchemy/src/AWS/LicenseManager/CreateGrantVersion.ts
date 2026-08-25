import type * as licensemanager from "@distilled.cloud/aws/license-manager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link CreateGrantVersion}.
 */
export interface CreateGrantVersionRequest
  extends licensemanager.CreateGrantVersionRequest {}

/**
 * Runtime binding for `license-manager:CreateGrantVersion` — publish a new
 * version of an existing grant. This is also how a recipient **activates**
 * an accepted grant: create a version with `Status: "ACTIVE"` (and how a
 * grantor amends allowed operations or deactivates a grant).
 *
 * Provide the implementation with
 * `Effect.provide(AWS.LicenseManager.CreateGrantVersionHttp)`.
 * @binding
 * @section Managing Grants
 * @example Activate an Accepted Grant
 * ```typescript
 * // init
 * const createGrantVersion = yield* AWS.LicenseManager.CreateGrantVersion();
 *
 * // runtime — after acceptGrant({ GrantArn })
 * yield* createGrantVersion({
 *   GrantArn: grantArn,
 *   Status: "ACTIVE",
 *   ClientToken: crypto.randomUUID(),
 * });
 * ```
 */
export interface CreateGrantVersion extends Binding.Service<
  CreateGrantVersion,
  "AWS.LicenseManager.CreateGrantVersion",
  () => Effect.Effect<
    (
      request: CreateGrantVersionRequest,
    ) => Effect.Effect<
      licensemanager.CreateGrantVersionResponse,
      licensemanager.CreateGrantVersionError
    >
  >
> {}
export const CreateGrantVersion = Binding.Service<CreateGrantVersion>(
  "AWS.LicenseManager.CreateGrantVersion",
);
