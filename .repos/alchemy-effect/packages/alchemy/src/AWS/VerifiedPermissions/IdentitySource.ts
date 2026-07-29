import * as avp from "@distilled.cloud/aws/verifiedpermissions";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

const unwrap = (v: string | Redacted.Redacted<string> | undefined) =>
  v === undefined ? undefined : Redacted.isRedacted(v) ? Redacted.value(v) : v;

const unwrapAll = (
  vs: readonly (string | Redacted.Redacted<string>)[] | undefined,
) => (vs === undefined ? undefined : vs.map((v) => unwrap(v)!));

/** Sorted copy, with empty/absent arrays collapsing to `undefined`. */
const sortedOrUndefined = (vs: readonly string[] | undefined) =>
  vs === undefined || vs.length === 0 ? undefined : [...vs].sort();

/**
 * Identity-source configuration backed by an Amazon Cognito user pool.
 */
export interface CognitoUserPoolConfiguration {
  /**
   * ARN of the Cognito user pool whose identities should be usable as
   * principals in authorization requests.
   */
  userPoolArn: string;
  /**
   * The user pool app client IDs to accept tokens from. When omitted, tokens
   * from any of the pool's app clients are accepted.
   */
  clientIds?: string[];
  /**
   * The Cedar entity type to map Cognito groups to (e.g.
   * `PhotoApp::UserGroup`). Enables group claims in policies.
   */
  groupEntityType?: string;
}

/**
 * Identity-source configuration backed by a generic OpenID Connect (OIDC)
 * identity provider.
 */
export interface OpenIdConnectConfiguration {
  /**
   * The issuer URL of the OIDC provider, e.g. `https://accounts.google.com`.
   * Verified Permissions fetches `/.well-known/openid-configuration` from
   * this URL at creation time.
   */
  issuer: string;
  /**
   * A prefix prepended to the user ID taken from the token, producing entity
   * IDs like `MyOIDCProvider|user-id`.
   */
  entityIdPrefix?: string;
  /**
   * Map a token group claim onto a Cedar entity type so policies can match
   * on group membership.
   */
  groupConfiguration?: {
    /** The token claim that lists the user's groups, e.g. `groups`. */
    groupClaim: string;
    /** The Cedar entity type groups map to, e.g. `PhotoApp::UserGroup`. */
    groupEntityType: string;
  };
  /**
   * Which token type the identity source consumes — exactly one of
   * `accessTokenOnly` or `identityTokenOnly`.
   */
  tokenSelection:
    | {
        /** Consume OIDC access tokens. */
        accessTokenOnly: {
          /** The claim to derive the principal entity ID from. @default "sub" */
          principalIdClaim?: string;
          /** The `aud` values to accept tokens for. */
          audiences?: string[];
        };
        identityTokenOnly?: never;
      }
    | {
        accessTokenOnly?: never;
        /** Consume OIDC identity (ID) tokens. */
        identityTokenOnly: {
          /** The claim to derive the principal entity ID from. @default "sub" */
          principalIdClaim?: string;
          /** The client IDs (`aud`) to accept tokens for. */
          clientIds?: string[];
        };
      };
}

/**
 * Exactly one of a Cognito user pool or an OIDC provider configuration.
 */
export type IdentitySourceConfiguration =
  | {
      /** Use an Amazon Cognito user pool as the identity provider. */
      cognito: CognitoUserPoolConfiguration;
      openIdConnect?: never;
    }
  | {
      cognito?: never;
      /** Use a generic OpenID Connect provider as the identity provider. */
      openIdConnect: OpenIdConnectConfiguration;
    };

export type IdentitySourceProps = IdentitySourceConfiguration & {
  /**
   * The ID of the policy store the identity source belongs to. Changing the
   * store replaces the identity source.
   */
  policyStoreId: string;
  /**
   * The Cedar entity type that tokens from this identity source map to, e.g.
   * `PhotoApp::User`. Mutable via `UpdateIdentitySource`.
   */
  principalEntityType?: string;
};

export interface IdentitySource extends Resource<
  "AWS.VerifiedPermissions.IdentitySource",
  IdentitySourceProps,
  {
    /**
     * ID of the policy store the identity source belongs to.
     */
    policyStoreId: string;
    /**
     * Service-assigned unique ID of the identity source within the store.
     */
    identitySourceId: string;
  },
  {},
  Providers
> {}

/**
 * An identity source connects a Verified Permissions policy store to an
 * identity provider — an Amazon Cognito user pool or any OpenID Connect
 * (OIDC) IdP — so that `IsAuthorizedWithToken` and
 * `BatchIsAuthorizedWithToken` can derive the principal directly from a JWT.
 * @resource
 * @section Connecting an Identity Provider
 * @example Cognito User Pool
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const store = yield* AWS.VerifiedPermissions.PolicyStore("Store", {});
 *
 * yield* AWS.VerifiedPermissions.IdentitySource("Users", {
 *   policyStoreId: store.policyStoreId,
 *   principalEntityType: "PhotoApp::User",
 *   cognito: {
 *     userPoolArn: userPool.userPoolArn,
 *   },
 * });
 * ```
 *
 * @example OpenID Connect Provider
 * ```typescript
 * yield* AWS.VerifiedPermissions.IdentitySource("Oidc", {
 *   policyStoreId: store.policyStoreId,
 *   principalEntityType: "PhotoApp::User",
 *   openIdConnect: {
 *     issuer: "https://accounts.google.com",
 *     tokenSelection: {
 *       identityTokenOnly: { clientIds: ["my-oauth-client-id"] },
 *     },
 *   },
 * });
 * ```
 */
export const IdentitySource = Resource<IdentitySource>(
  "AWS.VerifiedPermissions.IdentitySource",
);

/** Desired props → the wire `Configuration` union. */
const toConfiguration = (news: IdentitySourceProps): avp.Configuration =>
  news.cognito !== undefined
    ? {
        cognitoUserPoolConfiguration: {
          userPoolArn: news.cognito.userPoolArn,
          clientIds: news.cognito.clientIds,
          groupConfiguration:
            news.cognito.groupEntityType === undefined
              ? undefined
              : { groupEntityType: news.cognito.groupEntityType },
        },
      }
    : {
        openIdConnectConfiguration: {
          issuer: news.openIdConnect.issuer,
          entityIdPrefix: news.openIdConnect.entityIdPrefix,
          groupConfiguration: news.openIdConnect.groupConfiguration,
          tokenSelection: news.openIdConnect.tokenSelection,
        },
      };

/**
 * Observed `ConfigurationDetail` → the plain props shape, for diffing the
 * desired configuration against what is actually deployed.
 */
const toObservedConfiguration = (
  detail: avp.ConfigurationDetail | undefined,
): IdentitySourceConfiguration | undefined => {
  if (detail === undefined) return undefined;
  if (detail.cognitoUserPoolConfiguration !== undefined) {
    const cognito = detail.cognitoUserPoolConfiguration;
    return {
      cognito: {
        userPoolArn: cognito.userPoolArn,
        clientIds: unwrapAll(cognito.clientIds),
        groupEntityType: unwrap(cognito.groupConfiguration?.groupEntityType),
      },
    };
  }
  const oidc = detail.openIdConnectConfiguration;
  return {
    openIdConnect: {
      issuer: oidc.issuer,
      entityIdPrefix: unwrap(oidc.entityIdPrefix),
      groupConfiguration:
        oidc.groupConfiguration === undefined
          ? undefined
          : {
              groupClaim: unwrap(oidc.groupConfiguration.groupClaim)!,
              groupEntityType: unwrap(oidc.groupConfiguration.groupEntityType)!,
            },
      tokenSelection:
        oidc.tokenSelection.accessTokenOnly !== undefined
          ? {
              accessTokenOnly: {
                principalIdClaim: unwrap(
                  oidc.tokenSelection.accessTokenOnly.principalIdClaim,
                ),
                audiences: oidc.tokenSelection.accessTokenOnly.audiences
                  ? [...oidc.tokenSelection.accessTokenOnly.audiences]
                  : undefined,
              },
            }
          : {
              identityTokenOnly: {
                principalIdClaim: unwrap(
                  oidc.tokenSelection.identityTokenOnly.principalIdClaim,
                ),
                clientIds: unwrapAll(
                  oidc.tokenSelection.identityTokenOnly.clientIds,
                ),
              },
            },
    },
  };
};

/**
 * Canonicalize + serialize a configuration for drift comparison: arrays are
 * sorted (empty ≡ absent) and AWS-filled defaults (`principalIdClaim: "sub"`)
 * are applied so an untouched deploy is a no-op.
 */
const normalize = (config: IdentitySourceConfiguration): string => {
  const canonical =
    config.cognito !== undefined
      ? {
          cognito: {
            userPoolArn: config.cognito.userPoolArn,
            clientIds: sortedOrUndefined(config.cognito.clientIds),
            groupEntityType: config.cognito.groupEntityType,
          },
        }
      : {
          openIdConnect: {
            issuer: config.openIdConnect.issuer,
            entityIdPrefix: config.openIdConnect.entityIdPrefix,
            groupConfiguration: config.openIdConnect.groupConfiguration,
            tokenSelection:
              config.openIdConnect.tokenSelection.accessTokenOnly !== undefined
                ? {
                    accessTokenOnly: {
                      principalIdClaim:
                        config.openIdConnect.tokenSelection.accessTokenOnly
                          .principalIdClaim ?? "sub",
                      audiences: sortedOrUndefined(
                        config.openIdConnect.tokenSelection.accessTokenOnly
                          .audiences,
                      ),
                    },
                  }
                : {
                    identityTokenOnly: {
                      principalIdClaim:
                        config.openIdConnect.tokenSelection.identityTokenOnly
                          .principalIdClaim ?? "sub",
                      clientIds: sortedOrUndefined(
                        config.openIdConnect.tokenSelection.identityTokenOnly
                          .clientIds,
                      ),
                    },
                  },
          },
        };
  return JSON.stringify(canonical);
};

/** Desired props → the wire `UpdateConfiguration` union (same field shapes). */
const toUpdateConfiguration = (
  news: IdentitySourceProps,
): avp.UpdateConfiguration => toConfiguration(news) as avp.UpdateConfiguration;

export const IdentitySourceProvider = () =>
  Provider.effect(
    IdentitySource,
    Effect.gen(function* () {
      const observe = Effect.fn(function* (
        policyStoreId: string,
        identitySourceId: string,
      ) {
        return yield* avp
          .getIdentitySource({ policyStoreId, identitySourceId })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      return IdentitySource.Provider.of({
        stables: ["policyStoreId", "identitySourceId"],

        // child of a policy store — not enumerable account-wide
        list: () => Effect.succeed([]),

        read: Effect.fn(function* ({ olds, output }) {
          const policyStoreId = output?.policyStoreId ?? olds?.policyStoreId;
          const identitySourceId = output?.identitySourceId;
          if (policyStoreId === undefined || identitySourceId === undefined) {
            return undefined;
          }
          const source = yield* observe(policyStoreId, identitySourceId);
          if (source === undefined) return undefined;
          return { policyStoreId, identitySourceId: source.identitySourceId };
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (olds.policyStoreId !== news.policyStoreId) {
            return { action: "replace" } as const;
          }
          // configuration + principalEntityType are mutable via
          // updateIdentitySource → default update path
        }),

        reconcile: Effect.fn(function* ({ news, output, session }) {
          // 1. OBSERVE — cloud state is authoritative
          const existing =
            output?.identitySourceId !== undefined
              ? yield* observe(news.policyStoreId, output.identitySourceId)
              : undefined;

          // 2. ENSURE — a freshly created policy store is eventually
          // consistent; createIdentitySource can briefly 404 on it
          if (existing === undefined) {
            const created = yield* avp
              .createIdentitySource({
                policyStoreId: news.policyStoreId,
                configuration: toConfiguration(news),
                principalEntityType: news.principalEntityType,
              })
              .pipe(
                Effect.retry({
                  while: (e): boolean => e._tag === "ResourceNotFoundException",
                  schedule: Schedule.max([
                    Schedule.exponential("1 second"),
                    Schedule.recurs(5),
                  ]),
                }),
              );
            yield* session.note(created.identitySourceId);
            return {
              policyStoreId: news.policyStoreId,
              identitySourceId: created.identitySourceId,
            };
          }

          // 3. SYNC — diff observed configuration/principal type vs desired
          const desired = normalize(
            news.cognito !== undefined
              ? { cognito: news.cognito }
              : { openIdConnect: news.openIdConnect },
          );
          // If the response carries no configuration detail, we can't prove
          // convergence — treat it as drift and (re)apply the desired config.
          const observedConfiguration = toObservedConfiguration(
            existing.configuration,
          );
          const observed =
            observedConfiguration === undefined
              ? undefined
              : normalize(observedConfiguration);
          const observedPrincipalType = unwrap(existing.principalEntityType);
          const principalDrift =
            news.principalEntityType !== undefined &&
            observedPrincipalType !== news.principalEntityType;
          if (desired !== observed || principalDrift) {
            yield* avp.updateIdentitySource({
              policyStoreId: news.policyStoreId,
              identitySourceId: existing.identitySourceId,
              updateConfiguration: toUpdateConfiguration(news),
              principalEntityType: news.principalEntityType,
            });
          }

          yield* session.note(existing.identitySourceId);
          return {
            policyStoreId: news.policyStoreId,
            identitySourceId: existing.identitySourceId,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* avp
            .deleteIdentitySource({
              policyStoreId: output.policyStoreId,
              identitySourceId: output.identitySourceId,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      });
    }),
  );
