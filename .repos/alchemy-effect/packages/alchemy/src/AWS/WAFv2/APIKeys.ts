import type * as WAFV2 from "@distilled.cloud/aws/wafv2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `wafv2:CreateAPIKey` — mint an API key for the
 * CAPTCHA JavaScript integration, scoped to up to 5 token domains (e.g.
 * onboarding a new tenant domain in a SaaS). The returned key is embedded
 * in client-side JavaScript by design (it is not a secret credential).
 *
 * Provide `WAFv2.CreateAPIKeyHttp` on the hosting Lambda Function to
 * satisfy the requirement.
 * @binding
 * @section CAPTCHA API Keys
 * @example Mint a CAPTCHA API Key for a Domain
 * ```typescript
 * // init — grants wafv2:CreateAPIKey
 * const createAPIKey = yield* AWS.WAFv2.CreateAPIKey();
 *
 * // runtime
 * const { APIKey } = yield* createAPIKey({
 *   Scope: "REGIONAL",
 *   TokenDomains: ["example.com"],
 * });
 * ```
 */
export interface CreateAPIKey extends Binding.Service<
  CreateAPIKey,
  "AWS.WAFv2.CreateAPIKey",
  () => Effect.Effect<
    (
      request: WAFV2.CreateAPIKeyRequest,
    ) => Effect.Effect<WAFV2.CreateAPIKeyResponse, WAFV2.CreateAPIKeyError>
  >
> {}

export const CreateAPIKey = Binding.Service<CreateAPIKey>(
  "AWS.WAFv2.CreateAPIKey",
);

/**
 * Runtime binding for `wafv2:GetDecryptedAPIKey` — read the token domains
 * and creation time encoded in a CAPTCHA API key.
 *
 * Provide `WAFv2.GetDecryptedAPIKeyHttp` on the hosting Lambda Function to
 * satisfy the requirement.
 * @binding
 * @section CAPTCHA API Keys
 * @example Inspect an API Key
 * ```typescript
 * // init — grants wafv2:GetDecryptedAPIKey
 * const getDecryptedAPIKey = yield* AWS.WAFv2.GetDecryptedAPIKey();
 *
 * // runtime
 * const { TokenDomains } = yield* getDecryptedAPIKey({
 *   Scope: "REGIONAL",
 *   APIKey: apiKey,
 * });
 * ```
 */
export interface GetDecryptedAPIKey extends Binding.Service<
  GetDecryptedAPIKey,
  "AWS.WAFv2.GetDecryptedAPIKey",
  () => Effect.Effect<
    (
      request: WAFV2.GetDecryptedAPIKeyRequest,
    ) => Effect.Effect<
      WAFV2.GetDecryptedAPIKeyResponse,
      WAFV2.GetDecryptedAPIKeyError
    >
  >
> {}

export const GetDecryptedAPIKey = Binding.Service<GetDecryptedAPIKey>(
  "AWS.WAFv2.GetDecryptedAPIKey",
);

/**
 * Runtime binding for `wafv2:ListAPIKeys` — list the CAPTCHA API keys
 * defined for a scope (also returns the CAPTCHA JavaScript integration
 * URL).
 *
 * Provide `WAFv2.ListAPIKeysHttp` on the hosting Lambda Function to
 * satisfy the requirement.
 * @binding
 * @section CAPTCHA API Keys
 * @example List API Keys
 * ```typescript
 * // init — grants wafv2:ListAPIKeys
 * const listAPIKeys = yield* AWS.WAFv2.ListAPIKeys();
 *
 * // runtime
 * const { APIKeySummaries } = yield* listAPIKeys({ Scope: "REGIONAL" });
 * ```
 */
export interface ListAPIKeys extends Binding.Service<
  ListAPIKeys,
  "AWS.WAFv2.ListAPIKeys",
  () => Effect.Effect<
    (
      request: WAFV2.ListAPIKeysRequest,
    ) => Effect.Effect<WAFV2.ListAPIKeysResponse, WAFV2.ListAPIKeysError>
  >
> {}

export const ListAPIKeys = Binding.Service<ListAPIKeys>(
  "AWS.WAFv2.ListAPIKeys",
);

/**
 * Runtime binding for `wafv2:DeleteAPIKey` — delete a CAPTCHA API key
 * (e.g. offboarding a tenant domain).
 *
 * Provide `WAFv2.DeleteAPIKeyHttp` on the hosting Lambda Function to
 * satisfy the requirement.
 * @binding
 * @section CAPTCHA API Keys
 * @example Delete an API Key
 * ```typescript
 * // init — grants wafv2:DeleteAPIKey
 * const deleteAPIKey = yield* AWS.WAFv2.DeleteAPIKey();
 *
 * // runtime
 * yield* deleteAPIKey({ Scope: "REGIONAL", APIKey: apiKey });
 * ```
 */
export interface DeleteAPIKey extends Binding.Service<
  DeleteAPIKey,
  "AWS.WAFv2.DeleteAPIKey",
  () => Effect.Effect<
    (
      request: WAFV2.DeleteAPIKeyRequest,
    ) => Effect.Effect<WAFV2.DeleteAPIKeyResponse, WAFV2.DeleteAPIKeyError>
  >
> {}

export const DeleteAPIKey = Binding.Service<DeleteAPIKey>(
  "AWS.WAFv2.DeleteAPIKey",
);
