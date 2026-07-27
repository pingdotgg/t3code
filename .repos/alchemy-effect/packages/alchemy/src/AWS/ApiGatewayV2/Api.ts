import * as agw2 from "@distilled.cloud/aws/apigatewayv2";
import * as Effect from "effect/Effect";
import { deepEqual, isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags } from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  apiArn,
  collectAllPages,
  retryOnTooManyRequests,
  syncTags,
  tagRecord,
} from "./common.ts";

export interface ApiProps {
  /**
   * Name of the API. If omitted, Alchemy generates a deterministic
   * physical name from the app, stage, and logical ID.
   */
  name?: string;
  /**
   * The API protocol. `HTTP` is the modern Lambda front door; `WEBSOCKET`
   * is the real-time two-way protocol. Changing this triggers a
   * replacement.
   * @default "HTTP"
   */
  protocolType?: "HTTP" | "WEBSOCKET";
  /**
   * Description of the API.
   */
  description?: string;
  /**
   * The route selection expression. Required by AWS for WebSocket APIs;
   * defaults to `$request.body.action` when `protocolType` is `WEBSOCKET`.
   * HTTP APIs must use `$request.method $request.path` (the AWS default).
   */
  routeSelectionExpression?: string;
  /**
   * An API key selection expression (WebSocket APIs only).
   */
  apiKeySelectionExpression?: string;
  /**
   * CORS configuration (HTTP APIs only). Synced in place; removing it
   * deletes the CORS configuration from the API.
   */
  corsConfiguration?: agw2.Cors;
  /**
   * Disable the default `execute-api` endpoint so the API is reachable
   * only through custom domain names.
   * @default false
   */
  disableExecuteApiEndpoint?: boolean;
  /**
   * Avoid validating models when creating a deployment (WebSocket APIs
   * only).
   */
  disableSchemaValidation?: boolean;
  /**
   * The IP address types that can invoke the API.
   * @default "ipv4"
   */
  ipAddressType?: agw2.IpAddressType;
  /**
   * A version identifier for the API.
   */
  version?: string;
  /**
   * User-defined tags (Alchemy internal tags are merged automatically).
   */
  tags?: Record<string, string>;
}

export interface Api extends Resource<
  "AWS.ApiGatewayV2.Api",
  ApiProps,
  {
    /** The API identifier. */
    apiId: string;
    /** The default endpoint, e.g. `https://{apiId}.execute-api.{region}.amazonaws.com` (or `wss://...` for WebSocket APIs). */
    apiEndpoint: string;
    /** The API name. */
    name: string;
    /** The API protocol. */
    protocolType: string;
    /** The route selection expression. */
    routeSelectionExpression: string | undefined;
    description: string | undefined;
    apiKeySelectionExpression: string | undefined;
    corsConfiguration: agw2.Cors | undefined;
    disableExecuteApiEndpoint: boolean | undefined;
    disableSchemaValidation: boolean | undefined;
    ipAddressType: string | undefined;
    version: string | undefined;
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon API Gateway v2 API — the root of an HTTP API or WebSocket API.
 *
 * HTTP APIs are the modern, cheaper, faster front door for Lambda functions
 * (compared to REST v1). WebSocket APIs provide two-way real-time messaging
 * backed by Lambda route handlers. Child resources (`Integration`, `Route`,
 * `Stage`, `Authorizer`) reference the API by passing `api` in their props.
 * @resource
 * @section HTTP APIs
 * For the common "HTTP API in front of a Lambda function" case, prefer the
 * high-level {@link HttpApi} helper which wires up the integration, route,
 * stage, and invoke permission in one call.
 *
 * @example Minimal HTTP API
 * ```typescript
 * import * as ApiGatewayV2 from "alchemy/AWS/ApiGatewayV2";
 *
 * const api = yield* ApiGatewayV2.Api("Api", {});
 * ```
 *
 * @example HTTP API with CORS
 * ```typescript
 * const api = yield* ApiGatewayV2.Api("Api", {
 *   corsConfiguration: {
 *     AllowOrigins: ["https://example.com"],
 *     AllowMethods: ["GET", "POST"],
 *     AllowHeaders: ["content-type"],
 *     MaxAge: 3600,
 *   },
 * });
 * ```
 *
 * @section WebSocket APIs
 * @example WebSocket API
 * ```typescript
 * const api = yield* ApiGatewayV2.Api("WsApi", {
 *   protocolType: "WEBSOCKET",
 *   routeSelectionExpression: "$request.body.action",
 * });
 * ```
 *
 * @section Endpoint hardening
 * @example Disable the default execute-api endpoint
 * ```typescript
 * const api = yield* ApiGatewayV2.Api("Api", {
 *   disableExecuteApiEndpoint: true,
 * });
 * ```
 */
export const Api = Resource<Api>("AWS.ApiGatewayV2.Api");

const generatedName = (id: string, props: ApiProps) =>
  props.name
    ? Effect.succeed(props.name)
    : createPhysicalName({ id, maxLength: 128 });

const defaultRouteSelectionExpression = (props: ApiProps) =>
  props.routeSelectionExpression ??
  (props.protocolType === "WEBSOCKET" ? "$request.body.action" : undefined);

const snapshotFromApi = (api: agw2.GetApiResponse): Api["Attributes"] => ({
  apiId: api.ApiId!,
  apiEndpoint: api.ApiEndpoint ?? "",
  name: api.Name ?? "",
  protocolType: api.ProtocolType ?? "HTTP",
  routeSelectionExpression: api.RouteSelectionExpression,
  description: api.Description,
  apiKeySelectionExpression: api.ApiKeySelectionExpression,
  corsConfiguration: api.CorsConfiguration,
  disableExecuteApiEndpoint: api.DisableExecuteApiEndpoint,
  disableSchemaValidation: api.DisableSchemaValidation,
  ipAddressType: api.IpAddressType,
  version: api.Version,
  tags: tagRecord(api.Tags),
});

export const ApiProvider = () =>
  Provider.effect(
    Api,
    Effect.gen(function* () {
      const getApiSafe = (apiId: string) =>
        agw2
          .getApi({ ApiId: apiId })
          .pipe(
            Effect.catchTag("NotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      return Api.Provider.of({
        stables: ["apiId", "apiEndpoint"],

        list: () =>
          Effect.gen(function* () {
            const items = yield* collectAllPages((NextToken) =>
              agw2.getApis({ NextToken }),
            );
            return items
              .filter((api) => api.ApiId != null)
              .map((api) => snapshotFromApi(api));
          }),

        read: Effect.fn(function* ({ output }) {
          if (!output?.apiId) return undefined;
          const api = yield* getApiSafe(output.apiId);
          if (!api?.ApiId) return undefined;
          return snapshotFromApi(api);
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldProtocol = olds.protocolType ?? "HTTP";
          const newProtocol = news.protocolType ?? "HTTP";
          if (oldProtocol !== newProtocol) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const { region } = yield* AWSEnvironment.current;
          const name = yield* generatedName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };
          const routeSelectionExpression =
            defaultRouteSelectionExpression(news);

          // 1. OBSERVE — output is only a cache for the stable id; the
          //    cloud is authoritative.
          let observed = output?.apiId
            ? yield* getApiSafe(output.apiId)
            : undefined;

          // 2. ENSURE — create if missing (greenfield or deleted
          //    out-of-band).
          if (!observed?.ApiId) {
            observed = yield* retryOnTooManyRequests(
              agw2.createApi({
                Name: name,
                ProtocolType: news.protocolType ?? "HTTP",
                Description: news.description,
                RouteSelectionExpression: routeSelectionExpression,
                ApiKeySelectionExpression: news.apiKeySelectionExpression,
                CorsConfiguration: news.corsConfiguration,
                DisableExecuteApiEndpoint: news.disableExecuteApiEndpoint,
                DisableSchemaValidation: news.disableSchemaValidation,
                IpAddressType: news.ipAddressType,
                Version: news.version,
                Tags: desiredTags,
              }),
            );
            yield* session.note(`Created API ${observed.ApiId}`);
          }
          const apiId = observed.ApiId!;
          const snapshot = snapshotFromApi(observed);

          // 3. SYNC — diff observed against desired per mutable aspect and
          //    apply only the delta.
          const drift =
            snapshot.name !== name ||
            snapshot.description !== news.description ||
            (routeSelectionExpression !== undefined &&
              snapshot.routeSelectionExpression !== routeSelectionExpression) ||
            snapshot.apiKeySelectionExpression !==
              news.apiKeySelectionExpression ||
            (news.corsConfiguration !== undefined &&
              !deepEqual(snapshot.corsConfiguration, news.corsConfiguration)) ||
            (snapshot.disableExecuteApiEndpoint ?? false) !==
              (news.disableExecuteApiEndpoint ?? false) ||
            (news.disableSchemaValidation !== undefined &&
              snapshot.disableSchemaValidation !==
                news.disableSchemaValidation) ||
            (news.ipAddressType !== undefined &&
              snapshot.ipAddressType !== news.ipAddressType) ||
            snapshot.version !== news.version;
          if (drift) {
            yield* retryOnTooManyRequests(
              agw2.updateApi({
                ApiId: apiId,
                Name: name,
                Description: news.description,
                RouteSelectionExpression: routeSelectionExpression,
                ApiKeySelectionExpression: news.apiKeySelectionExpression,
                CorsConfiguration: news.corsConfiguration,
                DisableExecuteApiEndpoint: news.disableExecuteApiEndpoint,
                DisableSchemaValidation: news.disableSchemaValidation,
                IpAddressType: news.ipAddressType,
                Version: news.version,
              }),
            );
          }

          // CORS removal is a separate API call — `updateApi` cannot clear
          // an existing configuration.
          if (
            news.corsConfiguration === undefined &&
            snapshot.corsConfiguration !== undefined
          ) {
            yield* agw2
              .deleteCorsConfiguration({ ApiId: apiId })
              .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
          }

          // 3b. SYNC TAGS — diff against OBSERVED cloud tags.
          if (!deepEqual(snapshot.tags, desiredTags)) {
            yield* syncTags({
              resourceArn: apiArn(region, apiId),
              oldTags: snapshot.tags,
              newTags: desiredTags,
            });
          }

          // 4. RETURN — re-read so attributes reflect actual cloud state.
          const final = yield* agw2.getApi({ ApiId: apiId });
          yield* session.note(`Reconciled API ${apiId}`);
          return snapshotFromApi(final);
        }),

        delete: Effect.fn(function* ({ output, session }) {
          yield* retryOnTooManyRequests(
            agw2
              .deleteApi({ ApiId: output.apiId })
              .pipe(Effect.catchTag("NotFoundException", () => Effect.void)),
          );
          yield* session.note(`Deleted API ${output.apiId}`);
        }),
      });
    }),
  );
