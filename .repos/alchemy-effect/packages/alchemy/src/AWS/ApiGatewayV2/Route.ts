import * as agw2 from "@distilled.cloud/aws/apigatewayv2";
import * as Effect from "effect/Effect";
import { deepEqual, isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import * as Output from "../../Output.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import type { Api } from "./Api.ts";
import { collectAllPages, retryOnTooManyRequests } from "./common.ts";
import type { IntegrationType } from "./Integration.ts";

export interface RouteProps {
  /**
   * ID of the API this route belongs to. Usually derived from `api.apiId`
   * by the {@link Route} wrapper.
   */
  apiId: string;
  /**
   * The route key:
   *
   * - HTTP APIs — `"GET /items"`, `"ANY /{proxy+}"`, or `"$default"`.
   * - WebSocket APIs — `"$connect"`, `"$disconnect"`, `"$default"`, or a
   *   custom action name matched by the API's route selection expression.
   */
  routeKey: string;
  /**
   * The route target, usually `integrations/{integrationId}`. Prefer the
   * `integration` prop on the {@link Route} wrapper which formats this for
   * you.
   */
  target?: string;
  /**
   * The authorization type: `NONE`, `AWS_IAM`, `JWT` (HTTP APIs), or
   * `CUSTOM` (Lambda authorizer).
   * @default "NONE"
   */
  authorizationType?: agw2.AuthorizationType;
  /**
   * The `Authorizer` id when `authorizationType` is `JWT` or `CUSTOM`.
   */
  authorizerId?: string;
  /**
   * Authorization scopes for JWT authorization.
   */
  authorizationScopes?: string[];
  /** Whether an API key is required (WebSocket APIs only). */
  apiKeyRequired?: boolean;
  /** Operation name for the route. */
  operationName?: string;
  /** The model selection expression (WebSocket APIs only). */
  modelSelectionExpression?: string;
  /** Request models (WebSocket APIs only). */
  requestModels?: { [key: string]: string | undefined };
  /** Request parameter constraints (WebSocket APIs only). */
  requestParameters?: {
    [key: string]: agw2.ParameterConstraints | undefined;
  };
  /**
   * The route response selection expression (WebSocket APIs only). Set to
   * `$default` to enable two-way (request/response) routes.
   */
  routeResponseSelectionExpression?: string;
}

export interface RouteType extends Resource<
  "AWS.ApiGatewayV2.Route",
  RouteProps,
  {
    /** The API this route belongs to. */
    apiId: string;
    /** The route identifier. */
    routeId: string;
    /** The route key. */
    routeKey: string;
    target: string | undefined;
    authorizationType: agw2.AuthorizationType | undefined;
    authorizerId: string | undefined;
    authorizationScopes: string[] | undefined;
    apiKeyRequired: boolean | undefined;
    operationName: string | undefined;
    modelSelectionExpression: string | undefined;
    requestModels: { [key: string]: string | undefined } | undefined;
    requestParameters:
      | { [key: string]: agw2.ParameterConstraints | undefined }
      | undefined;
    routeResponseSelectionExpression: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An API Gateway v2 Route — matches incoming requests (or WebSocket
 * messages) and forwards them to an Integration.
 * @resource
 * @section HTTP API routes
 * @example Catch-all $default route
 * ```typescript
 * yield* ApiGatewayV2.Route("Default", {
 *   api,
 *   routeKey: "$default",
 *   integration,
 * });
 * ```
 *
 * @example Method + path route
 * ```typescript
 * yield* ApiGatewayV2.Route("ListItems", {
 *   api,
 *   routeKey: "GET /items",
 *   integration,
 * });
 * ```
 *
 * @section WebSocket routes
 * @example $connect route
 * ```typescript
 * yield* ApiGatewayV2.Route("Connect", {
 *   api,
 *   routeKey: "$connect",
 *   integration,
 * });
 * ```
 *
 * @section Securing routes
 * @example JWT-protected route
 * ```typescript
 * yield* ApiGatewayV2.Route("Secure", {
 *   api,
 *   routeKey: "GET /me",
 *   integration,
 *   authorizationType: "JWT",
 *   authorizerId: authorizer.authorizerId,
 * });
 * ```
 */
export const RouteResource = Resource<RouteType>("AWS.ApiGatewayV2.Route");

export interface RouteInputProps extends Omit<
  {
    [K in keyof RouteProps]?: Input<RouteProps[K]>;
  },
  "apiId" | "routeKey"
> {
  /**
   * The `Api` this route belongs to (preferred). Alternatively pass a raw
   * `apiId`.
   */
  api?: Api;
  apiId?: Input<string>;
  routeKey: Input<string>;
  /**
   * The `Integration` this route targets. Formats `target` as
   * `integrations/{integrationId}` for you. Alternatively pass a raw
   * `target`.
   */
  integration?: IntegrationType;
}

/**
 * User-facing wrapper for the Route resource. Accepts `api: Api` and
 * `integration: Integration` as the idiomatic way to wire a route.
 */
export const Route = (id: string, props: RouteInputProps) =>
  Effect.gen(function* () {
    const { api, integration, ...rest } = props;
    const apiId = rest.apiId ?? api?.apiId;
    if (!apiId) {
      return yield* Effect.die(
        "Route requires either `api` (preferred) or an explicit `apiId`.",
      );
    }
    const target =
      rest.target ??
      (integration
        ? Output.map(integration.integrationId, (id) => `integrations/${id}`)
        : undefined);
    return yield* RouteResource(id, { ...rest, apiId, target } as any);
  });

const snapshotFromRoute = (
  apiId: string,
  route: agw2.GetRouteResult,
): RouteType["Attributes"] => ({
  apiId,
  routeId: route.RouteId!,
  routeKey: route.RouteKey ?? "",
  target: route.Target,
  authorizationType: route.AuthorizationType,
  authorizerId: route.AuthorizerId,
  authorizationScopes: route.AuthorizationScopes,
  apiKeyRequired: route.ApiKeyRequired,
  operationName: route.OperationName,
  modelSelectionExpression: route.ModelSelectionExpression,
  requestModels: route.RequestModels,
  requestParameters: route.RequestParameters,
  routeResponseSelectionExpression: route.RouteResponseSelectionExpression,
});

const desiredRequest = (news: RouteProps) => ({
  RouteKey: news.routeKey,
  Target: news.target,
  AuthorizationType: news.authorizationType,
  AuthorizerId: news.authorizerId,
  AuthorizationScopes: news.authorizationScopes,
  ApiKeyRequired: news.apiKeyRequired,
  OperationName: news.operationName,
  ModelSelectionExpression: news.modelSelectionExpression,
  RequestModels: news.requestModels,
  RequestParameters: news.requestParameters,
  RouteResponseSelectionExpression: news.routeResponseSelectionExpression,
});

export const RouteProvider = () =>
  Provider.effect(
    RouteResource,
    Effect.gen(function* () {
      const getRouteSafe = (apiId: string, routeId: string) =>
        agw2
          .getRoute({ ApiId: apiId, RouteId: routeId })
          .pipe(
            Effect.catchTag("NotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      const findRouteByKey = (apiId: string, routeKey: string) =>
        collectAllPages((NextToken) =>
          agw2.getRoutes({ ApiId: apiId, NextToken }),
        ).pipe(
          Effect.map((routes) =>
            routes.find((route) => route.RouteKey === routeKey),
          ),
        );

      return RouteResource.Provider.of({
        stables: ["apiId", "routeId"],

        list: () =>
          Effect.gen(function* () {
            const apis = yield* collectAllPages((NextToken) =>
              agw2.getApis({ NextToken }),
            );
            const perApi = yield* Effect.forEach(
              apis.filter((api) => api.ApiId != null),
              (api) =>
                collectAllPages((NextToken) =>
                  agw2.getRoutes({ ApiId: api.ApiId!, NextToken }),
                ).pipe(
                  Effect.map((routes) =>
                    routes
                      .filter((route) => route.RouteId != null)
                      .map((route) => snapshotFromRoute(api.ApiId!, route)),
                  ),
                  Effect.catchTag("NotFoundException", () =>
                    Effect.succeed([] as RouteType["Attributes"][]),
                  ),
                ),
              { concurrency: 5 },
            );
            return perApi.flat();
          }),

        read: Effect.fn(function* ({ output }) {
          if (!output?.apiId || !output.routeId) return undefined;
          const route = yield* getRouteSafe(output.apiId, output.routeId);
          if (!route?.RouteId) return undefined;
          return snapshotFromRoute(output.apiId, route);
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (news.apiId !== olds.apiId) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ news, output, session }) {
          const apiId = output?.apiId ?? news.apiId;

          // 1. OBSERVE — by cached route id, falling back to a lookup by
          //    route key (covers a crash after create but before persist).
          let observed = output?.routeId
            ? yield* getRouteSafe(apiId, output.routeId)
            : yield* findRouteByKey(apiId, news.routeKey);

          // 2. ENSURE — create if missing; a ConflictException means the
          //    route key was created concurrently, so adopt it by key.
          if (!observed?.RouteId) {
            observed = yield* retryOnTooManyRequests(
              agw2.createRoute({ ApiId: apiId, ...desiredRequest(news) }),
            ).pipe(
              Effect.catchTag("BadRequestException", (error) =>
                // AWS reports a duplicate route key as a BadRequestException
                // ("Route with key ... already exists") — a race with a
                // concurrent reconciler. Adopt the existing route.
                findRouteByKey(apiId, news.routeKey).pipe(
                  Effect.flatMap((existing) =>
                    existing ? Effect.succeed(existing) : Effect.fail(error),
                  ),
                ),
              ),
            );
            yield* session.note(
              `Created route ${news.routeKey} (${observed.RouteId})`,
            );
          }
          const routeId = observed.RouteId!;
          const snapshot = snapshotFromRoute(apiId, observed);

          // 3. SYNC — update in place on drift (route key is mutable).
          const desired = desiredRequest(news);
          const drift =
            snapshot.routeKey !== desired.RouteKey ||
            snapshot.target !== desired.Target ||
            (snapshot.authorizationType ?? "NONE") !==
              (desired.AuthorizationType ?? "NONE") ||
            snapshot.authorizerId !== desired.AuthorizerId ||
            (desired.AuthorizationScopes !== undefined &&
              !deepEqual(
                snapshot.authorizationScopes,
                desired.AuthorizationScopes,
              )) ||
            (desired.ApiKeyRequired !== undefined &&
              snapshot.apiKeyRequired !== desired.ApiKeyRequired) ||
            snapshot.operationName !== desired.OperationName ||
            snapshot.modelSelectionExpression !==
              desired.ModelSelectionExpression ||
            (desired.RequestModels !== undefined &&
              !deepEqual(snapshot.requestModels, desired.RequestModels)) ||
            (desired.RequestParameters !== undefined &&
              !deepEqual(
                snapshot.requestParameters,
                desired.RequestParameters,
              )) ||
            snapshot.routeResponseSelectionExpression !==
              desired.RouteResponseSelectionExpression;
          if (drift) {
            const updated = yield* retryOnTooManyRequests(
              agw2.updateRoute({ ApiId: apiId, RouteId: routeId, ...desired }),
            );
            yield* session.note(`Updated route ${news.routeKey}`);
            return snapshotFromRoute(apiId, updated);
          }

          return snapshot;
        }),

        delete: Effect.fn(function* ({ output, session }) {
          yield* retryOnTooManyRequests(
            agw2
              .deleteRoute({ ApiId: output.apiId, RouteId: output.routeId })
              .pipe(Effect.catchTag("NotFoundException", () => Effect.void)),
          );
          yield* session.note(`Deleted route ${output.routeKey}`);
        }),
      });
    }),
  );
