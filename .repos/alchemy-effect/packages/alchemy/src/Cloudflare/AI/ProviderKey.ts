import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { InputProps } from "../../Input.ts";
import * as Namespace from "../../Namespace.ts";
import * as Output from "../../Output.ts";
import { Secret } from "../SecretsStore/Secret.ts";
import { GatewayProvider } from "./GatewayProvider.ts";

export interface ProviderKeyProps {
  /**
   * The AI Gateway the provider key belongs to. The gateway must have its
   * `storeId` set to a Secrets Store id — Cloudflare resolves the key inside
   * that store. Changing the gateway triggers a replacement.
   */
  gatewayId: string;
  /**
   * The upstream provider the key authenticates against (e.g. `openai`,
   * `anthropic`, `workers-ai`). Changing the provider triggers a
   * replacement.
   */
  providerSlug: string;
  /**
   * The Secrets Store attached to the AI Gateway via `storeId`.
   */
  store: {
    storeId: string;
    accountId: string;
  };
  /**
   * The provider API key. Stored in Cloudflare Secrets Store and never bound
   * into the Worker runtime.
   */
  value: Redacted.Redacted<string>;
  /**
   * Alias distinguishing multiple keys for the same provider. Changing the
   * alias renames the backing secret, replacing it and the provider config.
   * @default "default"
   */
  alias?: string;
  /**
   * Optional free-form description on the Secrets Store secret.
   */
  comment?: string;
  /**
   * Whether this key is the gateway's default credential for the provider
   * (used when a request does not name a specific key).
   * @default false
   */
  defaultConfig?: boolean;
  /**
   * Maximum number of requests allowed per `rateLimitPeriod` through this
   * key. Omit for no limit. Changing the limit triggers a replacement
   * (Cloudflare exposes no update API for provider configs).
   */
  rateLimit?: number;
  /**
   * The rate limit window in seconds.
   * @default 60
   */
  rateLimitPeriod?: number;
}

export type ProviderKey = {
  /**
   * The Secrets Store secret holding the provider API key, named
   * `{gatewayId}_{providerSlug}_{alias}` and scoped to `ai_gateway`.
   */
  readonly secret: Secret;
  /**
   * The gateway's BYOK provider config referencing {@link secret}.
   */
  readonly gatewayProvider: GatewayProvider;
};

/**
 * Declares a Cloudflare AI Gateway BYOK provider key.
 *
 * Cloudflare requires BYOK secrets to live in the gateway's attached Secrets
 * Store, be scoped to `ai_gateway`, and use the exact
 * `{gatewayId}_{providerSlug}_{alias}` name. This helper keeps that naming
 * contract with the {@link GatewayProvider} declaration so app stacks do not
 * have to wire the secret and provider config manually.
 *
 * The children are namespaced under the given id: a {@link Secret} (child
 * `Secret`) holding the key, and a {@link GatewayProvider} (child `Provider`)
 * referencing it. It returns `{ secret, gatewayProvider }` so either
 * underlying resource stays addressable.
 *
 * Rotating `value` updates the secret in place. Changing `alias` (or
 * `providerSlug`) renames the secret — a replacement — and cascades: the
 * provider config is replaced and re-pointed at the new secret.
 *
 * @resource
 * @product AI Gateway
 * @category AI
 * @section Bringing your own key
 * @example Bring your own OpenAI key
 * ```typescript
 * const store = yield* Cloudflare.SecretsStore.Store("Store");
 *
 * const gateway = yield* Cloudflare.AI.Gateway("Gateway", {
 *   id: "my-gateway",
 *   storeId: store.storeId,
 * });
 *
 * const { secret, gatewayProvider } = yield* Cloudflare.AI.ProviderKey("OpenAiKey", {
 *   store,
 *   gatewayId: gateway.gatewayId,
 *   providerSlug: "openai",
 *   value: yield* Config.redacted("OPENAI_API_KEY"),
 * });
 * ```
 *
 * @example Multiple keys for one provider
 * Distinguish keys for the same provider with an `alias` — each alias gets
 * its own secret and provider config.
 * ```typescript
 * const production = yield* Cloudflare.AI.ProviderKey("OpenAiKey", {
 *   store,
 *   gatewayId: gateway.gatewayId,
 *   providerSlug: "openai",
 *   value: yield* Config.redacted("OPENAI_API_KEY"),
 * });
 *
 * const evals = yield* Cloudflare.AI.ProviderKey("OpenAiEvalsKey", {
 *   store,
 *   gatewayId: gateway.gatewayId,
 *   providerSlug: "openai",
 *   alias: "evals",
 *   value: yield* Config.redacted("OPENAI_EVALS_API_KEY"),
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/
 */
export const ProviderKey = (id: string, props: InputProps<ProviderKeyProps>) =>
  Effect.gen(function* () {
    const alias = props.alias ?? "default";
    const secret = yield* Secret("Secret", {
      store: props.store,
      name: Output.interpolate`${props.gatewayId}_${props.providerSlug}_${alias}`,
      value: props.value,
      scopes: ["ai_gateway"],
      comment: props.comment,
    });

    const gatewayProvider = yield* GatewayProvider("Provider", {
      gatewayId: props.gatewayId,
      providerSlug: props.providerSlug,
      alias,
      secretId: secret.secretId,
      defaultConfig: props.defaultConfig,
      rateLimit: props.rateLimit,
      rateLimitPeriod: props.rateLimitPeriod,
    });

    return {
      secret,
      gatewayProvider,
    } satisfies ProviderKey;
  }).pipe(Namespace.push(id));
