import * as ci from "@distilled.cloud/aws/cognito-identity";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

/** A Cognito user pool provider entry for an identity pool. */
export interface IdentityPoolCognitoProvider {
  /**
   * The user pool provider name:
   * `cognito-idp.<region>.amazonaws.com/<userPoolId>`.
   */
  providerName: string;
  /** The app client ID allowed to exchange tokens. */
  clientId: string;
  /**
   * Whether Cognito checks with the user pool that the token was not
   * globally signed out.
   * @default false
   */
  serverSideTokenCheck?: boolean;
}

export interface IdentityPoolProps {
  /**
   * Name of the identity pool. If omitted, a deterministic physical name is
   * generated from the app, stage, and logical ID. Mutable in place.
   */
  identityPoolName?: string;
  /**
   * Whether the pool vends credentials to unauthenticated (guest)
   * identities.
   * @default false
   */
  allowUnauthenticatedIdentities?: boolean;
  /**
   * Enables the legacy basic (classic) credentials flow.
   * @default false
   */
  allowClassicFlow?: boolean;
  /**
   * Social login providers keyed by their domain, e.g.
   * `{ "accounts.google.com": "<client-id>" }`.
   */
  supportedLoginProviders?: Record<string, string>;
  /**
   * Domain for developer-authenticated identities. Letters, digits, periods,
   * underscores, and dashes.
   */
  developerProviderName?: string;
  /**
   * ARNs of IAM OpenID Connect providers this pool trusts.
   */
  openIdConnectProviderArns?: string[];
  /**
   * Cognito user pools this identity pool federates.
   */
  cognitoIdentityProviders?: IdentityPoolCognitoProvider[];
  /**
   * ARNs of IAM SAML providers this pool trusts.
   */
  samlProviderArns?: string[];
  /**
   * Tags to apply to the identity pool. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface IdentityPool extends Resource<
  "AWS.Cognito.IdentityPool",
  IdentityPoolProps,
  {
    /** The generated identity pool ID, e.g. `us-west-2:xxxx-...`. */
    identityPoolId: string;
    /** The ARN of the identity pool. */
    identityPoolArn: string;
    /** The name of the identity pool. */
    identityPoolName: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon Cognito identity pool (federated identities) — exchanges tokens
 * from user pools, social providers, OIDC/SAML IdPs, or developer backends
 * for temporary AWS credentials.
 * @resource
 * @section Creating an Identity Pool
 * @example Identity Pool Federating a User Pool
 * ```typescript
 * import * as Cognito from "alchemy/AWS/Cognito";
 * import * as Output from "alchemy/Output";
 *
 * const pool = yield* Cognito.UserPool("Users", {});
 * const client = yield* Cognito.UserPoolClient("Web", {
 *   userPoolId: pool.userPoolId,
 * });
 * const identities = yield* Cognito.IdentityPool("Identities", {
 *   cognitoIdentityProviders: [
 *     {
 *       providerName: Output.interpolate`cognito-idp.us-west-2.amazonaws.com/${pool.userPoolId}`,
 *       clientId: client.clientId,
 *     },
 *   ],
 * });
 * ```
 *
 * @example Guest (Unauthenticated) Access
 * ```typescript
 * const identities = yield* Cognito.IdentityPool("Identities", {
 *   allowUnauthenticatedIdentities: true,
 * });
 * ```
 *
 * @section Roles
 * @example Attach Authenticated/Unauthenticated Roles
 * ```typescript
 * yield* Cognito.IdentityPoolRoleAttachment("Roles", {
 *   identityPoolId: identities.identityPoolId,
 *   roles: { authenticated: role.roleArn },
 * });
 * ```
 */
export const IdentityPool = Resource<IdentityPool>("AWS.Cognito.IdentityPool");

const tagRecordOf = (
  tags: { [key: string]: string | undefined } | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(tags ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

const identityPoolArnOf = (region: string, accountId: string, id: string) =>
  `arn:aws:cognito-identity:${region}:${accountId}:identitypool/${id}`;

/** The full desired wire configuration (update resets omitted fields). */
const desiredConfig = (name: string, news: IdentityPoolProps) => ({
  IdentityPoolName: name,
  AllowUnauthenticatedIdentities: news.allowUnauthenticatedIdentities ?? false,
  AllowClassicFlow: news.allowClassicFlow,
  SupportedLoginProviders: news.supportedLoginProviders,
  DeveloperProviderName: news.developerProviderName,
  OpenIdConnectProviderARNs: news.openIdConnectProviderArns,
  CognitoIdentityProviders: news.cognitoIdentityProviders?.map((p) => ({
    ProviderName: p.providerName,
    ClientId: p.clientId,
    ServerSideTokenCheck: p.serverSideTokenCheck,
  })),
  SamlProviderARNs: news.samlProviderArns,
});

const canonical = (value: unknown) =>
  JSON.stringify(value, (_, v) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .filter(([, x]) => x !== undefined)
            .sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );

const hasDrift = (
  name: string,
  news: IdentityPoolProps,
  observed: ci.IdentityPool,
) => {
  const desired = desiredConfig(name, news);
  const observedSubset = {
    IdentityPoolName: observed.IdentityPoolName,
    AllowUnauthenticatedIdentities: observed.AllowUnauthenticatedIdentities,
    AllowClassicFlow:
      desired.AllowClassicFlow === undefined
        ? undefined
        : (observed.AllowClassicFlow ?? false),
    SupportedLoginProviders:
      desired.SupportedLoginProviders === undefined
        ? undefined
        : tagRecordOf(observed.SupportedLoginProviders),
    DeveloperProviderName:
      desired.DeveloperProviderName === undefined
        ? undefined
        : observed.DeveloperProviderName,
    OpenIdConnectProviderARNs:
      desired.OpenIdConnectProviderARNs === undefined
        ? undefined
        : (observed.OpenIdConnectProviderARNs ?? []),
    CognitoIdentityProviders:
      desired.CognitoIdentityProviders === undefined
        ? undefined
        : (observed.CognitoIdentityProviders ?? []).map((p) => ({
            ProviderName: p.ProviderName,
            ClientId: p.ClientId,
            ServerSideTokenCheck: p.ServerSideTokenCheck ?? undefined,
          })),
    SamlProviderARNs:
      desired.SamlProviderARNs === undefined
        ? undefined
        : (observed.SamlProviderARNs ?? []),
  };
  const normalizedDesired = {
    ...desired,
    CognitoIdentityProviders: desired.CognitoIdentityProviders?.map((p) => ({
      ...p,
      ServerSideTokenCheck: p.ServerSideTokenCheck ?? false,
    })),
  };
  const normalizedObserved = {
    ...observedSubset,
    CognitoIdentityProviders: observedSubset.CognitoIdentityProviders?.map(
      (p) => ({
        ...p,
        ServerSideTokenCheck: p.ServerSideTokenCheck ?? false,
      }),
    ),
  };
  return canonical(normalizedDesired) !== canonical(normalizedObserved);
};

export const IdentityPoolProvider = () =>
  Provider.effect(
    IdentityPool,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: Pick<IdentityPoolProps, "identityPoolName">,
      ) {
        return (
          props.identityPoolName ??
          (yield* createPhysicalName({ id, maxLength: 128 }))
        );
      });

      const describePool = Effect.fn(function* (identityPoolId: string) {
        return yield* ci
          .describeIdentityPool({ IdentityPoolId: identityPoolId })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      const findPoolsByName = Effect.fn(function* (name: string) {
        const pages = yield* ci.listIdentityPools
          .pages({ MaxResults: 60 })
          .pipe(Stream.runCollect);
        const candidates = Array.from(pages)
          .flatMap((page) => page.IdentityPools ?? [])
          .filter(
            (pool) =>
              pool.IdentityPoolName === name &&
              pool.IdentityPoolId !== undefined,
          );
        return yield* Effect.forEach(
          candidates,
          (candidate) => describePool(candidate.IdentityPoolId!),
          { concurrency: 3 },
        ).pipe(Effect.map((pools) => pools.filter((p) => p !== undefined)));
      });

      return IdentityPool.Provider.of({
        stables: ["identityPoolId", "identityPoolArn"],

        list: () =>
          Effect.gen(function* () {
            const { accountId, region } = yield* AWSEnvironment.current;
            const pages = yield* ci.listIdentityPools
              .pages({ MaxResults: 60 })
              .pipe(Stream.runCollect);
            return Array.from(pages)
              .flatMap((page) => page.IdentityPools ?? [])
              .filter((pool) => pool.IdentityPoolId !== undefined)
              .map((pool) => ({
                identityPoolId: pool.IdentityPoolId!,
                identityPoolArn: identityPoolArnOf(
                  region,
                  accountId,
                  pool.IdentityPoolId!,
                ),
                identityPoolName: pool.IdentityPoolName ?? "",
              }));
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const attributesOf = (pool: ci.IdentityPool) => ({
            identityPoolId: pool.IdentityPoolId,
            identityPoolArn: identityPoolArnOf(
              region,
              accountId,
              pool.IdentityPoolId,
            ),
            identityPoolName: pool.IdentityPoolName,
          });
          if (output?.identityPoolId !== undefined) {
            const pool = yield* describePool(output.identityPoolId);
            if (pool === undefined) return undefined;
            const attrs = attributesOf(pool);
            const tags = tagRecordOf(pool.IdentityPoolTags);
            return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
          }
          const name = yield* createName(id, olds ?? {});
          const pools = yield* findPoolsByName(name);
          if (pools.length === 0) return undefined;
          for (const pool of pools) {
            if (yield* hasAlchemyTags(id, tagRecordOf(pool.IdentityPoolTags))) {
              return attributesOf(pool);
            }
          }
          return Unowned(attributesOf(pools[0]!));
        }),

        reconcile: Effect.fn(function* ({ id, news = {}, output, session }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const name = yield* createName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE — the id in output is only a cache.
          let observed =
            output?.identityPoolId !== undefined
              ? yield* describePool(output.identityPoolId)
              : undefined;
          if (observed === undefined) {
            const candidates = yield* findPoolsByName(name);
            for (const candidate of candidates) {
              if (
                yield* hasAlchemyTags(
                  id,
                  tagRecordOf(candidate.IdentityPoolTags),
                )
              ) {
                observed = candidate;
                break;
              }
            }
          }

          // 2. ENSURE
          if (observed === undefined) {
            observed = yield* ci.createIdentityPool({
              ...desiredConfig(name, news),
              IdentityPoolTags: desiredTags,
            });
          } else if (hasDrift(name, news, observed)) {
            // 3. SYNC — UpdateIdentityPool resets omitted fields to their
            //    defaults, so send the full desired configuration.
            observed = yield* ci.updateIdentityPool({
              IdentityPoolId: observed.IdentityPoolId,
              ...desiredConfig(name, news),
            });
          }

          const identityPoolId = observed.IdentityPoolId;
          const identityPoolArn = identityPoolArnOf(
            region,
            accountId,
            identityPoolId,
          );

          // 3b. SYNC TAGS against OBSERVED cloud tags.
          const observedTags = yield* ci
            .listTagsForResource({ ResourceArn: identityPoolArn })
            .pipe(
              Effect.map((r) => tagRecordOf(r.Tags)),
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed({} as Record<string, string>),
              ),
            );
          const { upsert, removed } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* ci.tagResource({
              ResourceArn: identityPoolArn,
              Tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
            });
          }
          if (removed.length > 0) {
            yield* ci.untagResource({
              ResourceArn: identityPoolArn,
              TagKeys: removed,
            });
          }

          yield* session.note(identityPoolId);
          return {
            identityPoolId,
            identityPoolArn,
            identityPoolName: name,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* ci
            .deleteIdentityPool({ IdentityPoolId: output.identityPoolId })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      });
    }),
  );
