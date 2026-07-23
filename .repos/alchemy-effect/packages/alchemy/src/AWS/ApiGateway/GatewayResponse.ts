import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { retryOnApiStatusUpdating } from "./common.ts";

export interface GatewayResponseProps {
  restApiId: Input<string>;
  responseType: ag.GatewayResponseType;
  statusCode?: string;
  responseParameters?: { [key: string]: string | undefined };
  responseTemplates?: { [key: string]: string | undefined };
}

export interface GatewayResponse extends Resource<
  "AWS.ApiGateway.GatewayResponse",
  GatewayResponseProps,
  {
    restApiId: string;
    responseType: ag.GatewayResponseType;
    statusCode: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Gateway response mapping for a REST API (e.g. DEFAULT_4XX, DEFAULT_5XX).
 *
 * @section Gateway responses
 * @example Default 4xx JSON body
 * ```typescript
 * yield* ApiGateway.GatewayResponse("Default4xx", {
 *   restApiId: api.restApiId,
 *   responseType: "DEFAULT_4XX",
 *   responseTemplates: { "application/json": '{"message":$context.error.messageString}' },
 * });
 * ```
 */
const GatewayResponseResource = Resource<GatewayResponse>(
  "AWS.ApiGateway.GatewayResponse",
);

export { GatewayResponseResource as GatewayResponse };

export const GatewayResponseProvider = () =>
  Provider.effect(
    GatewayResponseResource,
    Effect.gen(function* () {
      return {
        stables: ["restApiId", "responseType"] as const,
        diff: Effect.fn(function* ({ news: newsIn, olds }) {
          if (!isResolved(newsIn)) return;
          const news = newsIn as Input.ResolveProps<GatewayResponseProps>;
          if (
            news.restApiId !== olds.restApiId ||
            news.responseType !== olds.responseType
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output) return undefined;
          const g = yield* ag
            .getGatewayResponse({
              restApiId: output.restApiId,
              responseType: output.responseType,
            })
            .pipe(
              Effect.catchTag("NotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (!g?.responseType) return undefined;
          return {
            restApiId: output.restApiId,
            responseType: g.responseType!,
            statusCode: g.statusCode,
          };
        }),
        reconcile: Effect.fn(function* ({ news: newsIn, output, session }) {
          if (!isResolved(newsIn)) {
            return yield* Effect.die("GatewayResponse props were not resolved");
          }
          const news = newsIn as Input.ResolveProps<GatewayResponseProps>;
          const restApiId = (output?.restApiId ?? news.restApiId) as string;
          const responseType = output?.responseType ?? news.responseType;

          // Observe + Ensure + Sync as one atomic op.
          // `putGatewayResponse` is an upsert: it creates the response if
          // missing, replaces it if present. The reconciler is therefore a
          // single put against the desired state regardless of whether
          // `output` exists.
          yield* retryOnApiStatusUpdating(
            ag.putGatewayResponse({
              restApiId,
              responseType,
              statusCode: news.statusCode,
              responseParameters: news.responseParameters,
              responseTemplates: news.responseTemplates,
            }),
          );
          yield* session.note(
            `Reconciled gateway response ${responseType} on ${restApiId}`,
          );
          return {
            restApiId,
            responseType,
            statusCode: news.statusCode,
          };
        }),
        delete: Effect.fn(function* ({ output, session }) {
          yield* retryOnApiStatusUpdating(
            ag
              .deleteGatewayResponse({
                restApiId: output.restApiId,
                responseType: output.responseType,
              })
              .pipe(Effect.catchTag("NotFoundException", () => Effect.void)),
          );
          yield* session.note(
            `Deleted gateway response ${output.responseType}`,
          );
        }),
      };
    }),
  );
