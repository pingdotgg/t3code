import { Credentials } from "@distilled.cloud/stripe";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";

/**
 * Stripe restricted-key permission. Names match the Dashboard RAK catalog
 * (`resource_read` / `resource_write`). Write implies read.
 *
 * Stripe does not currently expose a public API to mint restricted keys
 * (`POST /v2/iam/api_keys` is Stripe Apps private preview). Bindings still
 * declare the permissions they need so a future mint can honor them.
 */
export type StripePermission =
  | "accounts_read"
  | "accounts_write"
  | "apple_pay_domains_read"
  | "apple_pay_domains_write"
  | "apps_secrets_read"
  | "apps_secrets_write"
  | "billing_meters_read"
  | "billing_meters_write"
  | "billing_portal_read"
  | "billing_portal_write"
  | "checkout_sessions_read"
  | "checkout_sessions_write"
  | "coupons_read"
  | "coupons_write"
  | "credit_grants_read"
  | "credit_grants_write"
  | "customers_read"
  | "customers_write"
  | "entitlements_read"
  | "entitlements_write"
  | "files_read"
  | "files_write"
  | "issuing_read"
  | "issuing_write"
  | "payment_links_read"
  | "payment_links_write"
  | "payment_method_configurations_read"
  | "payment_method_configurations_write"
  | "payment_method_domains_read"
  | "payment_method_domains_write"
  | "plans_read"
  | "plans_write"
  | "prices_read"
  | "prices_write"
  | "products_read"
  | "products_write"
  | "promotion_codes_read"
  | "promotion_codes_write"
  | "radar_read"
  | "radar_write"
  | "shipping_rates_read"
  | "shipping_rates_write"
  | "tax_read"
  | "tax_write"
  | "terminal_read"
  | "terminal_write"
  | "webhook_endpoints_read"
  | "webhook_endpoints_write";

export interface RestrictedApiKeyProps {
  /**
   * Display name. If omitted, a unique name is generated from the stack,
   * stage, and logical id.
   */
  name?: string;
  /**
   * Optional Dashboard-created restricted key (`rk_test_…` / `rk_live_…`).
   * When omitted, the account secret from {@link Credentials} is used —
   * Stripe has no public API to mint restricted keys.
   */
  value?: string;
  /**
   * Permissions this key should have. Additional permissions are merged
   * in from bindings.
   */
  permissions?: StripePermission[];
}

/**
 * Binding contract for {@link RestrictedApiKey}. A capability contributes
 * the Stripe permissions it needs; they are merged onto the token.
 */
export type RestrictedApiKeyBinding = {
  permissions?: StripePermission[];
};

export type RestrictedApiKey = Resource<
  "Stripe.RestrictedApiKey",
  RestrictedApiKeyProps,
  {
    /** Stable id (logical physical name — Stripe has no key object id). */
    id: string;
    /** Display name. */
    name: string;
    /** Secret or restricted key value. Returned only to Alchemy state. */
    value: Redacted.Redacted<string>;
    /** Union of prop and binding permissions. */
    permissions: StripePermission[];
  },
  RestrictedApiKeyBinding,
  Providers
>;

/**
 * A least-privilege Stripe API key for a Function/Worker host.
 *
 * HTTP bindings call `token.bind(capability, { permissions })` the same
 * way Cloudflare HTTP bindings attach policies to an AccountApiToken.
 * Stripe restricted keys (`rk_…`) can only be created in the Dashboard
 * today — `POST /v2/iam/api_keys` is Stripe Apps private preview. Until
 * that API is generally available, this resource stores the collected
 * permissions and injects either a user-supplied RAK or the account
 * secret key.
 *
 * ### Creating a token
 * **Example:** Host token, permissions from bindings
 * ```typescript
 * const token = yield* Stripe.RestrictedApiKey("ApiToken");
 * yield* token.bind`RetrieveProduct`({
 *   permissions: ["products_read"],
 * });
 * ```
 *
 * **Example:** Dashboard-created restricted key
 * ```typescript
 * const token = yield* Stripe.RestrictedApiKey("ApiToken", {
 *   value: process.env.STRIPE_RESTRICTED_KEY,
 *   permissions: ["customers_read"],
 * });
 * ```
 *
 * @resource
 * @product Secrets
 */
export const RestrictedApiKey = Resource<RestrictedApiKey>(
  "Stripe.RestrictedApiKey",
);

const resolveName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id }));
  });

export const collectPermissions = (
  props: StripePermission[] | undefined,
  bindings: { data: RestrictedApiKeyBinding }[],
): StripePermission[] => {
  const set = new Set<StripePermission>(props ?? []);
  for (const binding of bindings) {
    for (const permission of binding.data.permissions ?? []) {
      set.add(permission);
    }
  }
  return [...set].sort();
};

export const RestrictedApiKeyProvider = () =>
  Provider.succeed(RestrictedApiKey, {
    stables: ["id"],

    diff: Effect.fn(function* () {
      return undefined;
    }),

    read: Effect.fn(function* ({ output }) {
      return output;
    }),

    // Logical token only — there is no Stripe list of keys we created.
    list: Effect.fn(function* () {
      return [];
    }),

    reconcile: Effect.fn(function* ({ id, news, output, bindings }) {
      const props = news ?? {};
      const name = yield* resolveName(id, props.name);
      const permissions = collectPermissions(props.permissions, bindings);
      // TODO: Mint a real restricted key once Stripe publishes a public
      // create-key API. `POST /v2/iam/api_keys` (Stripe Apps IAM preview)
      // 404s as of 2026-08. Pass `permissions` (props + bindings) as the
      // key's scopes, persist the returned `rk_…` as `value`, and teach
      // list/delete to enumerate/revoke it. Until then this is a logical
      // token: Dashboard `news.value` or the account secret.
      const value =
        props.value !== undefined
          ? Redacted.make(props.value)
          : yield* Effect.gen(function* () {
              const resolve = yield* Credentials;
              const cfg = yield* resolve;
              return Redacted.make(Redacted.value(cfg.apiKey));
            });
      return {
        id: output?.id ?? name,
        name,
        value,
        permissions,
      };
    }),

    delete: Effect.fn(function* () {
      // Dashboard-created RAKs are not deleted; we never minted a Stripe
      // object for the default account-secret path.
    }),
  });
