import type * as ci from "@distilled.cloud/aws/cognito-identity";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { IdentityPool } from "./IdentityPool.ts";

export interface ListIdentitiesRequest extends Omit<
  ci.ListIdentitiesInput,
  "IdentityPoolId"
> {}
export interface LookupDeveloperIdentityRequest extends Omit<
  ci.LookupDeveloperIdentityInput,
  "IdentityPoolId"
> {}
export interface MergeDeveloperIdentitiesRequest extends Omit<
  ci.MergeDeveloperIdentitiesInput,
  "IdentityPoolId"
> {}
export interface UnlinkDeveloperIdentityRequest extends Omit<
  ci.UnlinkDeveloperIdentityInput,
  "IdentityPoolId"
> {}
export interface GetOpenIdTokenForDeveloperIdentityRequest extends Omit<
  ci.GetOpenIdTokenForDeveloperIdentityInput,
  "IdentityPoolId"
> {}

/**
 * The typed client returned by binding {@link IdentityPoolAdmin} to an
 * `IdentityPool`. Pool-scoped calls automatically inject the identity pool
 * ID and are authorized by IAM (`cognito-identity:*` on the pool's ARN).
 */
export interface IdentityPoolAdminClient {
  /** Fetch an identity's linked logins and metadata. */
  describeIdentity: (
    request: ci.DescribeIdentityInput,
  ) => Effect.Effect<ci.IdentityDescription, ci.DescribeIdentityError>;
  /** Page through the identities registered in the pool. */
  listIdentities: (
    request: ListIdentitiesRequest,
  ) => Effect.Effect<ci.ListIdentitiesResponse, ci.ListIdentitiesError>;
  /** Permanently delete identities from the pool. */
  deleteIdentities: (
    request: ci.DeleteIdentitiesInput,
  ) => Effect.Effect<ci.DeleteIdentitiesResponse, ci.DeleteIdentitiesError>;
  /** Look up an identity by developer user identifier (or vice versa). */
  lookupDeveloperIdentity: (
    request: LookupDeveloperIdentityRequest,
  ) => Effect.Effect<
    ci.LookupDeveloperIdentityResponse,
    ci.LookupDeveloperIdentityError
  >;
  /** Merge two developer-authenticated identities into one. */
  mergeDeveloperIdentities: (
    request: MergeDeveloperIdentitiesRequest,
  ) => Effect.Effect<
    ci.MergeDeveloperIdentitiesResponse,
    ci.MergeDeveloperIdentitiesError
  >;
  /** Unlink a developer user identifier from an identity. */
  unlinkDeveloperIdentity: (
    request: UnlinkDeveloperIdentityRequest,
  ) => Effect.Effect<
    ci.UnlinkDeveloperIdentityResponse,
    ci.UnlinkDeveloperIdentityError
  >;
  /** Mint an OpenID Connect token for a developer-authenticated identity
   * (server-side developer provider flow). */
  getOpenIdTokenForDeveloperIdentity: (
    request: GetOpenIdTokenForDeveloperIdentityRequest,
  ) => Effect.Effect<
    ci.GetOpenIdTokenForDeveloperIdentityResponse,
    ci.GetOpenIdTokenForDeveloperIdentityError
  >;
}

/**
 * Runtime binding for administrative Cognito identity pool operations —
 * identity management and the developer-authenticated identities flow.
 *
 * Bind this to an `IdentityPool` inside a function runtime to get a typed
 * client for listing/deleting identities and for developer-provider token
 * minting. The binding grants the corresponding `cognito-identity:*` IAM
 * actions scoped to the pool's ARN and injects the pool ID into pool-scoped
 * calls.
 * @binding
 * @section Managing Identities
 * @example List and Describe Identities
 * ```typescript
 * const identities = yield* Cognito.IdentityPoolAdmin(identityPool);
 *
 * const page = yield* identities.listIdentities({ MaxResults: 20 });
 * const first = page.Identities?.[0];
 * if (first?.IdentityId) {
 *   const detail = yield* identities.describeIdentity({
 *     IdentityId: first.IdentityId,
 *   });
 * }
 * ```
 *
 * @section Developer-Authenticated Identities
 * @example Mint a Token for a Backend-Authenticated User
 * ```typescript
 * const token = yield* identities.getOpenIdTokenForDeveloperIdentity({
 *   Logins: { "my.developer.provider": userId },
 * });
 * ```
 */
export interface IdentityPoolAdmin extends Binding.Service<
  IdentityPoolAdmin,
  "AWS.Cognito.IdentityPoolAdmin",
  <P extends IdentityPool>(pool: P) => Effect.Effect<IdentityPoolAdminClient>
> {}
export const IdentityPoolAdmin = Binding.Service<IdentityPoolAdmin>(
  "AWS.Cognito.IdentityPoolAdmin",
);
