import * as agw2 from "@distilled.cloud/aws/apigatewayv2";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { deepEqual, isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { toWireMillis } from "../../Util/Duration.ts";
import type { Providers } from "../Providers.ts";
import type { Api } from "./Api.ts";
import { collectAllPages, retryOnTooManyRequests } from "./common.ts";

export interface IntegrationProps {
  /**
   * ID of the API this integration belongs to. Usually derived from
   * `api.apiId` by the {@link Integration} wrapper.
   */
  apiId: string;
  /**
   * The integration type. `AWS_PROXY` (Lambda proxy) is the common case
   * for both HTTP and WebSocket APIs; `HTTP_PROXY` forwards to an HTTP
   * endpoint; `MOCK` (WebSocket only) returns a static response.
   */
  integrationType: agw2.IntegrationType;
  /**
   * The integration endpoint:
   *
   * - `AWS_PROXY` on an HTTP API — the Lambda function ARN.
   * - `AWS_PROXY` on a WebSocket API — the full invocation URI
   *   (`arn:aws:apigateway:{region}:lambda:path/2015-03-31/functions/{functionArn}/invocations`).
   * - `HTTP_PROXY` — the HTTP URL.
   * - private integrations — the ELB listener / Cloud Map service ARN.
   */
  integrationUri?: string;
  /**
   * The HTTP method the integration uses when calling the backend
   * (`POST` for Lambda; for `HTTP_PROXY` routes usually `ANY`).
   */
  integrationMethod?: string;
  /**
   * The Lambda event payload format for HTTP API `AWS_PROXY` integrations.
   * `2.0` is the modern shape (same as Lambda Function URLs).
   * @default "2.0" for HTTP AWS_PROXY (AWS defaults to "1.0" — the wrapper does not override; set explicitly)
   */
  payloadFormatVersion?: string;
  /**
   * `INTERNET` (default) or `VPC_LINK` for private integrations.
   */
  connectionType?: agw2.ConnectionType;
  /**
   * The VPC link ID when `connectionType` is `VPC_LINK`.
   */
  connectionId?: string;
  /**
   * IAM credentials ARN for the integration (or
   * `arn:aws:iam::*:user/*` to use caller credentials).
   */
  credentialsArn?: string;
  /** Description of the integration. */
  description?: string;
  /**
   * AWS service integration subtype (e.g. `SQS-SendMessage`) for
   * first-class AWS service integrations on HTTP APIs.
   */
  integrationSubtype?: string;
  /** Passthrough behavior (WebSocket APIs only). */
  passthroughBehavior?: agw2.PassthroughBehavior;
  /** Request parameter mappings. */
  requestParameters?: { [key: string]: string | undefined };
  /** Request templates (WebSocket APIs only). */
  requestTemplates?: { [key: string]: string | undefined };
  /** Response parameter mappings (HTTP APIs). */
  responseParameters?: {
    [key: string]: { [key: string]: string | undefined } | undefined;
  };
  /** Template selection expression (WebSocket APIs only). */
  templateSelectionExpression?: string;
  /**
   * Integration timeout (e.g. `"29 seconds"` or `Duration.seconds(29)`;
   * a bare number is milliseconds). 50–29000 ms for WebSocket APIs,
   * 50–30000 ms for HTTP APIs. Sent to the API in whole milliseconds
   * (`TimeoutInMillis`).
   */
  timeout?: Duration.Input;
  /** TLS configuration for private integrations. */
  tlsConfig?: agw2.TlsConfigInput;
  /** Content handling strategy (WebSocket APIs only). */
  contentHandlingStrategy?: agw2.ContentHandlingStrategy;
}

export interface IntegrationType extends Resource<
  "AWS.ApiGatewayV2.Integration",
  IntegrationProps,
  {
    /** The API this integration belongs to. */
    apiId: string;
    /** The integration identifier. */
    integrationId: string;
    integrationType: agw2.IntegrationType;
    integrationUri: string | undefined;
    integrationMethod: string | undefined;
    payloadFormatVersion: string | undefined;
    connectionType: agw2.ConnectionType | undefined;
    connectionId: string | undefined;
    credentialsArn: string | undefined;
    description: string | undefined;
    integrationSubtype: string | undefined;
    passthroughBehavior: agw2.PassthroughBehavior | undefined;
    requestParameters: { [key: string]: string | undefined } | undefined;
    requestTemplates: { [key: string]: string | undefined } | undefined;
    responseParameters:
      | { [key: string]: { [key: string]: string | undefined } | undefined }
      | undefined;
    templateSelectionExpression: string | undefined;
    timeoutInMillis: number | undefined;
    contentHandlingStrategy: agw2.ContentHandlingStrategy | undefined;
  },
  never,
  Providers
> {}

/**
 * An API Gateway v2 Integration — the backend target a Route forwards to.
 *
 * For HTTP APIs the common integration is `AWS_PROXY` with payload format
 * `2.0`, pointing directly at a Lambda function ARN. For WebSocket APIs the
 * `integrationUri` must be the full Lambda invocation URI.
 * @resource
 * @section Lambda proxy integration (HTTP API)
 * @example AWS_PROXY integration with payload 2.0
 * ```typescript
 * const integration = yield* ApiGatewayV2.Integration("Fn", {
 *   api,
 *   integrationType: "AWS_PROXY",
 *   integrationUri: fn.functionArn,
 *   payloadFormatVersion: "2.0",
 * });
 * ```
 *
 * @section HTTP proxy integration
 * @example Forward to an external HTTP endpoint
 * ```typescript
 * const integration = yield* ApiGatewayV2.Integration("Upstream", {
 *   api,
 *   integrationType: "HTTP_PROXY",
 *   integrationUri: "https://example.com/{proxy}",
 *   integrationMethod: "ANY",
 *   payloadFormatVersion: "1.0",
 * });
 * ```
 */
export const IntegrationResource = Resource<IntegrationType>(
  "AWS.ApiGatewayV2.Integration",
);

export interface IntegrationInputProps extends Omit<
  {
    [K in keyof IntegrationProps]?: Input<IntegrationProps[K]>;
  },
  "apiId" | "integrationType"
> {
  /**
   * The `Api` this integration belongs to (preferred). Alternatively pass
   * a raw `apiId`.
   */
  api?: Api;
  apiId?: Input<string>;
  integrationType: Input<agw2.IntegrationType>;
}

/**
 * User-facing wrapper for the Integration resource. Accepts `api: Api` as
 * the idiomatic way to attach an integration to an API.
 */
export const Integration = (id: string, props: IntegrationInputProps) =>
  Effect.gen(function* () {
    const { api, ...rest } = props;
    const apiId = rest.apiId ?? api?.apiId;
    if (!apiId) {
      return yield* Effect.die(
        "Integration requires either `api` (preferred) or an explicit `apiId`.",
      );
    }
    return yield* IntegrationResource(id, { ...rest, apiId } as any);
  });

const snapshotFromIntegration = (
  apiId: string,
  integ: agw2.GetIntegrationResult,
): IntegrationType["Attributes"] => ({
  apiId,
  integrationId: integ.IntegrationId!,
  integrationType: integ.IntegrationType ?? "AWS_PROXY",
  integrationUri: integ.IntegrationUri,
  integrationMethod: integ.IntegrationMethod,
  payloadFormatVersion: integ.PayloadFormatVersion,
  connectionType: integ.ConnectionType,
  connectionId: integ.ConnectionId,
  credentialsArn: integ.CredentialsArn,
  description: integ.Description,
  integrationSubtype: integ.IntegrationSubtype,
  passthroughBehavior: integ.PassthroughBehavior,
  requestParameters: integ.RequestParameters,
  requestTemplates: integ.RequestTemplates,
  responseParameters: integ.ResponseParameters,
  templateSelectionExpression: integ.TemplateSelectionExpression,
  timeoutInMillis: integ.TimeoutInMillis,
  contentHandlingStrategy: integ.ContentHandlingStrategy,
});

const desiredRequest = (news: IntegrationProps) => ({
  IntegrationType: news.integrationType,
  IntegrationUri: news.integrationUri,
  IntegrationMethod: news.integrationMethod,
  PayloadFormatVersion: news.payloadFormatVersion,
  ConnectionType: news.connectionType,
  ConnectionId: news.connectionId,
  CredentialsArn: news.credentialsArn,
  Description: news.description,
  IntegrationSubtype: news.integrationSubtype,
  PassthroughBehavior: news.passthroughBehavior,
  RequestParameters: news.requestParameters,
  RequestTemplates: news.requestTemplates,
  ResponseParameters: news.responseParameters,
  TemplateSelectionExpression: news.templateSelectionExpression,
  TimeoutInMillis: toWireMillis(news.timeout),
  TlsConfig: news.tlsConfig,
  ContentHandlingStrategy: news.contentHandlingStrategy,
});

export const IntegrationProvider = () =>
  Provider.effect(
    IntegrationResource,
    Effect.gen(function* () {
      const getIntegrationSafe = (apiId: string, integrationId: string) =>
        agw2
          .getIntegration({ ApiId: apiId, IntegrationId: integrationId })
          .pipe(
            Effect.catchTag("NotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      return IntegrationResource.Provider.of({
        stables: ["apiId", "integrationId"],

        list: () =>
          Effect.gen(function* () {
            const apis = yield* collectAllPages((NextToken) =>
              agw2.getApis({ NextToken }),
            );
            const perApi = yield* Effect.forEach(
              apis.filter((api) => api.ApiId != null),
              (api) =>
                collectAllPages((NextToken) =>
                  agw2.getIntegrations({ ApiId: api.ApiId!, NextToken }),
                ).pipe(
                  Effect.map((items) =>
                    items
                      .filter((integ) => integ.IntegrationId != null)
                      .map((integ) =>
                        snapshotFromIntegration(api.ApiId!, integ),
                      ),
                  ),
                  // API deleted between list and getIntegrations — skip it.
                  Effect.catchTag("NotFoundException", () =>
                    Effect.succeed([] as IntegrationType["Attributes"][]),
                  ),
                ),
              { concurrency: 5 },
            );
            return perApi.flat();
          }),

        read: Effect.fn(function* ({ output }) {
          if (!output?.apiId || !output.integrationId) return undefined;
          const integ = yield* getIntegrationSafe(
            output.apiId,
            output.integrationId,
          );
          if (!integ?.IntegrationId) return undefined;
          return snapshotFromIntegration(output.apiId, integ);
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (news.apiId !== olds.apiId) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ news, output, session }) {
          const apiId = output?.apiId ?? news.apiId;

          // 1. OBSERVE
          let observed = output?.integrationId
            ? yield* getIntegrationSafe(apiId, output.integrationId)
            : undefined;

          // 2. ENSURE
          if (!observed?.IntegrationId) {
            observed = yield* retryOnTooManyRequests(
              agw2.createIntegration({ ApiId: apiId, ...desiredRequest(news) }),
            );
            yield* session.note(
              `Created integration ${observed.IntegrationId}`,
            );
            return snapshotFromIntegration(apiId, observed);
          }

          // 3. SYNC — compare the observed snapshot against desired and
          //    update only on drift.
          const snapshot = snapshotFromIntegration(apiId, observed);
          const desired = desiredRequest(news);
          const drift =
            snapshot.integrationType !== desired.IntegrationType ||
            snapshot.integrationUri !== desired.IntegrationUri ||
            snapshot.integrationMethod !== desired.IntegrationMethod ||
            (desired.PayloadFormatVersion !== undefined &&
              snapshot.payloadFormatVersion !== desired.PayloadFormatVersion) ||
            (desired.ConnectionType !== undefined &&
              snapshot.connectionType !== desired.ConnectionType) ||
            snapshot.connectionId !== desired.ConnectionId ||
            snapshot.credentialsArn !== desired.CredentialsArn ||
            snapshot.description !== desired.Description ||
            snapshot.integrationSubtype !== desired.IntegrationSubtype ||
            (desired.PassthroughBehavior !== undefined &&
              snapshot.passthroughBehavior !== desired.PassthroughBehavior) ||
            (desired.RequestParameters !== undefined &&
              !deepEqual(
                snapshot.requestParameters,
                desired.RequestParameters,
              )) ||
            (desired.RequestTemplates !== undefined &&
              !deepEqual(
                snapshot.requestTemplates,
                desired.RequestTemplates,
              )) ||
            (desired.ResponseParameters !== undefined &&
              !deepEqual(
                snapshot.responseParameters,
                desired.ResponseParameters,
              )) ||
            snapshot.templateSelectionExpression !==
              desired.TemplateSelectionExpression ||
            (desired.TimeoutInMillis !== undefined &&
              snapshot.timeoutInMillis !== desired.TimeoutInMillis) ||
            (desired.ContentHandlingStrategy !== undefined &&
              snapshot.contentHandlingStrategy !==
                desired.ContentHandlingStrategy);
          if (drift) {
            const updated = yield* retryOnTooManyRequests(
              agw2.updateIntegration({
                ApiId: apiId,
                IntegrationId: snapshot.integrationId,
                ...desired,
              }),
            );
            yield* session.note(
              `Updated integration ${snapshot.integrationId}`,
            );
            return snapshotFromIntegration(apiId, updated);
          }

          return snapshot;
        }),

        delete: Effect.fn(function* ({ output, session }) {
          yield* retryOnTooManyRequests(
            agw2
              .deleteIntegration({
                ApiId: output.apiId,
                IntegrationId: output.integrationId,
              })
              .pipe(Effect.catchTag("NotFoundException", () => Effect.void)),
          );
          yield* session.note(`Deleted integration ${output.integrationId}`);
        }),
      });
    }),
  );
