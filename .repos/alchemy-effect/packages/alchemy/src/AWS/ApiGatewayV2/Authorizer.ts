import * as agw2 from "@distilled.cloud/aws/apigatewayv2";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { deepEqual, isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { toWireSeconds } from "../../Util/Duration.ts";
import type { Providers } from "../Providers.ts";
import type { Api } from "./Api.ts";
import { collectAllPages, retryOnTooManyRequests } from "./common.ts";

export interface AuthorizerProps {
  /**
   * ID of the API this authorizer belongs to. Usually derived from
   * `api.apiId` by the {@link Authorizer} wrapper.
   */
  apiId: string;
  /**
   * The authorizer type: `JWT` (HTTP APIs — validate a JWT issued by an
   * OIDC/OAuth2 provider) or `REQUEST` (Lambda authorizer, both
   * protocols).
   */
  authorizerType: "JWT" | "REQUEST";
  /**
   * Name of the authorizer. If omitted, Alchemy generates a deterministic
   * physical name.
   */
  name?: string;
  /**
   * The identity source(s):
   *
   * - JWT — where to find the token, e.g. `["$request.header.Authorization"]`.
   * - REQUEST (HTTP APIs) — the caching identity sources.
   * - REQUEST (WebSocket APIs) — e.g. `["route.request.header.Auth"]`.
   */
  identitySource?: string[];
  /**
   * JWT configuration (`JWT` authorizers only): the token `Issuer` URL and
   * accepted `Audience` values.
   */
  jwtConfiguration?: agw2.JWTConfiguration;
  /**
   * The authorizer's Lambda invocation URI (`REQUEST` authorizers only):
   * `arn:aws:apigateway:{region}:lambda:path/2015-03-31/functions/{functionArn}/invocations`.
   */
  authorizerUri?: string;
  /**
   * The payload format version the Lambda authorizer receives (`REQUEST`
   * on HTTP APIs only): `1.0` or `2.0`.
   */
  authorizerPayloadFormatVersion?: string;
  /**
   * Whether a `REQUEST` authorizer (HTTP APIs, payload 2.0) returns simple
   * `{ isAuthorized: boolean }` responses instead of IAM policies.
   */
  enableSimpleResponses?: boolean;
  /**
   * TTL for cached authorizer results (`REQUEST` only), e.g. `"5 minutes"`
   * or `Duration.seconds(300)` (a bare number is milliseconds). Rounded to
   * whole seconds on the wire (`AuthorizerResultTtlInSeconds`).
   * @default 300 seconds
   */
  authorizerResultTtl?: Duration.Input;
  /**
   * IAM role ARN API Gateway assumes to invoke the authorizer Lambda.
   * Omit to use a Lambda resource policy (`Lambda.Permission`) instead.
   */
  authorizerCredentialsArn?: string;
  /**
   * Validation expression for the incoming identity (WebSocket `REQUEST`
   * authorizers only).
   */
  identityValidationExpression?: string;
}

export interface AuthorizerType extends Resource<
  "AWS.ApiGatewayV2.Authorizer",
  AuthorizerProps,
  {
    /** The API this authorizer belongs to. */
    apiId: string;
    /** The authorizer identifier — referenced by `Route.authorizerId`. */
    authorizerId: string;
    /** The authorizer name. */
    name: string;
    authorizerType: string;
    identitySource: string[] | undefined;
    jwtConfiguration: agw2.JWTConfiguration | undefined;
    authorizerUri: string | undefined;
    authorizerPayloadFormatVersion: string | undefined;
    enableSimpleResponses: boolean | undefined;
    authorizerResultTtlInSeconds: number | undefined;
    authorizerCredentialsArn: string | undefined;
    identityValidationExpression: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An API Gateway v2 Authorizer — controls access to HTTP/WebSocket API
 * routes via JWT validation or a Lambda (`REQUEST`) authorizer.
 * @resource
 * @section JWT authorizers
 * The common HTTP API authorizer: API Gateway validates the caller's JWT
 * against the issuer's JWKS and matches the audience — no Lambda invoked.
 *
 * @example JWT authorizer for a Cognito user pool
 * ```typescript
 * const authorizer = yield* ApiGatewayV2.Authorizer("Jwt", {
 *   api,
 *   authorizerType: "JWT",
 *   identitySource: ["$request.header.Authorization"],
 *   jwtConfiguration: {
 *     Issuer: `https://cognito-idp.us-west-2.amazonaws.com/${userPoolId}`,
 *     Audience: [clientId],
 *   },
 * });
 *
 * yield* ApiGatewayV2.Route("Secure", {
 *   api,
 *   routeKey: "GET /me",
 *   integration,
 *   authorizationType: "JWT",
 *   authorizerId: authorizer.authorizerId,
 * });
 * ```
 *
 * @section Lambda (REQUEST) authorizers
 * @example Simple-response Lambda authorizer
 * ```typescript
 * const authorizer = yield* ApiGatewayV2.Authorizer("Lambda", {
 *   api,
 *   authorizerType: "REQUEST",
 *   identitySource: ["$request.header.Authorization"],
 *   authorizerUri: invocationUri,
 *   authorizerPayloadFormatVersion: "2.0",
 *   enableSimpleResponses: true,
 * });
 * ```
 */
export const AuthorizerResource = Resource<AuthorizerType>(
  "AWS.ApiGatewayV2.Authorizer",
);

export interface AuthorizerInputProps extends Omit<
  {
    [K in keyof AuthorizerProps]?: Input<AuthorizerProps[K]>;
  },
  "apiId" | "authorizerType"
> {
  /**
   * The `Api` this authorizer belongs to (preferred). Alternatively pass a
   * raw `apiId`.
   */
  api?: Api;
  apiId?: Input<string>;
  authorizerType: Input<"JWT" | "REQUEST">;
}

/**
 * User-facing wrapper for the Authorizer resource. Accepts `api: Api` as
 * the idiomatic way to attach an authorizer to an API.
 */
export const Authorizer = (id: string, props: AuthorizerInputProps) =>
  Effect.gen(function* () {
    const { api, ...rest } = props;
    const apiId = rest.apiId ?? api?.apiId;
    if (!apiId) {
      return yield* Effect.die(
        "Authorizer requires either `api` (preferred) or an explicit `apiId`.",
      );
    }
    return yield* AuthorizerResource(id, { ...rest, apiId } as any);
  });

const snapshotFromAuthorizer = (
  apiId: string,
  auth: agw2.GetAuthorizerResponse,
): AuthorizerType["Attributes"] => ({
  apiId,
  authorizerId: auth.AuthorizerId!,
  name: auth.Name ?? "",
  authorizerType: auth.AuthorizerType ?? "JWT",
  identitySource: auth.IdentitySource,
  jwtConfiguration: auth.JwtConfiguration,
  authorizerUri: auth.AuthorizerUri,
  authorizerPayloadFormatVersion: auth.AuthorizerPayloadFormatVersion,
  enableSimpleResponses: auth.EnableSimpleResponses,
  authorizerResultTtlInSeconds: auth.AuthorizerResultTtlInSeconds,
  authorizerCredentialsArn: auth.AuthorizerCredentialsArn,
  identityValidationExpression: auth.IdentityValidationExpression,
});

export const AuthorizerProvider = () =>
  Provider.effect(
    AuthorizerResource,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: Pick<AuthorizerProps, "name">,
      ) {
        return (
          props.name ?? (yield* createPhysicalName({ id, maxLength: 128 }))
        );
      });

      const getAuthorizerSafe = (apiId: string, authorizerId: string) =>
        agw2
          .getAuthorizer({ ApiId: apiId, AuthorizerId: authorizerId })
          .pipe(
            Effect.catchTag("NotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      return AuthorizerResource.Provider.of({
        stables: ["apiId", "authorizerId"],

        list: () =>
          Effect.gen(function* () {
            const apis = yield* collectAllPages((NextToken) =>
              agw2.getApis({ NextToken }),
            );
            const perApi = yield* Effect.forEach(
              apis.filter((api) => api.ApiId != null),
              (api) =>
                collectAllPages((NextToken) =>
                  agw2.getAuthorizers({ ApiId: api.ApiId!, NextToken }),
                ).pipe(
                  Effect.map((items) =>
                    items
                      .filter((auth) => auth.AuthorizerId != null)
                      .map((auth) => snapshotFromAuthorizer(api.ApiId!, auth)),
                  ),
                  Effect.catchTag("NotFoundException", () =>
                    Effect.succeed([] as AuthorizerType["Attributes"][]),
                  ),
                ),
              { concurrency: 5 },
            );
            return perApi.flat();
          }),

        read: Effect.fn(function* ({ output }) {
          if (!output?.apiId || !output.authorizerId) return undefined;
          const auth = yield* getAuthorizerSafe(
            output.apiId,
            output.authorizerId,
          );
          if (!auth?.AuthorizerId) return undefined;
          return snapshotFromAuthorizer(output.apiId, auth);
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (news.apiId !== olds.apiId) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const apiId = output?.apiId ?? news.apiId;
          const name = yield* createName(id, news);

          // 1. OBSERVE
          let observed = output?.authorizerId
            ? yield* getAuthorizerSafe(apiId, output.authorizerId)
            : undefined;

          // 2. ENSURE
          if (!observed?.AuthorizerId) {
            observed = yield* retryOnTooManyRequests(
              agw2.createAuthorizer({
                ApiId: apiId,
                Name: name,
                AuthorizerType: news.authorizerType,
                IdentitySource: news.identitySource,
                JwtConfiguration: news.jwtConfiguration,
                AuthorizerUri: news.authorizerUri,
                AuthorizerPayloadFormatVersion:
                  news.authorizerPayloadFormatVersion,
                EnableSimpleResponses: news.enableSimpleResponses,
                AuthorizerResultTtlInSeconds: toWireSeconds(
                  news.authorizerResultTtl,
                ),
                AuthorizerCredentialsArn: news.authorizerCredentialsArn,
                IdentityValidationExpression: news.identityValidationExpression,
              }),
            );
            yield* session.note(`Created authorizer ${observed.AuthorizerId}`);
            return snapshotFromAuthorizer(apiId, observed);
          }

          // 3. SYNC — update on drift.
          const snapshot = snapshotFromAuthorizer(apiId, observed);
          const desiredTtlSeconds = toWireSeconds(news.authorizerResultTtl);
          const drift =
            snapshot.name !== name ||
            snapshot.authorizerType !== news.authorizerType ||
            (news.identitySource !== undefined &&
              !deepEqual(snapshot.identitySource, news.identitySource)) ||
            (news.jwtConfiguration !== undefined &&
              !deepEqual(snapshot.jwtConfiguration, news.jwtConfiguration)) ||
            snapshot.authorizerUri !== news.authorizerUri ||
            snapshot.authorizerPayloadFormatVersion !==
              news.authorizerPayloadFormatVersion ||
            (news.enableSimpleResponses !== undefined &&
              snapshot.enableSimpleResponses !== news.enableSimpleResponses) ||
            (desiredTtlSeconds !== undefined &&
              snapshot.authorizerResultTtlInSeconds !== desiredTtlSeconds) ||
            snapshot.authorizerCredentialsArn !==
              news.authorizerCredentialsArn ||
            snapshot.identityValidationExpression !==
              news.identityValidationExpression;
          if (drift) {
            const updated = yield* retryOnTooManyRequests(
              agw2.updateAuthorizer({
                ApiId: apiId,
                AuthorizerId: snapshot.authorizerId,
                Name: name,
                AuthorizerType: news.authorizerType,
                IdentitySource: news.identitySource,
                JwtConfiguration: news.jwtConfiguration,
                AuthorizerUri: news.authorizerUri,
                AuthorizerPayloadFormatVersion:
                  news.authorizerPayloadFormatVersion,
                EnableSimpleResponses: news.enableSimpleResponses,
                AuthorizerResultTtlInSeconds: desiredTtlSeconds,
                AuthorizerCredentialsArn: news.authorizerCredentialsArn,
                IdentityValidationExpression: news.identityValidationExpression,
              }),
            );
            yield* session.note(`Updated authorizer ${snapshot.authorizerId}`);
            return snapshotFromAuthorizer(apiId, updated);
          }

          return snapshot;
        }),

        delete: Effect.fn(function* ({ output, session }) {
          yield* retryOnTooManyRequests(
            agw2
              .deleteAuthorizer({
                ApiId: output.apiId,
                AuthorizerId: output.authorizerId,
              })
              .pipe(Effect.catchTag("NotFoundException", () => Effect.void)),
          );
          yield* session.note(`Deleted authorizer ${output.authorizerId}`);
        }),
      });
    }),
  );
