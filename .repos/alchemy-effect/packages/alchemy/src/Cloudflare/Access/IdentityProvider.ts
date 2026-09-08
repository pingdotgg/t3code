import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";
import {
  findByName,
  findByType,
  getIdp,
  isSingletonType,
  type ObservedIdp,
  toAttributes,
} from "./IdentityProviderLookup.ts";

const TypeId = "Cloudflare.Access.IdentityProvider" as const;
type TypeId = typeof TypeId;

/**
 * The type of identity provider. Determines which `config` fields are
 * meaningful — see Cloudflare's IdP integration docs for the per-type
 * shapes. Immutable — changing the type triggers a replacement.
 */
export type IdentityProviderType =
  | "onetimepin"
  | "azureAD"
  | "saml"
  | "centrify"
  | "facebook"
  | "github"
  | "google-apps"
  | "google"
  | "linkedin"
  | "oidc"
  | "okta"
  | "onelogin"
  | "pingone"
  | "yandex"
  | "cloudflare"
  | (string & {});

/**
 * The full, untyped per-type configuration surface of an identity
 * provider. Re-exports distilled's request shape so the complete
 * Cloudflare config surface (OAuth client credentials, OIDC endpoints,
 * SAML certs and SSO targets, SCIM claims, …) is available without
 * re-declaring the structure. Prefer the per-type configs
 * ({@link OidcConfig}, {@link SamlConfig}, {@link AzureADConfig}, …) —
 * they are enforced by the discriminated {@link IdentityProviderProps}.
 */
export type IdentityProviderConfig =
  zeroTrust.CreateIdentityProviderForAccountRequest["config"];

/**
 * OAuth client credentials shared by every OAuth/OIDC-based IdP type.
 */
export interface OAuthClientConfig {
  /**
   * OAuth client ID issued by the identity provider.
   */
  clientId: string;
  /**
   * OAuth client secret. Cloudflare masks this field on read, so it
   * diffs against the previously declared props rather than observed
   * cloud state.
   */
  clientSecret: string;
}

/**
 * Configuration for the built-in one-time PIN login method. Takes no
 * parameters — users receive a PIN at their email address.
 */
export interface OneTimePinConfig {}

/**
 * Configuration for the simple social OAuth providers: `github`,
 * `facebook`, `linkedin`, and `yandex`.
 */
export interface SocialOAuthConfig extends OAuthClientConfig {}

/**
 * Configuration for the `google` identity provider.
 */
export interface GoogleConfig extends OAuthClientConfig {
  /**
   * Custom OIDC claims to capture from the token and make available in
   * Access policies.
   */
  claims?: string[];
  /**
   * The claim to use as the user's email address.
   */
  emailClaimName?: string;
  /**
   * Enable Proof Key for Code Exchange (PKCE) on the OAuth flow.
   */
  pkceEnabled?: boolean;
}

/**
 * Configuration for the `google-apps` (Google Workspace) identity
 * provider.
 */
export interface GoogleAppsConfig extends GoogleConfig {
  /**
   * The Google Workspace domain users authenticate from,
   * e.g. `mycompany.com`.
   */
  appsDomain: string;
}

/**
 * Configuration for the `azureAD` (Microsoft Entra ID) identity
 * provider.
 */
export interface AzureADConfig extends OAuthClientConfig {
  /**
   * The Entra ID directory (tenant) ID.
   */
  directoryId: string;
  /**
   * Import Entra ID group membership into Access policies.
   */
  supportGroups?: boolean;
  /**
   * Send the Cloudflare-managed Conditional Access policy context to
   * Entra ID.
   */
  conditionalAccessEnabled?: boolean;
  /**
   * OIDC prompt behavior on the Microsoft login page.
   */
  prompt?: "login" | "select_account" | "none";
  /**
   * Custom OIDC claims to capture from the token and make available in
   * Access policies.
   */
  claims?: string[];
  /**
   * The claim to use as the user's email address.
   */
  emailClaimName?: string;
  /**
   * Enable Proof Key for Code Exchange (PKCE) on the OAuth flow.
   */
  pkceEnabled?: boolean;
}

/**
 * Configuration for the `centrify` identity provider.
 */
export interface CentrifyConfig extends OAuthClientConfig {
  /**
   * The Centrify account URL, e.g. `https://abc123.my.centrify.com`.
   */
  centrifyAccount: string;
  /**
   * The Centrify application ID, e.g. `exampleapp`.
   */
  centrifyAppId: string;
  /**
   * Custom OIDC claims to capture from the token and make available in
   * Access policies.
   */
  claims?: string[];
  /**
   * The claim to use as the user's email address.
   */
  emailClaimName?: string;
}

/**
 * Configuration for the `okta` identity provider.
 */
export interface OktaConfig extends OAuthClientConfig {
  /**
   * The Okta account URL, e.g. `https://dev-abc123.okta.com`.
   */
  oktaAccount: string;
  /**
   * The Okta authorization server ID to use, when not the default.
   */
  authorizationServerId?: string;
  /**
   * Custom OIDC claims to capture from the token and make available in
   * Access policies.
   */
  claims?: string[];
  /**
   * The claim to use as the user's email address.
   */
  emailClaimName?: string;
  /**
   * Enable Proof Key for Code Exchange (PKCE) on the OAuth flow.
   */
  pkceEnabled?: boolean;
}

/**
 * Configuration for the `onelogin` identity provider.
 */
export interface OneloginConfig extends OAuthClientConfig {
  /**
   * The OneLogin account URL, e.g. `https://mycompany.onelogin.com`.
   */
  oneloginAccount: string;
  /**
   * Custom OIDC claims to capture from the token and make available in
   * Access policies.
   */
  claims?: string[];
  /**
   * The claim to use as the user's email address.
   */
  emailClaimName?: string;
  /**
   * Enable Proof Key for Code Exchange (PKCE) on the OAuth flow.
   */
  pkceEnabled?: boolean;
}

/**
 * Configuration for the `pingone` (PingOne) identity provider.
 */
export interface PingoneConfig extends OAuthClientConfig {
  /**
   * The PingOne environment identifier.
   */
  pingEnvId: string;
  /**
   * Custom OIDC claims to capture from the token and make available in
   * Access policies.
   */
  claims?: string[];
  /**
   * The claim to use as the user's email address.
   */
  emailClaimName?: string;
  /**
   * Enable Proof Key for Code Exchange (PKCE) on the OAuth flow.
   */
  pkceEnabled?: boolean;
}

/**
 * Configuration for a generic `oidc` identity provider.
 */
export interface OidcConfig extends OAuthClientConfig {
  /**
   * The authorization endpoint of the IdP,
   * e.g. `https://idp.example.com/authorize`.
   */
  authUrl: string;
  /**
   * The token endpoint of the IdP, e.g. `https://idp.example.com/token`.
   */
  tokenUrl: string;
  /**
   * The JWKS endpoint of the IdP, e.g. `https://idp.example.com/keys`.
   */
  certsUrl: string;
  /**
   * OAuth scopes to request, e.g. `["openid", "email", "profile"]`.
   */
  scopes?: string[];
  /**
   * Custom OIDC claims to capture from the token and make available in
   * Access policies.
   */
  claims?: string[];
  /**
   * The claim to use as the user's email address.
   */
  emailClaimName?: string;
  /**
   * Enable Proof Key for Code Exchange (PKCE) on the OAuth flow.
   */
  pkceEnabled?: boolean;
}

/**
 * A SAML attribute translated into a request header on the origin.
 */
export interface SamlHeaderAttribute {
  /**
   * The SAML attribute to read.
   */
  attributeName?: string;
  /**
   * The request header to write the attribute value into.
   */
  headerName?: string;
}

/**
 * Configuration for a generic `saml` identity provider.
 */
export interface SamlConfig {
  /**
   * The IdP entity ID / issuer URL.
   */
  issuerUrl: string;
  /**
   * The IdP's SSO target URL Access redirects sign-ins to.
   */
  ssoTargetUrl: string;
  /**
   * The IdP's public signing certificate(s), PEM bodies without the
   * BEGIN/END markers.
   */
  idpPublicCerts: string[];
  /**
   * The SAML attribute carrying the user's email address.
   */
  emailAttributeName?: string;
  /**
   * SAML attributes to capture and make available in Access policies.
   */
  attributes?: string[];
  /**
   * SAML attributes to translate into request headers on the origin.
   */
  headerAttributes?: SamlHeaderAttribute[];
  /**
   * Sign the SAML authentication request.
   */
  signRequest?: boolean;
}

/**
 * SCIM provisioning configuration for an identity provider.
 */
export interface IdentityProviderScimConfig {
  /**
   * Enable SCIM provisioning from the IdP into Cloudflare Access.
   * @default false
   */
  enabled?: boolean;
  /**
   * How user identity updates from SCIM affect existing Access sessions.
   */
  identityUpdateBehavior?: "automatic" | "reauth" | "no_action";
  /**
   * Deprovision a user's seat when SCIM deprovisions the user.
   * @default false
   */
  seatDeprovision?: boolean;
  /**
   * Revoke a user's session when SCIM deprovisions the user.
   * @default false
   */
  userDeprovision?: boolean;
}

/**
 * Props shared by every identity provider type.
 */
export interface IdentityProviderBaseProps {
  /**
   * Display name shown to users on the Access login page. Used as a
   * stable identifier so the provider can locate the IdP by name during
   * adoption / state recovery. If omitted, a unique name is generated
   * from the app, stage, and logical ID.
   *
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * Zone to scope the identity provider to (legacy zone-level Access).
   * When omitted, the IdP is created at the account level — the modern
   * Zero Trust organization scope.
   *
   * Stable — moving an IdP between scopes triggers a replacement.
   */
  zoneId?: string;
  /**
   * SCIM provisioning configuration. Mutable.
   */
  scimConfig?: IdentityProviderScimConfig;
}

/**
 * Input properties of an identity provider — a discriminated union on
 * `type`, so each provider type only accepts (and requires) its own
 * config fields. Secret fields (e.g. `clientSecret`) are masked by
 * Cloudflare on read, so they diff against the previously declared props
 * rather than observed cloud state.
 */
export type IdentityProviderProps = IdentityProviderBaseProps &
  (
    | {
        /** The identity provider type. Immutable — changing it triggers a replacement. */
        type: "onetimepin";
        /** One-time PIN takes no configuration. */
        config?: OneTimePinConfig;
      }
    | {
        /** The identity provider type. Immutable — changing it triggers a replacement. */
        type: "github" | "facebook" | "linkedin" | "yandex";
        /** OAuth client credentials for the social provider. */
        config: SocialOAuthConfig;
      }
    | {
        /** The identity provider type. Immutable — changing it triggers a replacement. */
        type: "google";
        /** Google OAuth configuration. */
        config: GoogleConfig;
      }
    | {
        /** The identity provider type. Immutable — changing it triggers a replacement. */
        type: "google-apps";
        /** Google Workspace configuration. */
        config: GoogleAppsConfig;
      }
    | {
        /** The identity provider type. Immutable — changing it triggers a replacement. */
        type: "azureAD";
        /** Microsoft Entra ID configuration. */
        config: AzureADConfig;
      }
    | {
        /** The identity provider type. Immutable — changing it triggers a replacement. */
        type: "centrify";
        /** Centrify configuration. */
        config: CentrifyConfig;
      }
    | {
        /** The identity provider type. Immutable — changing it triggers a replacement. */
        type: "okta";
        /** Okta configuration. */
        config: OktaConfig;
      }
    | {
        /** The identity provider type. Immutable — changing it triggers a replacement. */
        type: "onelogin";
        /** OneLogin configuration. */
        config: OneloginConfig;
      }
    | {
        /** The identity provider type. Immutable — changing it triggers a replacement. */
        type: "pingone";
        /** PingOne configuration. */
        config: PingoneConfig;
      }
    | {
        /** The identity provider type. Immutable — changing it triggers a replacement. */
        type: "oidc";
        /** Generic OIDC configuration. */
        config: OidcConfig;
      }
    | {
        /** The identity provider type. Immutable — changing it triggers a replacement. */
        type: "saml";
        /** Generic SAML configuration. */
        config: SamlConfig;
        /**
         * The UID of the SAML encryption certificate set assigned to
         * this identity provider. Only meaningful for SAML IdPs with
         * response encryption configured.
         */
        samlCertificateSetId?: string;
      }
    | {
        /** The identity provider type. Immutable — changing it triggers a replacement. */
        type: "cloudflare";
        /** The Cloudflare-managed (WARP) IdP takes no user configuration. */
        config?: IdentityProviderConfig;
      }
  );

export interface IdentityProviderAttributes {
  /** UUID of the identity provider, assigned by Cloudflare. */
  identityProviderId: string;
  /** Cloudflare account that owns the identity provider. */
  accountId: string;
  /** Zone the IdP is scoped to, or `undefined` for account-scoped IdPs. */
  zoneId: string | undefined;
  /** Display name of the identity provider. */
  name: string;
  /** The identity provider type. */
  type: IdentityProviderType;
  /** Server-generated SCIM base URL (when SCIM is enabled). */
  scimBaseUrl: string | undefined;
  /**
   * SCIM provisioning secret. Returned once when SCIM is first enabled
   * and carried forward in state afterwards (the API masks it on read).
   */
  scimSecret: Redacted.Redacted<string> | undefined;
  /** Whether SCIM provisioning is enabled. */
  scimEnabled: boolean;
}

export type IdentityProvider = Resource<
  TypeId,
  IdentityProviderProps,
  IdentityProviderAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare Zero Trust Access identity provider — the login method
 * (one-time PIN, generic OIDC/SAML, or a named provider like GitHub,
 * Google, Okta, or Azure AD) users authenticate with before Access
 * policies evaluate.
 *
 * Props are a discriminated union on `type`: each provider type only
 * accepts (and requires) its own config fields, so a missing
 * `directoryId` on an `azureAD` IdP or a GitHub config on an `oidc` IdP
 * is a compile-time error. The `type` is immutable (config shapes are
 * disjoint per type — changing it replaces the IdP); name, config, and
 * SCIM settings converge in place. Cloudflare masks secret config fields
 * (`clientSecret`, API tokens) on read, so those fields diff against
 * your previously declared props instead of observed cloud state.
 *
 * By default the IdP is created at the account level (the modern Zero
 * Trust organization scope); pass `zoneId` to scope it to a single zone
 * (legacy zone-level Access). Moving between scopes replaces the IdP.
 * ### Creating an Identity Provider
 * **Example:** One-time PIN (no external dependencies)
 * ```typescript
 * const otp = yield* Cloudflare.Access.IdentityProvider("Pin", {
 *   type: "onetimepin",
 * });
 * ```
 *
 * **Example:** Generic OIDC provider
 * ```typescript
 * const oidc = yield* Cloudflare.Access.IdentityProvider("Sso", {
 *   type: "oidc",
 *   config: {
 *     clientId: "my-client-id",
 *     clientSecret: "my-client-secret",
 *     authUrl: "https://idp.example.com/authorize",
 *     tokenUrl: "https://idp.example.com/token",
 *     certsUrl: "https://idp.example.com/keys",
 *     scopes: ["openid", "email", "profile"],
 *   },
 * });
 * ```
 *
 * **Example:** Microsoft Entra ID (Azure AD)
 * ```typescript
 * const entra = yield* Cloudflare.Access.IdentityProvider("Entra", {
 *   type: "azureAD",
 *   config: {
 *     clientId: "my-client-id",
 *     clientSecret: "my-client-secret",
 *     directoryId: "my-tenant-id",
 *     supportGroups: true,
 *   },
 * });
 * ```
 *
 * **Example:** Zone-scoped IdP (legacy zone-level Access)
 * ```typescript
 * const zoneIdp = yield* Cloudflare.Access.IdentityProvider("ZoneSso", {
 *   zoneId: zone.zoneId,
 *   type: "github",
 *   config: {
 *     clientId: "my-client-id",
 *     clientSecret: "my-client-secret",
 *   },
 * });
 * ```
 *
 * ### Restricting an Application to an IdP
 * **Example:** Allow only this IdP on an Access application
 * ```typescript
 * yield* Cloudflare.Access.Application("Admin", {
 *   domain: "admin.example.com",
 *   allowedIdps: [oidc.identityProviderId],
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/cloudflare-one/identity/idp-integration/
 *
 * @resource
 * @product Access
 * @category Cloudflare One (Zero Trust)
 */
export const IdentityProvider = Resource<IdentityProvider>(TypeId);

/**
 * Returns true if the given value is an IdentityProvider resource.
 */
export const isIdentityProvider = (value: unknown): value is IdentityProvider =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const IdentityProviderProvider = () =>
  Provider.succeed(IdentityProvider, {
    stables: ["identityProviderId", "accountId", "zoneId", "type"],

    diff: Effect.fn(function* ({ olds, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (!isResolved(news)) return undefined;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      // Config shapes are disjoint per type — model a type change as a
      // replacement even though the API technically allows the PUT.
      const oldType = output?.type ?? olds?.type;
      if (oldType !== undefined && oldType !== news.type) {
        return { action: "replace" } as const;
      }
      // Scope change (zone <-> account, or a different zone) replaces.
      if (output !== undefined || olds !== undefined) {
        const oldZone = output?.zoneId ?? olds?.zoneId;
        if ((oldZone === undefined) !== (news.zoneId === undefined)) {
          return { action: "replace" } as const;
        }
        // zoneId is Input<string>; compare only once both are concrete.
        if (
          typeof oldZone === "string" &&
          typeof news.zoneId === "string" &&
          oldZone !== news.zoneId
        ) {
          return { action: "replace" } as const;
        }
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      const zoneId = output?.zoneId ?? (olds?.zoneId as string | undefined);

      // Owned path — refresh by the cached id. Carry the SCIM secret
      // forward from prior output; the API never returns it on GET.
      if (output?.identityProviderId) {
        const observed = yield* getIdp(zoneId, acct, output.identityProviderId);
        if (observed) {
          return toAttributes(observed, zoneId, acct, output.scimSecret);
        }
      }

      // Cold read — locate by deterministic name. Access IdPs carry no
      // ownership markers, so report the match as Unowned to gate adoption.
      const name = yield* resolveName(id, olds?.name ?? output?.name);
      let match = yield* findByName(zoneId, acct, name);
      // The singleton types (`cloudflare`, `onetimepin`) exist at most once
      // per scope and their display name is user-irrelevant (the managed
      // WARP IdP's is often "") — locate them by type when the name scan
      // misses so adoption works regardless of the declared name.
      const type = olds?.type ?? output?.type;
      if (!match && isSingletonType(type)) {
        match = yield* findByType(zoneId, acct, type);
      }
      if (match) {
        return Unowned(toAttributes(match, zoneId, acct, output?.scimSecret));
      }
      return undefined;
    }),

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      // Account-scoped collection — exhaustively paginate the account's
      // identity providers and hydrate each into the `read` Attributes
      // shape. The SCIM secret is masked by the API on list, so it is
      // carried as undefined (there is no prior state to thread through).
      const accountIdps = yield* zeroTrust.listIdentityProvidersForAccount
        .pages({ accountId })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) =>
              (page.result ?? []).map((idp) =>
                toAttributes(
                  idp as unknown as ObservedIdp,
                  undefined,
                  accountId,
                  undefined,
                ),
              ),
            ),
          ),
        );

      // Zone-scoped IdPs (legacy zone-level Access) — fan out across the
      // account's zones. Zones without zone-level Access reject the
      // route; skip them.
      const zones = yield* listAllZones(accountId);
      const zoneGroups = yield* Effect.forEach(
        zones,
        (zone) =>
          zeroTrust.listIdentityProvidersForZone
            .pages({ zoneId: zone.id })
            .pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) =>
                  (page.result ?? []).map((idp) =>
                    toAttributes(
                      idp as unknown as ObservedIdp,
                      zone.id,
                      accountId,
                      undefined,
                    ),
                  ),
                ),
              ),
              Effect.catchTag("Forbidden", () => Effect.succeed([])),
            ),
        { concurrency: 10 },
      );

      // The zone route can echo account-level IdPs back — keep each IdP
      // once, under the scope that owns it.
      const seen = new Set(accountIdps.map((idp) => idp.identityProviderId));
      return [
        ...accountIdps,
        ...zoneGroups.flat().filter((idp) => !seen.has(idp.identityProviderId)),
      ];
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // A scope change replaces (see diff), so news' scope is the scope.
      const zoneId = news.zoneId as string | undefined;
      const generatedName = yield* createPhysicalName({ id });

      // 1. Observe — the cached id is a hint; fall back to a name scan
      //    (and, for the singleton types, a type scan) so out-of-band
      //    deletes / lost state converge.
      let observed = output?.identityProviderId
        ? yield* getIdp(zoneId, accountId, output.identityProviderId)
        : undefined;
      if (!observed) {
        observed = yield* findByName(
          zoneId,
          accountId,
          news.name ?? generatedName,
        );
      }
      // Singleton types (`cloudflare`, `onetimepin`) exist at most once per
      // scope — creating a second one is rejected by the API, so an
      // existing one found by type is ours to converge (ownership is gated
      // upstream: `read` reports it as Unowned and the engine only lets
      // reconcile run once adoption is approved).
      if (!observed && isSingletonType(news.type)) {
        observed = yield* findByType(zoneId, accountId, news.type);
      }

      // Singletons keep their observed display name when none is declared —
      // renaming the managed WARP IdP to a generated physical name on
      // adoption would be surprising. Everything else defaults to the
      // deterministic physical name (the resource's cold-read identity).
      const name =
        news.name ??
        (isSingletonType(news.type) && observed
          ? observed.name
          : generatedName);

      // 2. Ensure — create with the full desired body when missing. Names
      //    are not unique on Cloudflare's side, so there is no
      //    AlreadyExists race to tolerate for the non-singleton types (a
      //    singleton conflict is caught by the type scan above).
      if (!observed) {
        const created = yield* createIdp(zoneId, accountId, {
          name,
          type: news.type,
          config: news.config ?? {},
          scimConfig: news.scimConfig,
          samlCertificateSetId: samlCertificateSetIdOf(news),
        });
        return toAttributes(
          created as ObservedIdp,
          zoneId,
          accountId,
          output?.scimSecret,
        );
      }

      // 3. Sync — the update API is a PUT of the full desired state.
      //    Non-secret aspects (name, SCIM enablement) diff against
      //    observed cloud state; the config diffs against the previously
      //    declared props because Cloudflare masks secrets on read.
      const dirty =
        observed.name !== name ||
        JSON.stringify(news.config ?? {}) !==
          JSON.stringify(olds?.config ?? null) ||
        samlCertificateSetIdOf(news) !== samlCertificateSetIdOf(olds) ||
        (news.scimConfig !== undefined &&
          !sameScim(observed.scimConfig, news.scimConfig));
      if (dirty) {
        const updated = yield* updateIdp(zoneId, accountId, observed.id ?? "", {
          name,
          type: news.type,
          config: news.config ?? {},
          scimConfig: news.scimConfig,
          samlCertificateSetId: samlCertificateSetIdOf(news),
        });
        return toAttributes(
          updated as ObservedIdp,
          zoneId,
          accountId,
          output?.scimSecret,
        );
      }

      return toAttributes(observed, zoneId, accountId, output?.scimSecret);
    }),

    delete: Effect.fn(function* ({ output }) {
      // An IdP referenced by an application's `allowedIdps` can fail
      // deletion — applications referencing the id as an Input get correct
      // destroy ordering. A missing IdP (AccessIdentityProviderNotFound,
      // Cloudflare code 12135) means we're done.
      yield* deleteIdp(
        output.zoneId,
        output.accountId,
        output.identityProviderId,
      ).pipe(
        Effect.catchTag("AccessIdentityProviderNotFound", () => Effect.void),
      );
    }),
  });

/**
 * The request body shared by the scoped create/update helpers.
 */
interface IdpBody {
  readonly name: string;
  readonly type: IdentityProviderType;
  readonly config: IdentityProviderConfig;
  readonly scimConfig: IdentityProviderScimConfig | undefined;
  readonly samlCertificateSetId: string | undefined;
}

/**
 * The SAML encryption certificate set, when the props are the `saml`
 * variant. Narrowing helper — `samlCertificateSetId` only exists on the
 * SAML member of the props union.
 */
const samlCertificateSetIdOf = (
  props: IdentityProviderProps | undefined,
): string | undefined =>
  props?.type === "saml" ? props.samlCertificateSetId : undefined;

const createIdp = (
  zoneId: string | undefined,
  accountId: string,
  body: IdpBody,
) =>
  zoneId !== undefined
    ? zeroTrust.createIdentityProviderForZone({ zoneId, ...body })
    : zeroTrust.createIdentityProviderForAccount({ accountId, ...body });

const updateIdp = (
  zoneId: string | undefined,
  accountId: string,
  identityProviderId: string,
  body: IdpBody,
) =>
  zoneId !== undefined
    ? zeroTrust.updateIdentityProviderForZone({
        zoneId,
        identityProviderId,
        ...body,
      })
    : zeroTrust.updateIdentityProviderForAccount({
        accountId,
        identityProviderId,
        ...body,
      });

const deleteIdp = (
  zoneId: string | undefined,
  accountId: string,
  identityProviderId: string,
) =>
  zoneId !== undefined
    ? zeroTrust.deleteIdentityProviderForZone({ zoneId, identityProviderId })
    : zeroTrust.deleteIdentityProviderForAccount({
        accountId,
        identityProviderId,
      });

const resolveName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    // `""` is a legitimate declared name (the managed `cloudflare` IdP's
    // display name is empty) — only generate when no name was declared.
    if (name !== undefined) return name;
    return yield* createPhysicalName({ id });
  });

const sameScim = (
  observed: ObservedIdp["scimConfig"],
  desired: IdentityProviderScimConfig,
): boolean => {
  const o = observed ?? {};
  const sameBool = (a: boolean | null | undefined, b: boolean | undefined) =>
    b === undefined || (a ?? false) === b;
  return (
    sameBool(o.enabled, desired.enabled) &&
    sameBool(o.seatDeprovision, desired.seatDeprovision) &&
    sameBool(o.userDeprovision, desired.userDeprovision) &&
    (desired.identityUpdateBehavior === undefined ||
      (o.identityUpdateBehavior ?? "no_action") ===
        desired.identityUpdateBehavior)
  );
};
