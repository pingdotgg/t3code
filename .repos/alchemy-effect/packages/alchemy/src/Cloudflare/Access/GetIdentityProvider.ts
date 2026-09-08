import type * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type {
  IdentityProviderAttributes,
  IdentityProviderType,
} from "./IdentityProvider.ts";

/**
 * Filters for looking up an existing Access identity provider. At least
 * one of `name` or `type` is required; when both are given the IdP must
 * match both. The first match wins (names are not unique on Cloudflare's
 * side).
 */
export type FindIdentityProviderOptions = {
  /**
   * Zone to search (legacy zone-level Access). When omitted, the
   * account-level (Zero Trust organization) IdPs are searched.
   */
  zoneId?: string;
} & (
  | {
      /** Exact display name to match. `""` matches the managed WARP IdP. */
      name: string;
      /** IdP type to match, e.g. `"cloudflare"` or `"okta"`. */
      type?: IdentityProviderType;
    }
  | {
      /** Exact display name to match. `""` matches the managed WARP IdP. */
      name?: string;
      /** IdP type to match, e.g. `"cloudflare"` or `"okta"`. */
      type: IdentityProviderType;
    }
);

/**
 * Looks up an existing Access identity provider by display name and/or
 * type, returning its attributes — or `undefined` when nothing matches.
 *
 * As a **data source**, invoke it at plan time via
 * {@link getIdentityProvider} — the result is an `Output` resolved during
 * plan/deploy and inert inside deployed bundles. Useful for referencing
 * IdPs that are managed outside the stack (e.g. the dashboard-provisioned
 * `cloudflare` WARP login method, whose display name is often `""`).
 * The implementation is registered by `Cloudflare.providers()`.
 *
 * As a **runtime binding** inside a Worker, provide
 * {@link GetIdentityProviderHttp} — it mints a scoped
 * {@link AccountApiToken} with the `Access: Organizations, Identity
 * Providers, and Groups Read` permission and binds it into the Worker so
 * the lookup can run at runtime.
 * ### Looking Up Identity Providers
 * **Example:** Restrict an Access application to the managed WARP IdP
 * ```typescript
 * const warpIdp = Cloudflare.Access.getIdentityProvider({
 *   type: "cloudflare",
 * });
 *
 * yield* Cloudflare.Access.Application("Admin", {
 *   domain: "admin.example.com",
 *   allowedIdps: [warpIdp.identityProviderId.as<string>()],
 * });
 * ```
 * **Example:** Look up an IdP by display name
 * ```typescript
 * const okta = Cloudflare.Access.getIdentityProvider({ name: "Okta SSO" });
 * ```
 * **Example:** Look up an IdP at runtime inside a Worker
 * ```typescript
 * // init — bind the lookup
 * const findWarpIdp = yield* Cloudflare.Access.GetIdentityProvider({
 *   type: "cloudflare",
 * });
 *
 * // runtime — resolve the IdP
 * const warp = yield* findWarpIdp();
 * ```
 *
 * @binding
 */
export interface GetIdentityProvider extends Binding.Service<
  GetIdentityProvider,
  "Cloudflare.Access.GetIdentityProvider",
  (
    options: FindIdentityProviderOptions,
  ) => Effect.Effect<
    () => Effect.Effect<
      IdentityProviderAttributes | undefined,
      | zeroTrust.ListIdentityProvidersForAccountError
      | zeroTrust.ListIdentityProvidersForZoneError,
      RuntimeContext
    >,
    never,
    CloudflareEnvironment
  >
> {}

export const GetIdentityProvider = Binding.Service<GetIdentityProvider>(
  "Cloudflare.Access.GetIdentityProvider",
);

/**
 * Plan-time identity-provider lookup — the data-source form of
 * {@link GetIdentityProvider} (what Terraform calls a data source and
 * Pulumi an invoke). Returns an
 * `Output<IdentityProviderAttributes | undefined>` resolved during
 * plan/deploy; safe to call from composition code that is re-executed
 * inside a deployed runtime bundle.
 */
export const getIdentityProvider = GetIdentityProvider.execute;
