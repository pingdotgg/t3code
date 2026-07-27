import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { AccountID } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import type { RegionID } from "../Region.ts";

export type {
  ConnectionAuthorizationType,
  ConnectionHttpParameters,
  ConnectionOAuthHttpMethod,
  ConnectionState,
} from "@distilled.cloud/aws/eventbridge";

export type ConnectionName = string;
export type ConnectionArn =
  `arn:aws:events:${RegionID}:${AccountID}:connection/${ConnectionName}/${string}`;

export interface ConnectionApiKeyAuthParameters {
  /** Header name the API key is sent under (e.g. `x-api-key`). */
  apiKeyName: string;
  /** The API key value. Wrap with `Redacted.make(...)` — stored by EventBridge in Secrets Manager. */
  apiKeyValue: Redacted.Redacted<string>;
}

export interface ConnectionBasicAuthParameters {
  /** Username for HTTP Basic authorization. */
  username: string;
  /** Password for HTTP Basic authorization. Wrap with `Redacted.make(...)`. */
  password: Redacted.Redacted<string>;
}

export interface ConnectionOAuthClientParameters {
  /** OAuth client ID. */
  clientId: string;
  /** OAuth client secret. Wrap with `Redacted.make(...)`. */
  clientSecret: Redacted.Redacted<string>;
}

export interface ConnectionOAuthParameters {
  /** The client credentials exchanged for a token. */
  clientParameters: ConnectionOAuthClientParameters;
  /** URL of the OAuth authorization (token) endpoint. */
  authorizationEndpoint: string;
  /** HTTP method used against the authorization endpoint. */
  httpMethod: eventbridge.ConnectionOAuthHttpMethod;
  /** Additional parameters included in the token request. */
  oauthHttpParameters?: eventbridge.ConnectionHttpParameters;
}

export interface ConnectionAuthParameters {
  /** API-key authorization (`authorizationType: "API_KEY"`). */
  apiKeyAuthParameters?: ConnectionApiKeyAuthParameters;
  /** Basic authorization (`authorizationType: "BASIC"`). */
  basicAuthParameters?: ConnectionBasicAuthParameters;
  /** OAuth client-credentials authorization (`authorizationType: "OAUTH_CLIENT_CREDENTIALS"`). */
  oauthParameters?: ConnectionOAuthParameters;
  /** Additional header/query/body parameters included in every invocation. */
  invocationHttpParameters?: eventbridge.ConnectionHttpParameters;
}

export interface ConnectionProps {
  /**
   * Name of the connection. Must match [\.\-_A-Za-z0-9]+, 1-64 characters.
   * If omitted, a unique name will be generated.
   */
  name?: ConnectionName;

  /**
   * Description of the connection. Max 512 characters.
   */
  description?: string;

  /**
   * The type of authorization to use for the connection.
   */
  authorizationType: eventbridge.ConnectionAuthorizationType;

  /**
   * The authorization parameters matching `authorizationType`. Secret values
   * (`apiKeyValue`, `password`, `clientSecret`) are `Redacted` end-to-end and
   * stored by EventBridge in Secrets Manager.
   */
  authParameters: ConnectionAuthParameters;

  /**
   * The identifier of the KMS customer managed key to encrypt the connection
   * secret.
   */
  kmsKeyIdentifier?: string;
}

/**
 * An Amazon EventBridge connection holding the authorization used to invoke
 * an HTTP endpoint through an {@link ApiDestination}. EventBridge stores the
 * secret half of the connection in Secrets Manager on your behalf.
 *
 * Connections do not support tags, so ownership is tracked by the
 * deterministic physical name.
 * @resource
 * @section Connecting to APIs
 * @example API-Key Connection
 * ```typescript
 * import * as Redacted from "effect/Redacted";
 *
 * const connection = yield* AWS.EventBridge.Connection("PartnerApi", {
 *   authorizationType: "API_KEY",
 *   authParameters: {
 *     apiKeyAuthParameters: {
 *       apiKeyName: "x-api-key",
 *       apiKeyValue: Redacted.make(process.env.PARTNER_API_KEY!),
 *     },
 *   },
 * });
 * ```
 *
 * @example OAuth Client-Credentials Connection
 * ```typescript
 * const connection = yield* AWS.EventBridge.Connection("OAuthApi", {
 *   authorizationType: "OAUTH_CLIENT_CREDENTIALS",
 *   authParameters: {
 *     oauthParameters: {
 *       clientParameters: {
 *         clientId: "my-client",
 *         clientSecret: Redacted.make(process.env.OAUTH_SECRET!),
 *       },
 *       authorizationEndpoint: "https://auth.example.com/oauth/token",
 *       httpMethod: "POST",
 *     },
 *   },
 * });
 * ```
 */
export interface Connection extends Resource<
  "AWS.EventBridge.Connection",
  ConnectionProps,
  {
    /** The name of the connection. */
    connectionName: ConnectionName;
    /** The ARN of the connection. */
    connectionArn: ConnectionArn;
    /** The state of the connection (e.g. `AUTHORIZED`). */
    connectionState: eventbridge.ConnectionState;
    /** ARN of the Secrets Manager secret EventBridge created for the connection. */
    secretArn?: string;
  },
  never,
  Providers
> {}
export const Connection = Resource<Connection>("AWS.EventBridge.Connection");

const toCreateAuthParameters = (
  auth: ConnectionAuthParameters,
): eventbridge.CreateConnectionAuthRequestParameters => ({
  ApiKeyAuthParameters: auth.apiKeyAuthParameters
    ? {
        ApiKeyName: auth.apiKeyAuthParameters.apiKeyName,
        ApiKeyValue: auth.apiKeyAuthParameters.apiKeyValue,
      }
    : undefined,
  BasicAuthParameters: auth.basicAuthParameters
    ? {
        Username: auth.basicAuthParameters.username,
        Password: auth.basicAuthParameters.password,
      }
    : undefined,
  OAuthParameters: auth.oauthParameters
    ? {
        ClientParameters: {
          ClientID: auth.oauthParameters.clientParameters.clientId,
          ClientSecret: auth.oauthParameters.clientParameters.clientSecret,
        },
        AuthorizationEndpoint: auth.oauthParameters.authorizationEndpoint,
        HttpMethod: auth.oauthParameters.httpMethod,
        OAuthHttpParameters: auth.oauthParameters.oauthHttpParameters,
      }
    : undefined,
  InvocationHttpParameters: auth.invocationHttpParameters,
});

export const ConnectionProvider = () =>
  Provider.effect(
    Connection,
    Effect.gen(function* () {
      const createConnectionName = (
        id: string,
        props: { name?: string } = {},
      ) =>
        props.name
          ? Effect.succeed(props.name)
          : createPhysicalName({
              id,
              maxLength: 64,
            });

      /**
       * Poll until the connection settles out of its transitional state
       * (CREATING/UPDATING/AUTHORIZING). API-key and basic connections
       * authorize in seconds; the wait is bounded so a slow OAuth handshake
       * surfaces the last observed state instead of hanging.
       */
      const awaitSettled = (name: string) =>
        eventbridge.describeConnection({ Name: name }).pipe(
          // A describe fired immediately after create can be eventually
          // consistent — absorb NotFound briefly before polling the state.
          Effect.retry({
            while: (e): boolean => e._tag === "ResourceNotFoundException",
            schedule: Schedule.spaced("1 second"),
            times: 5,
          }),
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (r): boolean =>
              r.ConnectionState !== "CREATING" &&
              r.ConnectionState !== "UPDATING" &&
              r.ConnectionState !== "AUTHORIZING",
            times: 15,
          }),
        );

      return {
        stables: ["connectionName", "connectionArn"],
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return;
          const oldName = yield* createConnectionName(id, olds);
          const newName = yield* createConnectionName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          // Connections don't support tags; the deterministic physical name
          // is the ownership signal (it embeds app/stage/logical id).
          const connectionName =
            output?.connectionName ??
            (yield* createConnectionName(id, olds ?? {}));
          const described = yield* eventbridge
            .describeConnection({ Name: connectionName })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (!described?.Name || !described.ConnectionArn) {
            return undefined;
          }
          return {
            connectionName: described.Name,
            connectionArn: described.ConnectionArn as ConnectionArn,
            connectionState: described.ConnectionState ?? "AUTHORIZED",
            secretArn: described.SecretArn,
          };
        }),
        list: () =>
          Effect.gen(function* () {
            const attrs: {
              connectionName: ConnectionName;
              connectionArn: ConnectionArn;
              connectionState: eventbridge.ConnectionState;
              secretArn?: string;
            }[] = [];
            let nextToken: string | undefined;
            do {
              const page = yield* eventbridge.listConnections({
                NextToken: nextToken,
              });
              for (const connection of page.Connections ?? []) {
                if (!connection.Name || !connection.ConnectionArn) {
                  continue;
                }
                attrs.push({
                  connectionName: connection.Name,
                  connectionArn: connection.ConnectionArn as ConnectionArn,
                  connectionState: connection.ConnectionState ?? "AUTHORIZED",
                });
              }
              nextToken = page.NextToken;
            } while (nextToken);
            return attrs;
          }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const connectionName =
            output?.connectionName ?? (yield* createConnectionName(id, news));

          // Observe — live cloud state is authoritative; a vanished
          // connection falls through to create.
          const observed = yield* eventbridge
            .describeConnection({ Name: connectionName })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );

          if (!observed?.ConnectionArn) {
            // Ensure — create the connection; tolerate an AlreadyExists race
            // with a peer reconciler and converge via the update below.
            yield* eventbridge
              .createConnection({
                Name: connectionName,
                Description: news.description,
                AuthorizationType: news.authorizationType,
                AuthParameters: toCreateAuthParameters(news.authParameters),
                KmsKeyIdentifier: news.kmsKeyIdentifier,
              })
              .pipe(
                Effect.catchTag(
                  "ResourceAlreadyExistsException",
                  () => Effect.void,
                ),
              );
          } else {
            // Sync — updateConnection overwrites description, authorization
            // type/parameters, and KMS key in one shot. The update-parameter
            // shape is structurally compatible with the create shape (all
            // fields optional).
            yield* eventbridge.updateConnection({
              Name: connectionName,
              Description: news.description,
              AuthorizationType: news.authorizationType,
              AuthParameters: toCreateAuthParameters(news.authParameters),
              KmsKeyIdentifier: news.kmsKeyIdentifier,
            });
          }

          const settled = yield* awaitSettled(connectionName);
          const connectionArn = (settled.ConnectionArn ??
            observed?.ConnectionArn) as ConnectionArn;

          yield* session.note(connectionArn);
          return {
            connectionName,
            connectionArn,
            connectionState: settled.ConnectionState ?? "AUTHORIZED",
            secretArn: settled.SecretArn,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          // Deleting a connection that ApiDestinations still reference fails
          // until the destinations are gone; the engine deletes dependents
          // first, so a bounded retry absorbs eventual consistency.
          yield* eventbridge
            .deleteConnection({ Name: output.connectionName })
            .pipe(
              Effect.retry({
                while: (e): boolean =>
                  e._tag === "ConcurrentModificationException",
                schedule: Schedule.spaced("2 seconds"),
                times: 8,
              }),
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );
