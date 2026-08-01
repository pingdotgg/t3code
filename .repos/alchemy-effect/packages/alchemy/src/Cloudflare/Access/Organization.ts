import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Effect from "effect/Effect";

import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

export type OrganizationProps = {
  /**
   * The unique subdomain assigned to your Zero Trust organization, e.g.
   * `acme.cloudflareaccess.com`. Per-account this is functionally immutable —
   * Cloudflare allocates exactly one team domain when the account first
   * enables Zero Trust and changing it is a manual support operation.
   *
   * @see https://developers.cloudflare.com/cloudflare-one/setup/#1-create-a-team-name
   */
  authDomain: string;
  /**
   * Human-readable display name of your Zero Trust organization. Usually the
   * same as `authDomain`. Mutable.
   *
   * @see https://developers.cloudflare.com/api/operations/zero-trust-organization-update-your-zero-trust-organization
   */
  name?: string;
  /**
   * Default session lifetime for Access applications. Must be a Go duration
   * string (e.g. `30m`, `2h45m`, `24h`). Valid units: `ns`, `us`, `ms`, `s`,
   * `m`, `h`. Per-application settings override this default.
   *
   * @see https://developers.cloudflare.com/cloudflare-one/identity/users/session-management/
   */
  sessionDuration?: string;
  /**
   * When `true`, users may authenticate to Access applications via the WARP
   * client without going through the configured identity providers. Per-app
   * settings take precedence.
   *
   * @default false
   * @see https://developers.cloudflare.com/cloudflare-one/identity/devices/warp-authentication-identity/
   */
  allowAuthenticateViaWarp?: boolean;
  /**
   * When `true`, all Zero Trust settings in the Cloudflare dashboard are
   * read-only and may only be modified via the API or Terraform.
   *
   * @default false
   */
  isUiReadOnly?: boolean;
  /**
   * When `true`, users skip the identity provider selection step on login.
   * Only valid when exactly one IdP is configured (or one is set as default).
   *
   * @default false
   */
  autoRedirectToIdentity?: boolean;
  /**
   * Free-form description of why `isUiReadOnly` is toggled. Surfaced in the
   * Cloudflare dashboard.
   */
  uiReadOnlyToggleReason?: string;
  /**
   * Duration of user-seat inactivity before the user is removed as an active
   * seat and stops counting against the Teams seat quota. Go duration string.
   */
  userSeatExpirationInactiveTime?: string;
  /**
   * Lifetime of tokens issued by the WARP authentication flow. Go duration
   * string limited to `m` and `h` units, e.g. `30m` or `2h45m`.
   */
  warpAuthSessionDuration?: string;
  /**
   * Branding for the Access login screen.
   *
   * @see https://developers.cloudflare.com/cloudflare-one/identity/users/login-page/
   */
  loginDesign?: Organization.LoginDesign;
  /**
   * Pointers to custom HTML pages shown when Access blocks a request.
   *
   * @see https://developers.cloudflare.com/cloudflare-one/policies/access/custom-pages/
   */
  customPages?: Organization.CustomPages;
};

export declare namespace Organization {
  /**
   * Branding for the Access login screen.
   */
  export interface LoginDesign {
    /** URL of the logo image rendered at the top of the login form. */
    logoPath?: string;
    /** CSS color for the header background, e.g. `#1a1a1a`. */
    headerBgColor?: string;
    /** CSS color for the page background. */
    backgroundColor?: string;
    /** CSS color for the body text. */
    textColor?: string;
    /** Markdown rendered at the top of the login form (legacy). */
    headerText?: string;
    /** Markdown rendered at the bottom of the login form. */
    footerText?: string;
  }
  /**
   * Pointers to custom HTML pages shown when Access denies a request.
   */
  export interface CustomPages {
    /**
     * UUID of a custom forbidden page (created via the Access Custom Pages
     * API) shown when a policy denies access.
     */
    forbidden?: string;
    /**
     * UUID of a custom identity-denied page shown when the identity provider
     * rejects the user.
     */
    identityDenied?: string;
  }
}

export type Organization = Resource<
  "Cloudflare.Access.Organization",
  OrganizationProps,
  {
    /** Cloudflare account that owns the Zero Trust organization. */
    accountId: string;
    /** The Zero Trust team domain, e.g. `acme.cloudflareaccess.com`. */
    authDomain: string;
    /** Display name of the organization. */
    name: string;
    /** Default Access application session duration. */
    sessionDuration: string | undefined;
    /** WARP-as-IdP toggle observed on Cloudflare. */
    allowAuthenticateViaWarp: boolean | undefined;
    /** Dashboard read-only lock observed on Cloudflare. */
    isUiReadOnly: boolean | undefined;
    /** Skip-IdP-picker toggle observed on Cloudflare. */
    autoRedirectToIdentity: boolean | undefined;
    /** Free-form note explaining the `isUiReadOnly` setting. */
    uiReadOnlyToggleReason: string | undefined;
    /** User-seat inactivity expiration observed on Cloudflare. */
    userSeatExpirationInactiveTime: string | undefined;
    /** WARP authentication session duration observed on Cloudflare. */
    warpAuthSessionDuration: string | undefined;
    /** Login-page branding observed on Cloudflare. */
    loginDesign: Organization.LoginDesign | undefined;
    /** Custom-pages pointers observed on Cloudflare. */
    customPages: Organization.CustomPages | undefined;
  },
  never,
  Providers
>;

/**
 * Account-level Cloudflare Zero Trust organization settings — the team
 * domain, login branding, session lifetimes, WARP authentication toggle, etc.
 *
 * Wraps `PUT /accounts/{account_id}/access/organizations`.
 * @resource
 * @product Access
 * @category Cloudflare One (Zero Trust)
 * @remarks
 * **This resource is a singleton.** Every Cloudflare account owns exactly one
 * Access Organization; you cannot create a second one and you cannot delete
 * the existing one without deleting the entire Cloudflare account. As a
 * result:
 *
 * - The `reconcile` lifecycle always **adopts** the existing organization on
 *   first deploy rather than failing on conflict.
 * - The `delete` lifecycle is a **no-op** that logs a warning. Removing the
 *   resource from your stack leaves the Cloudflare-side settings untouched.
 *
 * @section Configuring the organization
 * @example Adopt and brand the organization
 * ```typescript
 * const org = yield* Cloudflare.Access.Organization("Org", {
 *   authDomain: "acme.cloudflareaccess.com",
 *   name: "Acme",
 *   sessionDuration: "24h",
 *   allowAuthenticateViaWarp: true,
 *   loginDesign: {
 *     logoPath: "https://acme.example/logo.png",
 *     backgroundColor: "#111111",
 *     textColor: "#ffffff",
 *   },
 * });
 * ```
 */
export const Organization = Resource<Organization>(
  "Cloudflare.Access.Organization",
  { aliases: ["Cloudflare.AccessOrganization"] },
);

export const OrganizationProvider = () =>
  Provider.succeed(Organization, {
    nuke: { singleton: true },
    stables: ["accountId", "authDomain"],
    reconcile: Effect.fn(function* ({ news }) {
      const { accountId } = yield* yield* CloudflareEnvironment;

      const desiredName = news.name ?? news.authDomain;
      const loginDesign = buildLoginDesign(news.loginDesign);
      const customPages = news.customPages
        ? {
            ...(news.customPages.forbidden !== undefined
              ? { forbidden: news.customPages.forbidden }
              : {}),
            ...(news.customPages.identityDenied !== undefined
              ? { identityDenied: news.customPages.identityDenied }
              : {}),
          }
        : undefined;

      // Observe — singleton lookup. The org always exists for any
      // account that has enabled Zero Trust; only a brand-new account
      // returns "missing".
      let observed = yield* observe();

      // Ensure — create on a fresh account. If a race or out-of-band
      // setup created it between the observe and create call, fall
      // back to update.
      if (!observed) {
        observed = yield* zeroTrust
          .createOrganizationForAccount({
            accountId,
            authDomain: news.authDomain,
            name: desiredName,
            ...(news.sessionDuration !== undefined
              ? { sessionDuration: news.sessionDuration }
              : {}),
            ...(news.allowAuthenticateViaWarp !== undefined
              ? { allowAuthenticateViaWarp: news.allowAuthenticateViaWarp }
              : {}),
            ...(news.isUiReadOnly !== undefined
              ? { isUiReadOnly: news.isUiReadOnly }
              : {}),
            ...(news.autoRedirectToIdentity !== undefined
              ? { autoRedirectToIdentity: news.autoRedirectToIdentity }
              : {}),
            ...(news.uiReadOnlyToggleReason !== undefined
              ? { uiReadOnlyToggleReason: news.uiReadOnlyToggleReason }
              : {}),
            ...(news.userSeatExpirationInactiveTime !== undefined
              ? {
                  userSeatExpirationInactiveTime:
                    news.userSeatExpirationInactiveTime,
                }
              : {}),
            ...(news.warpAuthSessionDuration !== undefined
              ? { warpAuthSessionDuration: news.warpAuthSessionDuration }
              : {}),
            ...(loginDesign ? { loginDesign } : {}),
          })
          .pipe(
            Effect.catchTag("OrganizationAlreadyExists", () =>
              Effect.gen(function* () {
                const existing = yield* observe();
                if (existing) return existing;
                return yield* Effect.fail(
                  new Error(
                    "Cloudflare returned OrganizationAlreadyExists on createOrganizationForAccount but the org could not be observed afterwards",
                  ),
                );
              }),
            ),
          );
      }

      // Sync — Cloudflare's PUT is a true upsert. Always push so any
      // drift in observed vs desired converges in one call. Cheap and
      // idempotent.
      const updated = yield* zeroTrust.updateOrganizationForAccount({
        accountId,
        authDomain: news.authDomain,
        name: desiredName,
        ...(news.sessionDuration !== undefined
          ? { sessionDuration: news.sessionDuration }
          : {}),
        ...(news.allowAuthenticateViaWarp !== undefined
          ? { allowAuthenticateViaWarp: news.allowAuthenticateViaWarp }
          : {}),
        ...(news.isUiReadOnly !== undefined
          ? { isUiReadOnly: news.isUiReadOnly }
          : {}),
        ...(news.autoRedirectToIdentity !== undefined
          ? { autoRedirectToIdentity: news.autoRedirectToIdentity }
          : {}),
        ...(news.uiReadOnlyToggleReason !== undefined
          ? { uiReadOnlyToggleReason: news.uiReadOnlyToggleReason }
          : {}),
        ...(news.userSeatExpirationInactiveTime !== undefined
          ? {
              userSeatExpirationInactiveTime:
                news.userSeatExpirationInactiveTime,
            }
          : {}),
        ...(news.warpAuthSessionDuration !== undefined
          ? { warpAuthSessionDuration: news.warpAuthSessionDuration }
          : {}),
        ...(loginDesign ? { loginDesign } : {}),
        ...(customPages ? { customPages } : {}),
      });

      return toAttrs(accountId, updated, news.authDomain, desiredName);
    }),
    delete: Effect.fn(function* () {
      yield* Effect.logWarning(
        "Organization.delete is a no-op — the Cloudflare Access Organization is a singleton tied to the account and cannot be deleted without deleting the Cloudflare account itself.",
      );
    }),
    read: Effect.fn(function* ({ olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;

      const observed = yield* observe();
      if (!observed) return undefined;
      return toAttrs(
        accountId,
        observed,
        olds?.authDomain ?? observed.authDomain ?? "",
        olds?.name ?? observed.name ?? olds?.authDomain ?? "",
      );
    }),
    // Account singleton: every Cloudflare account owns exactly one Access
    // Organization and there is no enumeration API. Read the single org via
    // the same `observe` path `read` uses and return the one-element array
    // (or `[]` when the account has never enabled Zero Trust). `observe`
    // already swallows the typed `OrganizationNotFound` error.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      const observed = yield* observe();
      if (!observed) return [];
      return [
        toAttrs(
          accountId,
          observed,
          observed.authDomain ?? "",
          observed.name ?? observed.authDomain ?? "",
        ),
      ];
    }),
  });

const observe = Effect.fn(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;

  return yield* zeroTrust.listOrganizationsForAccount({ accountId }).pipe(
    Effect.map((org) => {
      // listOrganizationsForAccount returns a single object (the
      // singleton org) under `result`; an account that has not yet
      // enabled Zero Trust returns a sparse object with no
      // `authDomain`. Treat that as "missing".
      const typed = org as zeroTrust.ListOrganizationsResponse;
      return typed && typed.authDomain ? typed : undefined;
    }),
    Effect.catchTag("OrganizationNotFound", () =>
      Effect.succeed(
        undefined as zeroTrust.ListOrganizationsResponse | undefined,
      ),
    ),
  );
});

const toAttrs = (
  accountId: string,
  org: {
    authDomain?: string | null;
    name?: string | null;
    sessionDuration?: string | null;
    allowAuthenticateViaWarp?: boolean | null;
    isUiReadOnly?: boolean | null;
    autoRedirectToIdentity?: boolean | null;
    uiReadOnlyToggleReason?: string | null;
    userSeatExpirationInactiveTime?: string | null;
    warpAuthSessionDuration?: string | null;
    loginDesign?: {
      backgroundColor?: string | null;
      footerText?: string | null;
      headerText?: string | null;
      logoPath?: string | null;
      textColor?: string | null;
    } | null;
    customPages?: {
      forbidden?: string | null;
      identityDenied?: string | null;
    } | null;
  },
  fallbackAuthDomain: string,
  fallbackName: string,
) => ({
  accountId,
  authDomain: org.authDomain ?? fallbackAuthDomain,
  name: org.name ?? fallbackName,
  sessionDuration: org.sessionDuration ?? undefined,
  allowAuthenticateViaWarp: org.allowAuthenticateViaWarp ?? undefined,
  isUiReadOnly: org.isUiReadOnly ?? undefined,
  autoRedirectToIdentity: org.autoRedirectToIdentity ?? undefined,
  uiReadOnlyToggleReason: org.uiReadOnlyToggleReason ?? undefined,
  userSeatExpirationInactiveTime:
    org.userSeatExpirationInactiveTime ?? undefined,
  warpAuthSessionDuration: org.warpAuthSessionDuration ?? undefined,
  loginDesign: observedLoginDesign(org.loginDesign),
  customPages: observedCustomPages(org.customPages),
});

const buildLoginDesign = (
  design: Organization.LoginDesign | undefined,
):
  | {
      backgroundColor?: string;
      footerText?: string;
      headerText?: string;
      logoPath?: string;
      textColor?: string;
    }
  | undefined => {
  if (!design) return undefined;
  const out: {
    backgroundColor?: string;
    footerText?: string;
    headerText?: string;
    logoPath?: string;
    textColor?: string;
  } = {};
  if (design.backgroundColor !== undefined)
    out.backgroundColor = design.backgroundColor;
  if (design.footerText !== undefined) out.footerText = design.footerText;
  if (design.headerText !== undefined) out.headerText = design.headerText;
  if (design.logoPath !== undefined) out.logoPath = design.logoPath;
  if (design.textColor !== undefined) out.textColor = design.textColor;
  return out;
};

const observedLoginDesign = (
  design:
    | {
        backgroundColor?: string | null;
        footerText?: string | null;
        headerText?: string | null;
        logoPath?: string | null;
        textColor?: string | null;
      }
    | null
    | undefined,
): Organization.LoginDesign | undefined => {
  if (!design) return undefined;
  return {
    backgroundColor: design.backgroundColor ?? undefined,
    footerText: design.footerText ?? undefined,
    headerText: design.headerText ?? undefined,
    logoPath: design.logoPath ?? undefined,
    textColor: design.textColor ?? undefined,
  };
};

const observedCustomPages = (
  pages:
    | { forbidden?: string | null; identityDenied?: string | null }
    | null
    | undefined,
): Organization.CustomPages | undefined => {
  if (!pages) return undefined;
  return {
    forbidden: pages.forbidden ?? undefined,
    identityDenied: pages.identityDenied ?? undefined,
  };
};
