import type * as AVP from "@distilled.cloud/aws/verifiedpermissions";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { PolicyStore } from "./PolicyStore.ts";

export interface IsAuthorizedRequest extends Omit<
  AVP.IsAuthorizedInput,
  "policyStoreId"
> {}
export interface IsAuthorizedWithTokenRequest extends Omit<
  AVP.IsAuthorizedWithTokenInput,
  "policyStoreId"
> {}
export interface BatchIsAuthorizedRequest extends Omit<
  AVP.BatchIsAuthorizedInput,
  "policyStoreId"
> {}
export interface BatchIsAuthorizedWithTokenRequest extends Omit<
  AVP.BatchIsAuthorizedWithTokenInput,
  "policyStoreId"
> {}

/**
 * The runtime authorization client returned by binding `IsAuthorized` to a
 * `PolicyStore`. Each method injects the store's `policyStoreId`
 * automatically.
 */
export interface IsAuthorizedClient {
  /**
   * Make a single authorization decision (`Allow` / `Deny`) for a principal,
   * action, and resource against the store's policies.
   */
  isAuthorized(
    request: IsAuthorizedRequest,
  ): Effect.Effect<AVP.IsAuthorizedOutput, AVP.IsAuthorizedError>;
  /**
   * Make an authorization decision where the principal is derived from a JWT
   * (identity or access token) issued by a configured identity source.
   */
  isAuthorizedWithToken(
    request: IsAuthorizedWithTokenRequest,
  ): Effect.Effect<
    AVP.IsAuthorizedWithTokenOutput,
    AVP.IsAuthorizedWithTokenError
  >;
  /**
   * Make up to 30 authorization decisions in one call, sharing one principal
   * or one resource across the batch.
   */
  batchIsAuthorized(
    request: BatchIsAuthorizedRequest,
  ): Effect.Effect<AVP.BatchIsAuthorizedOutput, AVP.BatchIsAuthorizedError>;
  /**
   * Make up to 30 authorization decisions in one call for the principal
   * derived from a JWT (identity or access token) issued by a configured
   * identity source.
   */
  batchIsAuthorizedWithToken(
    request: BatchIsAuthorizedWithTokenRequest,
  ): Effect.Effect<
    AVP.BatchIsAuthorizedWithTokenOutput,
    AVP.BatchIsAuthorizedWithTokenError
  >;
}

/**
 * Runtime binding for Verified Permissions authorization — bind it to a
 * `PolicyStore` inside a function runtime to get a client that evaluates
 * authorization requests against the store's Cedar policies.
 *
 * This is the effectful-function DX for authorization: a Lambda calls
 * `isAuthorized(...)` and Verified Permissions returns `Allow` or `Deny`
 * along with the determining policies.
 * @binding
 * @section Authorizing Requests
 * @example Decide a Request in a Lambda
 * ```typescript
 * // init
 * const authz = yield* AWS.VerifiedPermissions.IsAuthorized(store);
 *
 * // runtime
 * const { decision } = yield* authz.isAuthorized({
 *   principal: { entityType: "PhotoApp::User", entityId: "alice" },
 *   action: { actionType: "PhotoApp::Action", actionId: "viewPhoto" },
 *   resource: { entityType: "PhotoApp::Photo", entityId: "vacation.jpg" },
 * });
 * // decision === "ALLOW" | "DENY"
 * ```
 *
 * @example Decide from a JWT
 * ```typescript
 * const { decision } = yield* authz.isAuthorizedWithToken({
 *   identityToken,
 *   action: { actionType: "PhotoApp::Action", actionId: "viewPhoto" },
 *   resource: { entityType: "PhotoApp::Photo", entityId: "vacation.jpg" },
 * });
 * ```
 */
export interface IsAuthorized extends Binding.Service<
  IsAuthorized,
  "AWS.VerifiedPermissions.IsAuthorized",
  <S extends PolicyStore>(store: S) => Effect.Effect<IsAuthorizedClient>
> {}
export const IsAuthorized = Binding.Service<IsAuthorized>(
  "AWS.VerifiedPermissions.IsAuthorized",
);
