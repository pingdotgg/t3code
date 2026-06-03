import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Effect from "effect/Effect";
import { deepEqual, isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import type { RestApi } from "./RestApi.ts";

/**
 * Integration configuration for an API Gateway method (passed to `putIntegration`).
 */
export interface MethodIntegrationProps {
  type: ag.IntegrationType;
  integrationHttpMethod?: string;
  uri?: Input<string>;
  connectionType?: ag.ConnectionType;
  connectionId?: string;
  /**
   * IAM role ARN used by API Gateway for integration credentials.
   *
   * This is not a secret value; API Gateway stores an ARN or passthrough marker.
   */
  credentials?: string;
  requestParameters?: { [key: string]: string | undefined };
  requestTemplates?: { [key: string]: string | undefined };
  passthroughBehavior?: string;
  cacheNamespace?: string;
  cacheKeyParameters?: string[];
  contentHandling?: ag.ContentHandlingStrategy;
  timeoutInMillis?: number;
  tlsConfig?: ag.TlsConfig;
  responseTransferMode?: ag.ResponseTransferMode;
  integrationTarget?: string;
}

export interface MethodProps {
  /**
   * The `RestApi` this method lives on. When supplied, the method auto-binds
   * itself to the API so that any `Deployment` of this API waits for the
   * method to be created before snapshotting.
   *
   * When `restApi` is provided, `resourceId` defaults to `restApi.rootResourceId`,
   * which is the common case for methods on the API root (`/`). Pass an
   * explicit `resourceId` when targeting a sub-path defined by
   * `ApiGateway.Resource`.
   *
   * Passing a raw `restApiId` instead is still supported but opts out of
   * automatic deployment ordering — you must then manage `Deployment.triggers`
   * yourself.
   */
  restApi?: RestApi;
  /**
   * ID of the REST API. Usually derived from `restApi.restApiId`; supply
   * explicitly only when not using `restApi`.
   */
  restApiId?: Input<string>;
  /**
   * ID of the API Gateway Resource this method attaches to. Defaults to
   * `restApi.rootResourceId` when `restApi` is provided.
   */
  resourceId?: Input<string>;
  /** HTTP verb, e.g. `GET`, `POST`, `ANY`. */
  httpMethod: string;
  /**
   * Authorization type (`NONE`, `IAM`, `CUSTOM`, `COGNITO_USER_POOLS`, etc.).
   * @default "NONE"
   */
  authorizationType?: string;
  authorizerId?: string;
  apiKeyRequired?: boolean;
  operationName?: string;
  requestParameters?: { [key: string]: boolean | undefined };
  requestModels?: { [key: string]: string | undefined };
  requestValidatorId?: string;
  authorizationScopes?: string[];
  /** When set, `putIntegration` is applied after `putMethod`. */
  integration?: MethodIntegrationProps;
}

export interface MethodType extends Resource<
  "AWS.ApiGateway.Method",
  MethodProps,
  {
    restApiId: string;
    resourceId: string;
    httpMethod: string;
    authorizationType: string;
    authorizerId: string | undefined;
    apiKeyRequired: boolean | undefined;
    operationName: string | undefined;
    requestParameters: { [key: string]: boolean | undefined } | undefined;
    requestModels: { [key: string]: string | undefined } | undefined;
    requestValidatorId: string | undefined;
    authorizationScopes: string[] | undefined;
    integration: MethodIntegrationProps | undefined;
  },
  never,
  Providers
> {}

/**
 * An HTTP method on an API Gateway Resource.
 *
 * A `Method` is a single HTTP verb (`GET`, `POST`, `ANY`, …) attached to a
 * REST API resource path. Most methods also carry an `integration` — the
 * downstream target that actually handles the request (a Lambda function,
 * an HTTP endpoint, a mock response, etc.).
 *
 * @section Binding to a RestApi
 * Pass the `RestApi` value on `restApi`. This threads the API id through
 * and registers the method as a `RestApiBinding` on the API, so that any
 * `Deployment` of the same API is automatically ordered after this method
 * completes. You do not need to manage `Deployment.triggers` yourself.
 *
 * @example GET on the API root with a mock integration
 * ```typescript
 * yield* ApiGateway.Method("GetRoot", {
 *   restApi: api,
 *   httpMethod: "GET",
 *   authorizationType: "NONE",
 *   integration: { type: "MOCK" },
 * });
 * ```
 *
 * @section Lambda proxy integration
 * For Lambda-backed APIs, the integration `uri` follows the
 * `arn:aws:apigateway:<region>:lambda:path/2015-03-31/functions/<function-arn>/invocations`
 * shape. Use `Output.map` to resolve the function ARN before building the
 * URI, since the function's ARN is only known at deploy time.
 *
 * @example ANY method with Lambda AWS_PROXY integration
 * ```typescript
 * import * as Output from "alchemy/Output";
 *
 * const invokeUri = Output.map(
 *   fn.functionArn,
 *   (arn) =>
 *     `arn:aws:apigateway:${region}:lambda:path/2015-03-31/functions/${arn}/invocations`,
 * );
 *
 * yield* ApiGateway.Method("RootAny", {
 *   restApi: api,
 *   httpMethod: "ANY",
 *   authorizationType: "NONE",
 *   integration: {
 *     type: "AWS_PROXY",
 *     integrationHttpMethod: "POST",
 *     uri: invokeUri,
 *   },
 * });
 * ```
 *
 * @section Methods on sub-paths
 * Attach a method to a nested path by creating an `ApiGateway.Resource` and
 * passing its `resourceId` explicitly. `restApi` is still required so the
 * method binds for deployment ordering.
 *
 * @example Method on `/items`
 * ```typescript
 * const items = yield* ApiGateway.Resource("Items", {
 *   restApi: api,
 *   parentId: api.rootResourceId,
 *   pathPart: "items",
 * });
 *
 * yield* ApiGateway.Method("ListItems", {
 *   restApi: api,
 *   resourceId: items.resourceId,
 *   httpMethod: "GET",
 *   authorizationType: "NONE",
 *   integration: { type: "MOCK" },
 * });
 * ```
 */
export const MethodResource = Resource<MethodType>("AWS.ApiGateway.Method");

export interface MethodInputProps {
  restApi?: RestApi;
  restApiId?: Input<string>;
  resourceId?: Input<string>;
  httpMethod: Input<string>;
  authorizationType?: Input<string>;
  authorizerId?: Input<string>;
  apiKeyRequired?: Input<boolean>;
  operationName?: Input<string>;
  requestParameters?: Input<MethodProps["requestParameters"]>;
  requestModels?: Input<MethodProps["requestModels"]>;
  requestValidatorId?: Input<string>;
  authorizationScopes?: Input<string[]>;
  integration?: Input<MethodIntegrationProps>;
}

const MethodImpl = (id: string, props: MethodInputProps) =>
  Effect.gen(function* () {
    const { restApi, ...rest } = props;
    const restApiId = rest.restApiId ?? restApi?.restApiId;
    const resourceId = rest.resourceId ?? restApi?.rootResourceId;
    if (!restApiId || !resourceId) {
      return yield* Effect.die(
        "Method requires either `restApi` (preferred) or explicit " +
          "`restApiId` and `resourceId`.",
      );
    }
    const method = yield* MethodResource(id, {
      ...rest,
      restApiId,
      resourceId,
    } as any);
    if (restApi) {
      yield* restApi.bind`${method}`({
        kind: "method",
        methodId: method.LogicalId,
        restApiId: method.restApiId,
        resourceId: method.resourceId,
        httpMethod: method.httpMethod,
      });
    }
    return method;
  });

/**
 * User-facing wrapper for the Method resource. Accepts `restApi: RestApi`
 * as the idiomatic way to attach a method — this both forwards the API id
 * and registers the method as a binding on the RestApi so the scheduler
 * orders `Deployment` after it.
 */
export const Method = MethodImpl;

const putIntegrationRequest = (
  restApiId: string,
  resourceId: string,
  httpMethod: string,
  integration: MethodIntegrationProps,
): ag.PutIntegrationRequest => ({
  restApiId,
  resourceId,
  httpMethod,
  type: integration.type,
  integrationHttpMethod: integration.integrationHttpMethod,
  uri: integration.uri as string,
  connectionType: integration.connectionType,
  connectionId: integration.connectionId,
  credentials: integration.credentials,
  requestParameters: integration.requestParameters,
  requestTemplates: integration.requestTemplates,
  passthroughBehavior: integration.passthroughBehavior,
  cacheNamespace: integration.cacheNamespace,
  cacheKeyParameters: integration.cacheKeyParameters,
  contentHandling: integration.contentHandling,
  timeoutInMillis: integration.timeoutInMillis,
  tlsConfig: integration.tlsConfig,
  responseTransferMode: integration.responseTransferMode,
  integrationTarget: integration.integrationTarget,
});

const putMethod = (news: Input.ResolveProps<MethodProps>) =>
  ag.putMethod({
    restApiId: news.restApiId as string,
    resourceId: news.resourceId as string,
    httpMethod: news.httpMethod,
    authorizationType: news.authorizationType ?? "NONE",
    authorizerId: news.authorizerId,
    apiKeyRequired: news.apiKeyRequired,
    operationName: news.operationName,
    requestParameters: news.requestParameters,
    requestModels: news.requestModels,
    requestValidatorId: news.requestValidatorId,
    authorizationScopes: news.authorizationScopes,
  });

const deleteIntegrationSafe = (p: {
  restApiId: string;
  resourceId: string;
  httpMethod: string;
}) =>
  ag
    .deleteIntegration({
      restApiId: p.restApiId,
      resourceId: p.resourceId,
      httpMethod: p.httpMethod,
    })
    .pipe(Effect.catchTag("NotFoundException", () => Effect.void));

const deleteMethodSafe = (p: {
  restApiId: string;
  resourceId: string;
  httpMethod: string;
}) =>
  ag
    .deleteMethod({
      restApiId: p.restApiId,
      resourceId: p.resourceId,
      httpMethod: p.httpMethod,
    })
    .pipe(Effect.catchTag("NotFoundException", () => Effect.void));

const readMethodSnapshot = (p: {
  restApiId: string;
  resourceId: string;
  httpMethod: string;
}) =>
  Effect.gen(function* () {
    const method = yield* ag
      .getMethod({
        restApiId: p.restApiId,
        resourceId: p.resourceId,
        httpMethod: p.httpMethod,
      })
      .pipe(
        Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
      );
    if (!method?.httpMethod) return undefined;

    const integ = yield* ag
      .getIntegration({
        restApiId: p.restApiId,
        resourceId: p.resourceId,
        httpMethod: p.httpMethod,
      })
      .pipe(
        Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
      );

    const integration: MethodIntegrationProps | undefined = integ?.type
      ? {
          type: integ.type!,
          integrationHttpMethod: integ.httpMethod,
          uri: integ.uri,
          connectionType: integ.connectionType,
          connectionId: integ.connectionId,
          credentials: integ.credentials,
          requestParameters: integ.requestParameters,
          requestTemplates: integ.requestTemplates,
          passthroughBehavior: integ.passthroughBehavior,
          cacheNamespace: integ.cacheNamespace,
          cacheKeyParameters: integ.cacheKeyParameters,
          contentHandling: integ.contentHandling,
          timeoutInMillis: integ.timeoutInMillis,
          tlsConfig: integ.tlsConfig,
          responseTransferMode: integ.responseTransferMode,
          integrationTarget: integ.integrationTarget,
        }
      : undefined;

    return {
      restApiId: p.restApiId,
      resourceId: p.resourceId,
      httpMethod: p.httpMethod,
      authorizationType: method.authorizationType ?? "NONE",
      authorizerId: method.authorizerId,
      apiKeyRequired: method.apiKeyRequired,
      operationName: method.operationName,
      requestParameters: method.requestParameters,
      requestModels: method.requestModels,
      requestValidatorId: method.requestValidatorId,
      authorizationScopes: method.authorizationScopes,
      integration,
    };
  });

export const MethodProvider = () =>
  Provider.effect(
    MethodResource,
    Effect.gen(function* () {
      return {
        stables: ["restApiId", "resourceId", "httpMethod"] as const,
        diff: Effect.fn(function* ({ news: newsIn, olds }) {
          if (!isResolved(newsIn)) return;
          const news = newsIn as Input.ResolveProps<MethodProps>;
          if (
            news.restApiId !== olds.restApiId ||
            news.resourceId !== olds.resourceId ||
            news.httpMethod !== olds.httpMethod
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output) return undefined;
          return yield* readMethodSnapshot({
            restApiId: output.restApiId,
            resourceId: output.resourceId,
            httpMethod: output.httpMethod,
          });
        }),
        reconcile: Effect.fn(function* ({ news: newsIn, output, session }) {
          if (!isResolved(newsIn)) {
            return yield* Effect.die("Method props were not resolved");
          }
          const news = newsIn as Input.ResolveProps<MethodProps>;
          const authType = news.authorizationType ?? "NONE";
          // Methods are keyed by (restApiId, resourceId, httpMethod). All
          // three are stable across the resource's lifetime, so we read
          // them out of `output` when present and fall back to `news`.
          const restApiId = (output?.restApiId ?? news.restApiId) as string;
          const resourceId = (output?.resourceId ?? news.resourceId) as string;
          const httpMethod = output?.httpMethod ?? news.httpMethod;

          // Observe — read live method + integration as a single snapshot.
          // `output.*` fields are never trusted as proxies for cloud state;
          // they're at most a cache for the natural-key tuple above.
          let observed = yield* readMethodSnapshot({
            restApiId,
            resourceId,
            httpMethod,
          });

          // Ensure — putMethod creates the method shape (auth type,
          // request models, scopes, etc.). Some of those fields cannot be
          // patched in place by `updateMethod`, so on a "recreate-needed"
          // diff we drop the existing method and re-put. This is also the
          // path used on first reconcile when nothing exists.
          const needsRecreate =
            observed !== undefined &&
            (news.operationName !== observed.operationName ||
              !deepEqual(news.requestParameters, observed.requestParameters) ||
              !deepEqual(news.requestModels, observed.requestModels) ||
              news.requestValidatorId !== observed.requestValidatorId ||
              !deepEqual(
                news.authorizationScopes,
                observed.authorizationScopes,
              ));

          if (observed === undefined || needsRecreate) {
            if (needsRecreate) {
              yield* deleteIntegrationSafe({
                restApiId,
                resourceId,
                httpMethod,
              });
              yield* deleteMethodSafe({ restApiId, resourceId, httpMethod });
            }
            yield* putMethod({
              ...news,
              restApiId,
              resourceId,
              httpMethod,
            });
            if (news.integration) {
              yield* ag.putIntegration(
                putIntegrationRequest(
                  restApiId,
                  resourceId,
                  httpMethod,
                  news.integration,
                ),
              );
            }
            yield* session.note(
              needsRecreate
                ? `Recreated method ${httpMethod}`
                : `Put method ${httpMethod} on resource ${resourceId}`,
            );
            // Re-read to get the canonical observed state for the rest of
            // the reconciler. After a recreate everything matches `news`,
            // so the patch step below becomes a no-op.
            observed = yield* readMethodSnapshot({
              restApiId,
              resourceId,
              httpMethod,
            });
            if (!observed) {
              return yield* Effect.die("getMethod missing after put");
            }
          }

          // Sync patchable scalar fields — observed ↔ desired.
          const patches: ag.PatchOperation[] = [];
          if (authType !== observed.authorizationType) {
            patches.push({
              op: "replace",
              path: "/authorizationType",
              value: authType,
            });
          }
          if (news.authorizerId !== observed.authorizerId) {
            patches.push({
              op: "replace",
              path: "/authorizerId",
              value: news.authorizerId ?? "",
            });
          }
          if (news.apiKeyRequired !== observed.apiKeyRequired) {
            patches.push({
              op: "replace",
              path: "/apiKeyRequired",
              value: String(news.apiKeyRequired ?? false),
            });
          }
          if (patches.length > 0) {
            yield* ag.updateMethod({
              restApiId,
              resourceId,
              httpMethod,
              patchOperations: patches,
            });
          }

          // Sync integration — putIntegration is an upsert; deleteIntegration
          // tolerates missing integrations.
          if (!deepEqual(news.integration, observed.integration)) {
            if (news.integration) {
              yield* ag.putIntegration(
                putIntegrationRequest(
                  restApiId,
                  resourceId,
                  httpMethod,
                  news.integration,
                ),
              );
            } else {
              yield* deleteIntegrationSafe({
                restApiId,
                resourceId,
                httpMethod,
              });
            }
          }

          yield* session.note(`Reconciled method ${httpMethod}`);
          const snap = yield* readMethodSnapshot({
            restApiId,
            resourceId,
            httpMethod,
          });
          if (!snap) {
            return yield* Effect.die("getMethod missing after reconcile");
          }
          return snap;
        }),
        delete: Effect.fn(function* ({ output, session }) {
          yield* deleteIntegrationSafe({
            restApiId: output.restApiId,
            resourceId: output.resourceId,
            httpMethod: output.httpMethod,
          });
          yield* deleteMethodSafe({
            restApiId: output.restApiId,
            resourceId: output.resourceId,
            httpMethod: output.httpMethod,
          });
          yield* session.note(`Deleted method ${output.httpMethod}`);
        }),
      };
    }),
  );
