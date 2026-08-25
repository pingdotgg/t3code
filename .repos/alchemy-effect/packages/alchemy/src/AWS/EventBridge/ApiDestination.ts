import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { AccountID } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import type { RegionID } from "../Region.ts";

export type {
  ApiDestinationHttpMethod,
  ApiDestinationState,
} from "@distilled.cloud/aws/eventbridge";

export type ApiDestinationName = string;
export type ApiDestinationArn =
  `arn:aws:events:${RegionID}:${AccountID}:api-destination/${ApiDestinationName}/${string}`;

export interface ApiDestinationProps {
  /**
   * Name of the API destination. Must match [\.\-_A-Za-z0-9]+, 1-64
   * characters. If omitted, a unique name will be generated.
   */
  name?: ApiDestinationName;

  /**
   * Description of the API destination. Max 512 characters.
   */
  description?: string;

  /**
   * ARN of the {@link Connection} providing the endpoint's authorization.
   */
  connectionArn: string;

  /**
   * The HTTPS endpoint EventBridge invokes for events routed to this API
   * destination.
   */
  invocationEndpoint: string;

  /**
   * The HTTP method used against the endpoint.
   */
  httpMethod: eventbridge.ApiDestinationHttpMethod;

  /**
   * Maximum invocations per second EventBridge sends to the endpoint. The
   * unit (per second) is part of the AWS field's semantics — this is a rate
   * limit, not a duration.
   * @default 300
   */
  invocationRateLimitPerSecond?: number;
}

/**
 * An Amazon EventBridge API destination — an HTTPS endpoint configured as an
 * event target, invoked with the authorization held by a {@link Connection}.
 *
 * API destinations do not support tags, so ownership is tracked by the
 * deterministic physical name.
 * @resource
 * @section Connecting to APIs
 * @example Webhook API Destination
 * ```typescript
 * const destination = yield* AWS.EventBridge.ApiDestination("Webhook", {
 *   connectionArn: connection.connectionArn,
 *   invocationEndpoint: "https://hooks.example.com/events",
 *   httpMethod: "POST",
 * });
 * ```
 *
 * @example Rate-Limited API Destination as a Rule Target
 * ```typescript
 * const destination = yield* AWS.EventBridge.ApiDestination("SlowApi", {
 *   connectionArn: connection.connectionArn,
 *   invocationEndpoint: "https://api.example.com/ingest",
 *   httpMethod: "POST",
 *   invocationRateLimitPerSecond: 10,
 * });
 *
 * const rule = yield* AWS.EventBridge.Rule("ToApi", {
 *   eventPattern: { source: ["my.app"] },
 *   targets: [{
 *     Id: "Api",
 *     Arn: destination.apiDestinationArn,
 *     RoleArn: role.roleArn,
 *   }],
 * });
 * ```
 */
export interface ApiDestination extends Resource<
  "AWS.EventBridge.ApiDestination",
  ApiDestinationProps,
  {
    /** The name of the API destination. */
    apiDestinationName: ApiDestinationName;
    /** The ARN of the API destination. */
    apiDestinationArn: ApiDestinationArn;
    /** The state of the API destination (`ACTIVE` or `INACTIVE`). */
    apiDestinationState: eventbridge.ApiDestinationState;
  },
  never,
  Providers
> {}
export const ApiDestination = Resource<ApiDestination>(
  "AWS.EventBridge.ApiDestination",
);

export const ApiDestinationProvider = () =>
  Provider.effect(
    ApiDestination,
    Effect.gen(function* () {
      const createDestinationName = (
        id: string,
        props: { name?: string } = {},
      ) =>
        props.name
          ? Effect.succeed(props.name)
          : createPhysicalName({
              id,
              maxLength: 64,
            });

      return {
        stables: ["apiDestinationName", "apiDestinationArn"],
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return;
          const oldName = yield* createDestinationName(id, olds);
          const newName = yield* createDestinationName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          // API destinations don't support tags; the deterministic physical
          // name is the ownership signal (it embeds app/stage/logical id).
          const name =
            output?.apiDestinationName ??
            (yield* createDestinationName(id, olds ?? {}));
          const described = yield* eventbridge
            .describeApiDestination({ Name: name })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (!described?.Name || !described.ApiDestinationArn) {
            return undefined;
          }
          return {
            apiDestinationName: described.Name,
            apiDestinationArn: described.ApiDestinationArn as ApiDestinationArn,
            apiDestinationState: described.ApiDestinationState ?? "ACTIVE",
          };
        }),
        list: () =>
          Effect.gen(function* () {
            const attrs: {
              apiDestinationName: ApiDestinationName;
              apiDestinationArn: ApiDestinationArn;
              apiDestinationState: eventbridge.ApiDestinationState;
            }[] = [];
            let nextToken: string | undefined;
            do {
              const page = yield* eventbridge.listApiDestinations({
                NextToken: nextToken,
              });
              for (const destination of page.ApiDestinations ?? []) {
                if (!destination.Name || !destination.ApiDestinationArn) {
                  continue;
                }
                attrs.push({
                  apiDestinationName: destination.Name,
                  apiDestinationArn:
                    destination.ApiDestinationArn as ApiDestinationArn,
                  apiDestinationState:
                    destination.ApiDestinationState ?? "ACTIVE",
                });
              }
              nextToken = page.NextToken;
            } while (nextToken);
            return attrs;
          }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name =
            output?.apiDestinationName ??
            (yield* createDestinationName(id, news));

          // Observe — live cloud state is authoritative; a vanished
          // destination falls through to create.
          const observed = yield* eventbridge
            .describeApiDestination({ Name: name })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );

          if (!observed?.ApiDestinationArn) {
            // Ensure — create the destination; tolerate an AlreadyExists
            // race with a peer reconciler and converge via the update below.
            yield* eventbridge
              .createApiDestination({
                Name: name,
                Description: news.description,
                ConnectionArn: news.connectionArn,
                InvocationEndpoint: news.invocationEndpoint,
                HttpMethod: news.httpMethod,
                InvocationRateLimitPerSecond: news.invocationRateLimitPerSecond,
              })
              .pipe(
                Effect.catchTag(
                  "ResourceAlreadyExistsException",
                  () => Effect.void,
                ),
              );
          } else {
            // Sync — updateApiDestination overwrites the mutable aspects
            // (description, connection, endpoint, method, rate limit) in one
            // shot (idempotent on matching values).
            yield* eventbridge.updateApiDestination({
              Name: name,
              Description: news.description,
              ConnectionArn: news.connectionArn,
              InvocationEndpoint: news.invocationEndpoint,
              HttpMethod: news.httpMethod,
              InvocationRateLimitPerSecond: news.invocationRateLimitPerSecond,
            });
          }

          const settled = yield* eventbridge.describeApiDestination({
            Name: name,
          });
          const apiDestinationArn =
            settled.ApiDestinationArn as ApiDestinationArn;

          yield* session.note(apiDestinationArn);
          return {
            apiDestinationName: name,
            apiDestinationArn,
            apiDestinationState: settled.ApiDestinationState ?? "ACTIVE",
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* eventbridge
            .deleteApiDestination({ Name: output.apiDestinationName })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );
