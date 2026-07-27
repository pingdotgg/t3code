import type * as ag from "@distilled.cloud/aws/api-gateway";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface CreateApiKeyRequest extends ag.CreateApiKeyRequest {}

/**
 * Runtime binding for issuing API Gateway API keys
 * (`apigateway:POST` on `/apikeys`). Account-scoped — takes no resource.
 *
 * The response's `value` is `Redacted<string>` (distilled marks it
 * sensitive), so the plaintext key never leaks into logs. Provide
 * `ApiGateway.CreateApiKeyHttp` on the Function effect to implement the
 * binding.
 *
 * @binding
 * @section Issuing API keys
 * @example Issue a key for a new customer
 * ```typescript
 * import * as Redacted from "effect/Redacted";
 *
 * // init — account-level binding takes no resource
 * const createApiKey = yield* ApiGateway.CreateApiKey();
 *
 * // runtime
 * const key = yield* createApiKey({
 *   name: `customer-${customerId}`,
 *   enabled: true,
 * });
 * const plaintext = Redacted.isRedacted(key.value)
 *   ? Redacted.value(key.value)
 *   : key.value;
 * ```
 */
export interface CreateApiKey extends Binding.Service<
  CreateApiKey,
  "AWS.ApiGateway.CreateApiKey",
  () => Effect.Effect<
    (
      request?: CreateApiKeyRequest,
    ) => Effect.Effect<ag.ApiKey, ag.CreateApiKeyError>
  >
> {}
export const CreateApiKey = Binding.Service<CreateApiKey>(
  "AWS.ApiGateway.CreateApiKey",
);
