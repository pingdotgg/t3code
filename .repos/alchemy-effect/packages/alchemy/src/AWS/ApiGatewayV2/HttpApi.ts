import * as agw2 from "@distilled.cloud/aws/apigatewayv2";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type { Input } from "../../Input.ts";
import * as Namespace from "../../Namespace.ts";
import * as Output from "../../Output.ts";
import { Permission } from "../Lambda/Permission.ts";
import { Api } from "./Api.ts";
import { Integration } from "./Integration.ts";
import { Route } from "./Route.ts";
import { Stage } from "./Stage.ts";

/**
 * The Lambda function an {@link HttpApi} fronts. Structural on purpose —
 * any resource exposing `functionArn`/`functionName` outputs (an
 * `AWS.Lambda.Function`) qualifies.
 */
export interface HttpApiHandler {
  /** The logical ID of the handler function. */
  readonly LogicalId: string;
  /** ARN of the Lambda function that serves requests. */
  readonly functionArn: Output.Output<string>;
  /** Name of the Lambda function that serves requests. */
  readonly functionName: Output.Output<string>;
}

export interface HttpApiProps {
  /**
   * The Lambda function that serves every request (`$default` route,
   * `AWS_PROXY` integration, payload format 2.0 — the same event shape as
   * Lambda Function URLs).
   */
  handler: HttpApiHandler;
  /**
   * Name of the API. If omitted, Alchemy generates a deterministic
   * physical name.
   */
  name?: Input<string>;
  /** Description of the API. */
  description?: Input<string>;
  /** CORS configuration. */
  cors?: Input<agw2.Cors>;
  /**
   * Disable the default `execute-api` endpoint (serve only via custom
   * domains).
   */
  disableExecuteApiEndpoint?: Input<boolean>;
  /**
   * The stage name to deploy. `$default` serves at the API root.
   * @default "$default"
   */
  stageName?: Input<string>;
  /**
   * Integration timeout (e.g. `"29 seconds"`; a bare number is
   * milliseconds, 50–30000). Sent to the API in whole milliseconds
   * (`TimeoutInMillis`).
   * @default 30 seconds
   */
  timeout?: Input<Duration.Input>;
  /** User-defined tags for the API and stage. */
  tags?: Record<string, string>;
}

/**
 * The flagship HTTP API → Lambda front door: composes an {@link Api}
 * (HTTP), an `AWS_PROXY` {@link Integration} (payload 2.0), a `$default`
 * {@link Route}, an auto-deployed {@link Stage}, and the API Gateway
 * invoke `Permission` in one call.
 *
 * The Lambda receives the same event shape as a Function URL, so an
 * Effect-native `fetch` handler works unchanged behind the API.
 *
 * @section Creating an HTTP API
 * @example Front a Lambda function
 * ```typescript
 * const fn = yield* MyFunction;
 * const { url } = yield* ApiGatewayV2.HttpApi("Api", { handler: fn });
 * // url -> https://{apiId}.execute-api.{region}.amazonaws.com
 * ```
 *
 * @example With CORS and a named stage
 * ```typescript
 * const { api, stage, url } = yield* ApiGatewayV2.HttpApi("Api", {
 *   handler: fn,
 *   stageName: "prod",
 *   cors: { AllowOrigins: ["*"], AllowMethods: ["*"] },
 * });
 * ```
 */
export const HttpApi = (id: string, props: HttpApiProps) =>
  Namespace.push(
    id,
    Effect.gen(function* () {
      const api = yield* Api("Api", {
        name: props.name,
        protocolType: "HTTP",
        description: props.description,
        corsConfiguration: props.cors,
        disableExecuteApiEndpoint: props.disableExecuteApiEndpoint,
        tags: props.tags,
      } as any);

      const integration = yield* Integration("Integration", {
        api,
        integrationType: "AWS_PROXY",
        integrationUri: props.handler.functionArn,
        payloadFormatVersion: "2.0",
        timeout: props.timeout,
      });

      yield* Route("Default", {
        api,
        routeKey: "$default",
        integration,
      });

      const stage = yield* Stage("Stage", {
        api,
        stageName: props.stageName ?? "$default",
        autoDeploy: true,
        tags: props.tags,
      });

      yield* Permission("Permission", {
        action: "lambda:InvokeFunction",
        functionName: props.handler.functionName,
        principal: "apigateway.amazonaws.com",
        sourceArn: Output.map(
          Output.all(props.handler.functionArn, api.apiId),
          ([fnArn, apiId]: [string, string]) => {
            const [, , , region, accountId] = fnArn.split(":");
            return `arn:aws:execute-api:${region}:${accountId}:${apiId}/*`;
          },
        ),
      } as any);

      return {
        /** The underlying HTTP {@link Api}. */
        api,
        /** The underlying {@link Integration}. */
        integration,
        /** The auto-deployed {@link Stage}. */
        stage,
        /** The URL clients call. */
        url: stage.invokeUrl,
      };
    }),
  );
