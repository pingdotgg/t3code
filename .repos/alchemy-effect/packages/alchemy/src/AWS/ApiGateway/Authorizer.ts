import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Effect from "effect/Effect";
import { deepEqual, isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface AuthorizerProps {
  /**
   * REST API identifier that owns the authorizer.
   */
  restApiId: Input<string>;
  /**
   * Authorizer name.
   *
   * If omitted, Alchemy generates a deterministic physical name.
   */
  name?: string;
  /**
   * Authorizer type.
   */
  type: ag.AuthorizerType;
  /**
   * Cognito user pool ARNs for `COGNITO_USER_POOLS` authorizers.
   */
  providerARNs?: string[];
  /**
   * Custom authorization type label.
   */
  authType?: string;
  /**
   * Lambda invocation URI for `TOKEN` or `REQUEST` authorizers.
   */
  authorizerUri?: string;
  /**
   * IAM role ARN used by API Gateway to invoke the authorizer.
   *
   * This is not secret key material; API Gateway stores the role ARN.
   */
  authorizerCredentials?: string;
  /**
   * Identity source expression, e.g. `method.request.header.Authorization`.
   */
  identitySource?: string;
  /**
   * Validation regex for token authorizers.
   */
  identityValidationExpression?: string;
  /**
   * Cache TTL for authorizer results, in seconds.
   */
  authorizerResultTtlInSeconds?: number;
}

export interface Authorizer extends Resource<
  "AWS.ApiGateway.Authorizer",
  AuthorizerProps,
  {
    authorizerId: string;
    restApiId: string;
    name: string;
    type: ag.AuthorizerType;
  },
  never,
  Providers
> {}

/**
 * REST API Lambda, Cognito, or gateway authorizer.
 *
 * @section Authorizers
 * @example Lambda TOKEN authorizer
 * ```typescript
 * const authorizer = yield* ApiGateway.Authorizer("Auth", {
 *   restApiId: api.restApiId,
 *   type: "TOKEN",
 *   authorizerUri: authorizerInvokeArn,
 *   identitySource: "method.request.header.Authorization",
 * });
 * ```
 */
const AuthorizerResource = Resource<Authorizer>("AWS.ApiGateway.Authorizer");

export { AuthorizerResource as Authorizer };

const generatedName = (id: string, props: AuthorizerProps) =>
  props.name
    ? Effect.succeed(props.name)
    : createPhysicalName({
        id,
        maxLength: 128,
      });

export const AuthorizerProvider = () =>
  Provider.effect(
    AuthorizerResource,
    Effect.gen(function* () {
      return {
        stables: ["authorizerId", "restApiId"] as const,
        diff: Effect.fn(function* ({ news: newsIn, olds }) {
          if (!isResolved(newsIn)) return;
          const news = newsIn as AuthorizerProps;
          if (
            // These fields define the authorizer identity and kind; replacement
            // avoids patching a different authorizer shape in place.
            news.restApiId !== olds.restApiId ||
            (news.name !== undefined && news.name !== olds.name) ||
            news.type !== olds.type
          ) {
            return { action: "replace" } as const;
          }
          if (!deepEqual(news.providerARNs, olds.providerARNs)) {
            return { action: "replace" } as const;
          }
          if (news.authType !== olds.authType) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.authorizerId) return undefined;
          const a = yield* ag
            .getAuthorizer({
              restApiId: output.restApiId,
              authorizerId: output.authorizerId,
            })
            .pipe(
              Effect.catchTag("NotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (!a?.id) return undefined;
          return {
            authorizerId: a.id,
            restApiId: output.restApiId,
            name: a.name!,
            type: a.type!,
          };
        }),
        reconcile: Effect.fn(function* ({ id, news: newsIn, output, session }) {
          if (!isResolved(newsIn)) {
            return yield* Effect.die("Authorizer props were not resolved");
          }
          const news = newsIn as Input.ResolveProps<AuthorizerProps>;
          const name = yield* generatedName(id, news);
          const restApiId = (output?.restApiId ?? news.restApiId) as string;

          // Observe — fetch the live authorizer if we have a cached id.
          // The cached id is the only way to find the resource; on a stale
          // delete out of band we re-create.
          let observed = output?.authorizerId
            ? yield* ag
                .getAuthorizer({
                  restApiId,
                  authorizerId: output.authorizerId,
                })
                .pipe(
                  Effect.catchTag("NotFoundException", () =>
                    Effect.succeed(undefined),
                  ),
                )
            : undefined;

          // Ensure — create if missing.
          if (!observed?.id) {
            const created = yield* ag.createAuthorizer({
              restApiId: news.restApiId as string,
              name,
              type: news.type,
              providerARNs: news.providerARNs,
              authType: news.authType,
              authorizerUri: news.authorizerUri,
              authorizerCredentials: news.authorizerCredentials,
              identitySource: news.identitySource,
              identityValidationExpression: news.identityValidationExpression,
              authorizerResultTtlInSeconds: news.authorizerResultTtlInSeconds,
            });
            if (!created.id)
              return yield* Effect.die("createAuthorizer missing id");
            yield* session.note(`Created authorizer ${created.id}`);
            observed = yield* ag.getAuthorizer({
              restApiId: news.restApiId as string,
              authorizerId: created.id,
            });
          }

          const authorizerId = observed.id!;

          // Sync mutable fields — diff observed cloud state against desired.
          const patches: ag.PatchOperation[] = [];
          if (news.authorizerUri !== observed.authorizerUri) {
            patches.push({
              op: news.authorizerUri === undefined ? "remove" : "replace",
              path: "/authorizerUri",
              value: news.authorizerUri,
            });
          }
          if (news.identitySource !== observed.identitySource) {
            patches.push({
              op: news.identitySource === undefined ? "remove" : "replace",
              path: "/identitySource",
              value: news.identitySource,
            });
          }
          if (news.authorizerCredentials !== observed.authorizerCredentials) {
            patches.push({
              op:
                news.authorizerCredentials === undefined ? "remove" : "replace",
              path: "/authorizerCredentials",
              value: news.authorizerCredentials,
            });
          }
          if (
            news.identityValidationExpression !==
            observed.identityValidationExpression
          ) {
            patches.push({
              op:
                news.identityValidationExpression === undefined
                  ? "remove"
                  : "replace",
              path: "/identityValidationExpression",
              value: news.identityValidationExpression,
            });
          }
          if (
            news.authorizerResultTtlInSeconds !==
            observed.authorizerResultTtlInSeconds
          ) {
            patches.push({
              op:
                news.authorizerResultTtlInSeconds === undefined
                  ? "remove"
                  : "replace",
              path: "/authorizerResultTtlInSeconds",
              value:
                news.authorizerResultTtlInSeconds === undefined
                  ? undefined
                  : String(news.authorizerResultTtlInSeconds),
            });
          }
          if (patches.length > 0) {
            yield* ag.updateAuthorizer({
              restApiId,
              authorizerId,
              patchOperations: patches,
            });
          }

          yield* session.note(`Reconciled authorizer ${authorizerId}`);
          const final = yield* ag.getAuthorizer({
            restApiId,
            authorizerId,
          });
          return {
            authorizerId,
            restApiId,
            name: final.name!,
            type: final.type!,
          };
        }),
        delete: Effect.fn(function* ({ output, session }) {
          yield* ag
            .deleteAuthorizer({
              restApiId: output.restApiId,
              authorizerId: output.authorizerId,
            })
            .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
          yield* session.note(`Deleted authorizer ${output.authorizerId}`);
        }),
      };
    }),
  );
