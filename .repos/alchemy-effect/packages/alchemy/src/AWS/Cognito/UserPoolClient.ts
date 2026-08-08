import * as cip from "@distilled.cloud/aws/cognito-identity-provider";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { toWireMinutes } from "../../Util/Duration.ts";
import type { Providers } from "../Providers.ts";

/**
 * The authentication flows an app client is allowed to use.
 */
export type ExplicitAuthFlow =
  | "ALLOW_USER_PASSWORD_AUTH"
  | "ALLOW_ADMIN_USER_PASSWORD_AUTH"
  | "ALLOW_USER_SRP_AUTH"
  | "ALLOW_USER_AUTH"
  | "ALLOW_CUSTOM_AUTH"
  | "ALLOW_REFRESH_TOKEN_AUTH";

/** Units for the token validity durations. */
export type TokenValidityUnit = "seconds" | "minutes" | "hours" | "days";

export interface UserPoolClientProps {
  /**
   * The ID of the user pool the client belongs to. Changing this triggers a
   * replacement.
   */
  userPoolId: string;
  /**
   * Name of the app client. If omitted, a deterministic physical name is
   * generated from the app, stage, and logical ID.
   */
  clientName?: string;
  /**
   * Whether to generate a client secret. Confidential (server-side) clients
   * should use a secret; public (browser/mobile) clients must not.
   * Changing this triggers a replacement.
   * @default false
   */
  generateSecret?: boolean;
  /**
   * The authentication flows this client may use, e.g.
   * `ALLOW_USER_PASSWORD_AUTH` for direct username/password sign-in or
   * `ALLOW_USER_SRP_AUTH` for the SRP protocol.
   * @default ALLOW_USER_SRP_AUTH, ALLOW_CUSTOM_AUTH, ALLOW_REFRESH_TOKEN_AUTH
   */
  explicitAuthFlows?: ExplicitAuthFlow[];
  /**
   * Refresh token validity (in `tokenValidityUnits.refreshToken`, default days).
   * @default 30 days
   */
  refreshTokenValidity?: number;
  /**
   * Access token validity (in `tokenValidityUnits.accessToken`, default hours).
   * @default 1 hour
   */
  accessTokenValidity?: number;
  /**
   * ID token validity (in `tokenValidityUnits.idToken`, default hours).
   * @default 1 hour
   */
  idTokenValidity?: number;
  /**
   * Units for the three token validity numbers.
   */
  tokenValidityUnits?: {
    accessToken?: TokenValidityUnit;
    idToken?: TokenValidityUnit;
    refreshToken?: TokenValidityUnit;
  };
  /**
   * User attributes this client may read.
   */
  readAttributes?: string[];
  /**
   * User attributes this client may write.
   */
  writeAttributes?: string[];
  /**
   * Identity providers this client supports, e.g. `COGNITO` or the names of
   * configured `IdentityProvider`s.
   */
  supportedIdentityProviders?: string[];
  /**
   * Allowed OAuth callback (redirect) URLs.
   */
  callbackUrls?: string[];
  /**
   * Allowed OAuth sign-out URLs.
   */
  logoutUrls?: string[];
  /**
   * Default redirect URI; must be listed in `callbackUrls`.
   */
  defaultRedirectUri?: string;
  /**
   * Allowed OAuth flows (`code`, `implicit`, `client_credentials`).
   */
  allowedOAuthFlows?: ("code" | "implicit" | "client_credentials")[];
  /**
   * Allowed OAuth scopes, e.g. `openid`, `email`, or resource-server scopes.
   */
  allowedOAuthScopes?: string[];
  /**
   * Must be `true` for the OAuth settings above to take effect.
   * @default false
   */
  allowedOAuthFlowsUserPoolClient?: boolean;
  /**
   * `ENABLED` returns a generic error for sign-in attempts against
   * non-existent users (prevents user enumeration); `LEGACY` returns the
   * original errors.
   * @default "ENABLED"
   */
  preventUserExistenceErrors?: "ENABLED" | "LEGACY";
  /**
   * Whether issued tokens can be revoked with `RevokeToken`.
   * @default true
   */
  enableTokenRevocation?: boolean;
  /**
   * Duration of the session token in auth challenge flows, e.g.
   * `"5 minutes"` (3-15 minutes). Rounded to whole minutes on the wire.
   * @default 3 minutes
   */
  authSessionValidity?: Duration.Input;
}

export interface UserPoolClient extends Resource<
  "AWS.Cognito.UserPoolClient",
  UserPoolClientProps,
  {
    /** The generated app client ID. */
    clientId: string;
    /** The client secret; defined only when `generateSecret` is true. */
    clientSecret: Redacted.Redacted<string> | undefined;
    /** The name of the app client. */
    clientName: string;
    /** The ID of the user pool the client belongs to. */
    userPoolId: string;
  },
  never,
  Providers
> {}

/**
 * An app client of an Amazon Cognito user pool. Applications authenticate
 * against the pool through a client, which controls the allowed auth flows,
 * token lifetimes, and OAuth settings.
 * @resource
 * @section Creating an App Client
 * @example Public Client with Password Auth
 * ```typescript
 * import * as Cognito from "alchemy/AWS/Cognito";
 *
 * const pool = yield* Cognito.UserPool("Users", {});
 * const client = yield* Cognito.UserPoolClient("Web", {
 *   userPoolId: pool.userPoolId,
 *   explicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
 * });
 * ```
 *
 * @example Confidential Client with a Secret
 * ```typescript
 * const server = yield* Cognito.UserPoolClient("Server", {
 *   userPoolId: pool.userPoolId,
 *   generateSecret: true,
 *   explicitAuthFlows: ["ALLOW_ADMIN_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
 * });
 * ```
 *
 * @section Token Configuration
 * @example Short-Lived Access Tokens
 * ```typescript
 * const client = yield* Cognito.UserPoolClient("Web", {
 *   userPoolId: pool.userPoolId,
 *   accessTokenValidity: 30,
 *   idTokenValidity: 30,
 *   refreshTokenValidity: 7,
 *   tokenValidityUnits: {
 *     accessToken: "minutes",
 *     idToken: "minutes",
 *     refreshToken: "days",
 *   },
 * });
 * ```
 *
 * @section OAuth
 * @example Authorization Code Flow
 * ```typescript
 * const client = yield* Cognito.UserPoolClient("Web", {
 *   userPoolId: pool.userPoolId,
 *   allowedOAuthFlowsUserPoolClient: true,
 *   allowedOAuthFlows: ["code"],
 *   allowedOAuthScopes: ["openid", "email"],
 *   callbackUrls: ["https://example.com/callback"],
 *   supportedIdentityProviders: ["COGNITO"],
 * });
 * ```
 */
export const UserPoolClient = Resource<UserPoolClient>(
  "AWS.Cognito.UserPoolClient",
);

const plain = (
  value: string | Redacted.Redacted<string> | undefined,
): string | undefined =>
  value === undefined
    ? undefined
    : typeof value === "string"
      ? value
      : Redacted.value(value);

/** The mutable desired state, in wire shape — used both as the update body
 * and (against the observed client) for drift detection. */
const desiredConfig = (news: UserPoolClientProps) => ({
  ExplicitAuthFlows: news.explicitAuthFlows,
  RefreshTokenValidity: news.refreshTokenValidity,
  AccessTokenValidity: news.accessTokenValidity,
  IdTokenValidity: news.idTokenValidity,
  TokenValidityUnits:
    news.tokenValidityUnits === undefined
      ? undefined
      : {
          AccessToken: news.tokenValidityUnits.accessToken,
          IdToken: news.tokenValidityUnits.idToken,
          RefreshToken: news.tokenValidityUnits.refreshToken,
        },
  ReadAttributes: news.readAttributes,
  WriteAttributes: news.writeAttributes,
  SupportedIdentityProviders: news.supportedIdentityProviders,
  CallbackURLs: news.callbackUrls,
  LogoutURLs: news.logoutUrls,
  DefaultRedirectURI: news.defaultRedirectUri,
  AllowedOAuthFlows: news.allowedOAuthFlows,
  AllowedOAuthScopes: news.allowedOAuthScopes,
  AllowedOAuthFlowsUserPoolClient: news.allowedOAuthFlowsUserPoolClient,
  PreventUserExistenceErrors: news.preventUserExistenceErrors,
  EnableTokenRevocation: news.enableTokenRevocation,
  // The Cognito wire unit for AuthSessionValidity is whole minutes.
  AuthSessionValidity: toWireMinutes(news.authSessionValidity),
});

/** True when any prop the user specified differs from the observed client.
 * Unspecified props are "don't care". */
const hasDrift = (
  news: UserPoolClientProps,
  clientName: string,
  observed: cip.UserPoolClientType,
) => {
  if (observed.ClientName !== clientName) return true;
  const desired = desiredConfig(news);
  const observedSubset: Record<string, unknown> = {
    ExplicitAuthFlows: [...(observed.ExplicitAuthFlows ?? [])].sort(),
    RefreshTokenValidity: observed.RefreshTokenValidity,
    AccessTokenValidity: observed.AccessTokenValidity,
    IdTokenValidity: observed.IdTokenValidity,
    TokenValidityUnits: {
      AccessToken: observed.TokenValidityUnits?.AccessToken,
      IdToken: observed.TokenValidityUnits?.IdToken,
      RefreshToken: observed.TokenValidityUnits?.RefreshToken,
    },
    ReadAttributes: [...(observed.ReadAttributes ?? [])].sort(),
    WriteAttributes: [...(observed.WriteAttributes ?? [])].sort(),
    SupportedIdentityProviders: [
      ...(observed.SupportedIdentityProviders ?? []),
    ].sort(),
    CallbackURLs: [...(observed.CallbackURLs ?? [])].sort(),
    LogoutURLs: [...(observed.LogoutURLs ?? [])].sort(),
    DefaultRedirectURI: observed.DefaultRedirectURI,
    AllowedOAuthFlows: [...(observed.AllowedOAuthFlows ?? [])].sort(),
    AllowedOAuthScopes: [...(observed.AllowedOAuthScopes ?? [])].sort(),
    AllowedOAuthFlowsUserPoolClient: observed.AllowedOAuthFlowsUserPoolClient,
    PreventUserExistenceErrors: observed.PreventUserExistenceErrors,
    EnableTokenRevocation: observed.EnableTokenRevocation,
    AuthSessionValidity: observed.AuthSessionValidity,
  };
  for (const [key, desiredValue] of Object.entries(desired)) {
    if (desiredValue === undefined) continue;
    const observedValue = observedSubset[key];
    const normalizedDesired = Array.isArray(desiredValue)
      ? [...desiredValue].sort()
      : desiredValue;
    if (JSON.stringify(normalizedDesired) !== JSON.stringify(observedValue)) {
      return true;
    }
  }
  return false;
};

export const UserPoolClientProvider = () =>
  Provider.effect(
    UserPoolClient,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: Pick<UserPoolClientProps, "clientName">,
      ) {
        return (
          props.clientName ??
          (yield* createPhysicalName({ id, maxLength: 128 }))
        );
      });

      const describeClient = Effect.fn(function* (
        userPoolId: string,
        clientId: string,
      ) {
        return yield* cip
          .describeUserPoolClient({
            UserPoolId: userPoolId,
            ClientId: clientId,
          })
          .pipe(
            Effect.map((r) => r.UserPoolClient),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      /** Find a client of the pool by exact name (used when state was lost).
       * The physical name embeds app/stage/id, so a match is ours. */
      const findClientByName = Effect.fn(function* (
        userPoolId: string,
        clientName: string,
      ) {
        const pages = yield* cip.listUserPoolClients
          .pages({ UserPoolId: userPoolId, MaxResults: 60 })
          .pipe(
            Stream.runCollect,
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed([] as cip.ListUserPoolClientsResponse[]),
            ),
          );
        const match = Array.from(pages)
          .flatMap((page) => page.UserPoolClients ?? [])
          .find((client) => client.ClientName === clientName);
        if (match?.ClientId === undefined) return undefined;
        return yield* describeClient(userPoolId, plain(match.ClientId)!);
      });

      const attributesOf = (client: cip.UserPoolClientType) => {
        const secret = plain(client.ClientSecret);
        return {
          clientId: plain(client.ClientId)!,
          clientSecret:
            secret === undefined ? undefined : Redacted.make(secret),
          clientName: client.ClientName!,
          userPoolId: client.UserPoolId!,
        };
      };

      return UserPoolClient.Provider.of({
        stables: ["clientId", "userPoolId"],

        // Sub-resource keyed entirely by its user pool (userPoolId) with no
        // global enumeration API of its own — nuke reaches it through the
        // parent pool's deletion, so enumeration returns empty per the
        // ProviderService doctrine.
        list: () => Effect.succeed([]),

        read: Effect.fn(function* ({ id, olds, output }) {
          const userPoolId = output?.userPoolId ?? olds?.userPoolId;
          if (userPoolId === undefined) return undefined;
          const observed =
            output?.clientId !== undefined
              ? yield* describeClient(userPoolId, output.clientId)
              : yield* findClientByName(
                  userPoolId,
                  yield* createName(id, olds ?? {}),
                );
          return observed === undefined ? undefined : attributesOf(observed);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          if (
            (olds?.generateSecret ?? false) !== (news?.generateSecret ?? false)
          ) {
            return { action: "replace" } as const;
          }
          if (olds?.userPoolId !== news?.userPoolId) {
            return { action: "replace" } as const;
          }
          const oldName = yield* createName(id, olds ?? {});
          const newName = yield* createName(id, news ?? {});
          if (oldName !== newName) {
            // ClientName is mutable via UpdateUserPoolClient — fall through
            // to the default update path.
            return undefined;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const clientName =
            output?.clientName ?? (yield* createName(id, news));
          const userPoolId = news.userPoolId;

          // 1. OBSERVE — output.clientId is only a cache.
          let observed =
            output?.clientId !== undefined
              ? yield* describeClient(userPoolId, output.clientId)
              : undefined;
          if (observed === undefined) {
            observed = yield* findClientByName(userPoolId, clientName);
          }

          // 2. ENSURE — create when missing.
          if (observed === undefined) {
            observed = yield* cip
              .createUserPoolClient({
                UserPoolId: userPoolId,
                ClientName: clientName,
                GenerateSecret: news.generateSecret,
                ...desiredConfig(news),
              })
              .pipe(Effect.map((r) => r.UserPoolClient!));
          } else if (hasDrift(news, clientName, observed)) {
            // 3. SYNC — UpdateUserPoolClient resets omitted fields to
            //    defaults, so the body is the full desired state; skip the
            //    call when nothing drifted.
            observed = yield* cip
              .updateUserPoolClient({
                UserPoolId: userPoolId,
                ClientId: plain(observed.ClientId)!,
                ClientName: clientName,
                ...desiredConfig(news),
              })
              .pipe(Effect.map((r) => r.UserPoolClient!));
          }

          const attrs = attributesOf(observed);
          yield* session.note(attrs.clientId);
          return attrs;
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* cip
            .deleteUserPoolClient({
              UserPoolId: output.userPoolId,
              ClientId: output.clientId,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      });
    }),
  );
