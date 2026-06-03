import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import * as Provider from "../../Provider.ts";
import {
  Resource as ResourceFactory,
  type Resource as ResourceType,
} from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import type { RestApi } from "./RestApi.ts";

export interface ApiGatewayResourceProps {
  /**
   * The `RestApi` this path segment belongs to. Binding via `restApi`
   * registers this resource on the API so that any `Deployment` of the
   * same API waits for it — and for the methods attached to it — before
   * snapshotting.
   */
  restApi?: RestApi;
  /**
   * Identifier of the parent REST API. Usually derived from `restApi.restApiId`.
   */
  restApiId?: Input<string>;
  /**
   * Parent resource id (use `api.rootResourceId` for top-level paths, or
   * the `resourceId` of another `ApiGateway.Resource` to nest deeper).
   */
  parentId: Input<string>;
  /**
   * Path segment (e.g. `items` or `{proxy+}`).
   */
  pathPart: string;
}

export interface ApiGatewayResource extends ResourceType<
  "AWS.ApiGateway.Resource",
  ApiGatewayResourceProps,
  {
    resourceId: string;
    restApiId: string;
    parentId: string;
    pathPart: string;
  },
  never,
  Providers
> {}

/**
 * A path segment under a REST API resource tree.
 *
 * Resources form the URL hierarchy of a REST API: every path segment
 * (`/items`, `/items/{id}`, `/{proxy+}`) is a `Resource` whose `parentId`
 * points either at `api.rootResourceId` (for top-level paths) or at
 * another `Resource`'s `resourceId` (for nested paths). Attach methods
 * to a resource by passing its `resourceId` to `ApiGateway.Method`.
 *
 * @section Path resources
 * @example Top-level path
 * ```typescript
 * const items = yield* ApiGateway.Resource("Items", {
 *   restApi: api,
 *   parentId: api.rootResourceId,
 *   pathPart: "items",
 * });
 * ```
 *
 * @example Nested path with a greedy proxy
 * ```typescript
 * const items = yield* ApiGateway.Resource("Items", {
 *   restApi: api,
 *   parentId: api.rootResourceId,
 *   pathPart: "items",
 * });
 *
 * const anyItem = yield* ApiGateway.Resource("AnyItem", {
 *   restApi: api,
 *   parentId: items.resourceId,
 *   pathPart: "{proxy+}",
 * });
 * ```
 */
export const GatewayResource = ResourceFactory<ApiGatewayResource>(
  "AWS.ApiGateway.Resource",
);

interface ApiGatewayResourceInputProps {
  restApi?: RestApi;
  restApiId?: Input<string>;
  parentId: Input<string>;
  pathPart: Input<string>;
}

/**
 * User-facing wrapper. Accepts `restApi: RestApi` to register this resource
 * as a binding on the API (so deployments wait for it transitively).
 */
const ResourceImpl = (id: string, props: ApiGatewayResourceInputProps) =>
  Effect.gen(function* () {
    const { restApi, ...rest } = props;
    const restApiId = rest.restApiId ?? restApi?.restApiId;
    if (!restApiId) {
      return yield* Effect.die(
        "ApiGateway.Resource requires either `restApi` (preferred) or " +
          "explicit `restApiId`.",
      );
    }
    const resource = yield* GatewayResource(id, {
      ...rest,
      restApiId,
    } as any);
    if (restApi) {
      yield* restApi.bind`${resource}`({
        kind: "resource",
        resourceId: resource.resourceId,
        parentId: resource.parentId,
        pathPart: resource.pathPart,
      });
    }
    return resource;
  });

export const Resource = ResourceImpl;

export const ResourceProvider = () =>
  Provider.effect(
    GatewayResource,
    Effect.gen(function* () {
      return {
        stables: ["resourceId", "restApiId", "parentId"] as const,
        diff: Effect.fn(function* ({ news: newsIn, olds }) {
          if (!isResolved(newsIn)) return;
          const news = newsIn as Input.ResolveProps<ApiGatewayResourceProps>;
          if (
            news.restApiId !== olds.restApiId ||
            news.pathPart !== olds.pathPart ||
            news.parentId !== olds.parentId
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.resourceId) return undefined;
          const r = yield* ag
            .getResource({
              restApiId: output.restApiId,
              resourceId: output.resourceId,
            })
            .pipe(
              Effect.catchTag("NotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (!r?.id) return undefined;
          return {
            resourceId: r.id,
            restApiId: output.restApiId,
            parentId: r.parentId!,
            pathPart: r.pathPart!,
          };
        }),
        reconcile: Effect.fn(function* ({ news: newsIn, output, session }) {
          if (!isResolved(newsIn)) {
            return yield* Effect.die("Resource props were not resolved");
          }
          const news = newsIn as Input.ResolveProps<ApiGatewayResourceProps>;
          const restApiId = (output?.restApiId ?? news.restApiId) as string;

          // Observe — fetch the live resource if we have a cached id. We
          // never trust `output.pathPart` for diffing; we re-read the
          // pathPart from cloud state every reconcile.
          let observed = output?.resourceId
            ? yield* ag
                .getResource({
                  restApiId,
                  resourceId: output.resourceId,
                })
                .pipe(
                  Effect.catchTag("NotFoundException", () =>
                    Effect.succeed(undefined),
                  ),
                )
            : undefined;

          // Ensure — create the resource if missing.
          if (!observed?.id) {
            const created = yield* ag.createResource({
              restApiId: news.restApiId as string,
              parentId: news.parentId as string,
              pathPart: news.pathPart,
            });
            if (!created.id) {
              return yield* Effect.die("createResource missing id");
            }
            yield* session.note(
              `Created API Gateway resource ${created.id} (${news.pathPart})`,
            );
            observed = yield* ag.getResource({
              restApiId: news.restApiId as string,
              resourceId: created.id,
            });
          }

          const resourceId = observed.id!;

          // Sync pathPart — observed ↔ desired. parentId moves are modeled
          // as `replace` in `diff`, so we don't try to patch them here.
          if (news.pathPart !== observed.pathPart) {
            yield* ag.updateResource({
              restApiId,
              resourceId,
              patchOperations: [
                { op: "replace", path: "/pathPart", value: news.pathPart },
              ],
            });
            yield* session.note(`Updated resource ${resourceId}`);
          }

          return {
            resourceId,
            restApiId,
            parentId: observed.parentId!,
            pathPart: news.pathPart,
          };
        }),
        delete: Effect.fn(function* ({ output, session }) {
          yield* ag
            .deleteResource({
              restApiId: output.restApiId,
              resourceId: output.resourceId,
            })
            .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
          yield* session.note(`Deleted resource ${output.resourceId}`);
        }),
      };
    }),
  );
