import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

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
  | (string & {});

/**
 * Per-type configuration of an identity provider. Re-exports distilled's
 * request shape so the full Cloudflare config surface (OAuth client
 * credentials, OIDC endpoints, SAML certs and SSO targets, SCIM claims,
 * …) is available without re-declaring the structure. Which fields apply
 * depends on `type` — `onetimepin` takes an empty `{}`.
 */
export type IdentityProviderConfig =
  zeroTrust.CreateIdentityProviderForAccountRequest["config"];

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

export interface IdentityProviderProps {
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
   * The identity provider type. Immutable — config shapes are disjoint
   * per type, so changing it triggers a replacement.
   */
  type: IdentityProviderType;
  /**
   * Per-type configuration (client credentials, endpoints, certificates).
   * Pass `{}` for `onetimepin`. Secret fields (e.g. `clientSecret`) are
   * masked by Cloudflare on read, so they diff against the previously
   * declared props rather than observed cloud state. Mutable.
   */
  config: IdentityProviderConfig;
  /**
   * SCIM provisioning configuration. Mutable.
   */
  scimConfig?: IdentityProviderScimConfig;
}

export interface IdentityProviderAttributes {
  /** UUID of the identity provider, assigned by Cloudflare. */
  identityProviderId: string;
  /** Cloudflare account that owns the identity provider. */
  accountId: string;
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
 * The `type` is immutable (config shapes are disjoint per type — changing
 * it replaces the IdP); name, config, and SCIM settings converge in
 * place. Cloudflare masks secret config fields (`clientSecret`, API
 * tokens) on read, so those fields diff against your previously declared
 * props instead of observed cloud state.
 * @resource
 * @product Access
 * @category Cloudflare One (Zero Trust)
 * @section Creating an Identity Provider
 * @example One-time PIN (no external dependencies)
 * ```typescript
 * const otp = yield* Cloudflare.Access.IdentityProvider("Pin", {
 *   type: "onetimepin",
 *   config: {},
 * });
 * ```
 *
 * @example Generic OIDC provider
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
 * @section Restricting an Application to an IdP
 * @example Allow only this IdP on an Access application
 * ```typescript
 * yield* Cloudflare.Access.Application("Admin", {
 *   domain: "admin.example.com",
 *   allowedIdps: [oidc.identityProviderId],
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/cloudflare-one/identity/idp-integration/
 */
export const IdentityProvider = Resource<IdentityProvider>(TypeId);

/**
 * Returns true if the given value is an IdentityProvider resource.
 */
export const isIdentityProvider = (value: unknown): value is IdentityProvider =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const IdentityProviderProvider = () =>
  Provider.succeed(IdentityProvider, {
    stables: ["identityProviderId", "accountId", "type"],

    diff: Effect.fn(function* ({ olds = {}, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (!isResolved(news)) return undefined;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      // Config shapes are disjoint per type — model a type change as a
      // replacement even though the API technically allows the PUT.
      const oldType = output?.type ?? (olds as IdentityProviderProps).type;
      if (oldType !== undefined && oldType !== news.type) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      // Owned path — refresh by the cached id. Carry the SCIM secret
      // forward from prior output; the API never returns it on GET.
      if (output?.identityProviderId) {
        const observed = yield* getIdp(acct, output.identityProviderId);
        if (observed) return toAttributes(observed, acct, output.scimSecret);
      }

      // Cold read — locate by deterministic name. Access IdPs carry no
      // ownership markers, so report the match as Unowned to gate adoption.
      const name = yield* resolveName(id, olds?.name ?? output?.name);
      const match = yield* findByName(acct, name);
      if (match) return Unowned(toAttributes(match, acct, output?.scimSecret));
      return undefined;
    }),

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Account-scoped collection — exhaustively paginate the account's
      // identity providers and hydrate each into the `read` Attributes
      // shape. The SCIM secret is masked by the API on list, so it is
      // carried as undefined (there is no prior state to thread through).
      return yield* zeroTrust.listIdentityProvidersForAccount
        .pages({ accountId })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) =>
              (page.result ?? []).map((idp) =>
                toAttributes(
                  idp as unknown as ObservedIdp,
                  accountId,
                  undefined,
                ),
              ),
            ),
          ),
        );
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name = yield* resolveName(id, news.name);

      // 1. Observe — the cached id is a hint; fall back to a name scan so
      //    out-of-band deletes / lost state converge.
      let observed = output?.identityProviderId
        ? yield* getIdp(accountId, output.identityProviderId)
        : undefined;
      if (!observed) {
        observed = yield* findByName(accountId, name);
      }

      // 2. Ensure — create with the full desired body when missing. Names
      //    are not unique on Cloudflare's side, so there is no
      //    AlreadyExists race to tolerate (except `onetimepin`, of which
      //    only one may exist — that conflict propagates as a clear API
      //    error rather than being silently adopted).
      if (!observed) {
        const created = yield* zeroTrust.createIdentityProviderForAccount({
          accountId,
          name,
          type: news.type,
          config: news.config,
          scimConfig: news.scimConfig,
        });
        return toAttributes(
          created as ObservedIdp,
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
        JSON.stringify(news.config) !== JSON.stringify(olds?.config ?? null) ||
        (news.scimConfig !== undefined &&
          !sameScim(observed.scimConfig, news.scimConfig));
      if (dirty) {
        const updated = yield* zeroTrust.updateIdentityProviderForAccount({
          accountId,
          identityProviderId: observed.id ?? "",
          name,
          type: news.type,
          config: news.config,
          scimConfig: news.scimConfig,
        });
        return toAttributes(
          updated as ObservedIdp,
          accountId,
          output?.scimSecret,
        );
      }

      return toAttributes(observed, accountId, output?.scimSecret);
    }),

    delete: Effect.fn(function* ({ output }) {
      // An IdP referenced by an application's `allowedIdps` can fail
      // deletion — applications referencing the id as an Input get correct
      // destroy ordering. A missing IdP (AccessIdentityProviderNotFound,
      // Cloudflare code 12135) means we're done.
      yield* zeroTrust
        .deleteIdentityProviderForAccount({
          accountId: output.accountId,
          identityProviderId: output.identityProviderId,
        })
        .pipe(
          Effect.catchTag("AccessIdentityProviderNotFound", () => Effect.void),
        );
    }),
  });

interface ObservedIdp {
  readonly id?: string | null;
  readonly name: string;
  readonly type: string;
  readonly scimConfig?: {
    readonly enabled?: boolean | null;
    readonly identityUpdateBehavior?: string | null;
    readonly scimBaseUrl?: string | null;
    readonly seatDeprovision?: boolean | null;
    readonly secret?: string | null;
    readonly userDeprovision?: boolean | null;
  } | null;
}

/**
 * Read an identity provider by id, mapping "gone"
 * (`AccessIdentityProviderNotFound`, Cloudflare error code 12135 —
 * `access.api.error.not_found`) to `undefined`.
 */
const getIdp = (accountId: string, identityProviderId: string) =>
  zeroTrust
    .getIdentityProviderForAccount({ accountId, identityProviderId })
    .pipe(
      Effect.map((idp): ObservedIdp | undefined => idp as ObservedIdp),
      Effect.catchTag("AccessIdentityProviderNotFound", () =>
        Effect.succeed(undefined),
      ),
    );

/**
 * Find an identity provider by exact name. Names are not unique on
 * Cloudflare's side; pick the first match.
 */
const findByName = (accountId: string, name: string) =>
  zeroTrust.listIdentityProvidersForAccount.items({ accountId }).pipe(
    Stream.filter((idp) => idp.name === name),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
    Effect.map(
      (idp): ObservedIdp | undefined => idp as ObservedIdp | undefined,
    ),
  );

const resolveName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    if (name) return name;
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

const toAttributes = (
  idp: ObservedIdp,
  accountId: string,
  priorSecret: Redacted.Redacted<string> | undefined,
): IdentityProviderAttributes => ({
  identityProviderId: idp.id ?? "",
  accountId,
  name: idp.name,
  type: idp.type as IdentityProviderType,
  scimBaseUrl: idp.scimConfig?.scimBaseUrl ?? undefined,
  // The SCIM secret is returned once when SCIM is enabled; afterwards the
  // API masks it — carry the prior value forward.
  scimSecret: idp.scimConfig?.secret
    ? Redacted.make(idp.scimConfig.secret)
    : priorSecret,
  scimEnabled: idp.scimConfig?.enabled ?? false,
});
