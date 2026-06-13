import { Region } from "@distilled.cloud/aws/Region";
import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Effect from "effect/Effect";
import { deepEqual, isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createInternalTags, tagRecord } from "../../Tags.ts";

import { restApiArn, retryOnApiStatusUpdating, syncTags } from "./common.ts";

export interface RestApiProps {
  /**
   * Name of the REST API.
   *
   * If omitted, Alchemy generates a deterministic physical name.
   */
  name?: string;
  description?: string;
  version?: string;
  cloneFrom?: string;
  binaryMediaTypes?: string[];
  minimumCompressionSize?: number;
  apiKeySource?: ag.ApiKeySourceType;
  endpointConfiguration?: ag.EndpointConfiguration;
  /** Resource policy document as a JSON string. */
  policy?: string;
  disableExecuteApiEndpoint?: boolean;
  securityPolicy?: ag.SecurityPolicy;
  endpointAccessMode?: ag.EndpointAccessMode;
  /** User-defined tags (Alchemy internal tags are merged automatically). */
  tags?: Record<string, string>;
}

/**
 * Structured metadata a child resource attaches to its RestApi via `.bind`.
 *
 * These bindings are the mechanism by which Methods, Resources, Authorizers,
 * and other REST-API-scoped children declare a reverse dependency on the API
 * itself. The presence of any such binding is what forces `RestApi.create` to
 * run *after* every child has been created — which is exactly the ordering
 * CloudFormation asks users to write manually via `DependsOn`.
 *
 * Consumers should not construct these directly; the child resource
 * constructors (e.g. `Method`, `Resource`) handle binding on behalf of the
 * user.
 */
export type RestApiBinding =
  | {
      kind: "method";
      methodId: Input<string>;
      restApiId: Input<string>;
      resourceId: Input<string>;
      httpMethod: Input<string>;
    }
  | {
      kind: "resource";
      resourceId: Input<string>;
      parentId: Input<string>;
      pathPart: Input<string>;
    }
  | {
      kind: "authorizer";
      authorizerId: Input<string>;
    };

export interface RestApi extends Resource<
  "AWS.ApiGateway.RestApi",
  RestApiProps,
  {
    restApiId: string;
    rootResourceId: string;
    name: string;
    description: string | undefined;
    version: string | undefined;
    binaryMediaTypes: string[] | undefined;
    minimumCompressionSize: number | undefined;
    apiKeySource: ag.ApiKeySourceType | undefined;
    endpointConfiguration: ag.EndpointConfiguration | undefined;
    policy: string | undefined;
    disableExecuteApiEndpoint: boolean | undefined;
    securityPolicy: ag.SecurityPolicy | undefined;
    endpointAccessMode: ag.EndpointAccessMode | undefined;
    tags: Record<string, string>;
  },
  RestApiBinding,
  Providers
> {}

/**
 * An Amazon API Gateway REST API (v1).
 *
 * `RestApi` is the root of an API Gateway v1 stack. Every other ApiGateway
 * resource — `Resource`, `Method`, `Authorizer`, `Deployment`, `Stage` —
 * hangs off a `RestApi`. The only identity you need to thread through your
 * stack is the `RestApi` value itself: child resources accept `restApi: api`
 * and register themselves back onto the API so that deployments and stages
 * wait for them without any user-authored dependency lists.
 *
 * @section Getting started
 * A minimal API Gateway stack is four pieces: the `RestApi`, one or more
 * `Method`s, a `Deployment` that snapshots those methods, and a `Stage` that
 * exposes the deployment at a URL.
 *
 * @example Mock HTTP GET on the root path
 * ```typescript
 * import * as ApiGateway from "alchemy/AWS/ApiGateway";
 *
 * const api = yield* ApiGateway.RestApi("Api", {
 *   endpointConfiguration: { types: ["REGIONAL"] },
 * });
 *
 * yield* ApiGateway.Method("GetRoot", {
 *   restApi: api,
 *   httpMethod: "GET",
 *   authorizationType: "NONE",
 *   integration: { type: "MOCK" },
 * });
 *
 * const deployment = yield* ApiGateway.Deployment("Release", {
 *   restApi: api,
 * });
 *
 * const stage = yield* ApiGateway.Stage("Prod", {
 *   restApi: api,
 *   stageName: "prod",
 *   deploymentId: deployment.deploymentId,
 * });
 * ```
 *
 * @section How dependencies flow
 * Writing `restApi: api` on a child (rather than `restApiId: api.restApiId`)
 * does two things: it threads the restApi id through, and it registers a
 * `RestApiBinding` back onto the API. The Alchemy scheduler sees those
 * bindings as reverse edges from children into the API, and `Deployment`
 * reads them to express a transitive dependency on every child. You never
 * have to write a `DependsOn` list or a `triggers` hash — adding a new
 * `Method` automatically orders it before the next `Deployment`.
 *
 * @section Private REST APIs
 * @example Private REST API
 * ```typescript
 * const api = yield* ApiGateway.RestApi("PrivateApi", {
 *   endpointConfiguration: {
 *     types: ["PRIVATE"],
 *     vpcEndpointIds: [endpoint.vpcEndpointId],
 *   },
 *   policy: JSON.stringify({
 *     Version: "2012-10-17",
 *     Statement: [{
 *       Effect: "Allow",
 *       Principal: "*",
 *       Action: "execute-api:Invoke",
 *       Resource: "*",
 *     }],
 *   }),
 * });
 * ```
 *
 * @section Binary payloads
 * @example Enable binary media types
 * ```typescript
 * const api = yield* ApiGateway.RestApi("BinaryApi", {
 *   binaryMediaTypes: ["application/octet-stream", "image/png"],
 *   minimumCompressionSize: 1024,
 * });
 * ```
 *
 * @section Endpoint hardening
 * @example Disable the default execute-api endpoint
 * ```typescript
 * const api = yield* ApiGateway.RestApi("CustomDomainOnlyApi", {
 *   endpointConfiguration: { types: ["REGIONAL"] },
 *   disableExecuteApiEndpoint: true,
 * });
 * ```
 */
export const RestApi = Resource<RestApi>("AWS.ApiGateway.RestApi");

const generatedName = (id: string, props: RestApiProps) =>
  props.name
    ? Effect.succeed(props.name)
    : createPhysicalName({
        id,
        maxLength: 128,
      });

const snapshotFromApi = (api: ag.RestApi) => ({
  restApiId: api.id!,
  rootResourceId: api.rootResourceId!,
  name: api.name ?? "",
  description: api.description,
  version: api.version,
  binaryMediaTypes: api.binaryMediaTypes,
  minimumCompressionSize: api.minimumCompressionSize,
  apiKeySource: api.apiKeySource,
  endpointConfiguration: api.endpointConfiguration,
  policy: api.policy,
  disableExecuteApiEndpoint: api.disableExecuteApiEndpoint,
  securityPolicy: api.securityPolicy,
  endpointAccessMode: api.endpointAccessMode,
  tags: tagRecord(api.tags),
});

const patchReplace = (path: string, value: string): ag.PatchOperation => ({
  op: "replace",
  path,
  value,
});

const encodeJsonPointerSegment = (s: string) =>
  s.replace(/~/g, "~0").replace(/\//g, "~1");

const binaryMediaTypePath = (mediaType: string) =>
  `/binaryMediaTypes/${encodeJsonPointerSegment(mediaType)}`;

const buildBinaryMediaTypePatches = (
  prev: string[] | undefined,
  next: string[] | undefined,
): ag.PatchOperation[] => {
  const prevSet = [...new Set(prev ?? [])];
  const nextSet = [...new Set(next ?? [])];
  const patches: ag.PatchOperation[] = [];
  for (const m of prevSet) {
    if (!nextSet.includes(m)) {
      patches.push({ op: "remove", path: binaryMediaTypePath(m) });
    }
  }
  for (const m of nextSet) {
    if (!prevSet.includes(m)) {
      patches.push({
        op: "add",
        path: binaryMediaTypePath(m),
        value: m,
      });
    }
  }
  return patches;
};

const buildUpdatePatches = (
  news: RestApiProps,
  prev: RestApi["Attributes"],
): ag.PatchOperation[] => {
  const patches: ag.PatchOperation[] = [];
  if (news.name !== undefined && news.name !== prev.name) {
    patches.push(patchReplace("/name", news.name));
  }
  if (news.description !== prev.description) {
    patches.push(patchReplace("/description", news.description ?? ""));
  }
  if (news.version !== prev.version) {
    patches.push(patchReplace("/version", news.version ?? ""));
  }
  patches.push(
    ...buildBinaryMediaTypePatches(
      prev.binaryMediaTypes,
      news.binaryMediaTypes,
    ),
  );
  if (news.minimumCompressionSize !== prev.minimumCompressionSize) {
    patches.push(
      patchReplace(
        "/minimumCompressionSize",
        String(news.minimumCompressionSize ?? ""),
      ),
    );
  }
  if (news.apiKeySource !== prev.apiKeySource) {
    patches.push(patchReplace("/apiKeySource", news.apiKeySource ?? "HEADER"));
  }
  if (news.policy !== prev.policy) {
    patches.push(patchReplace("/policy", news.policy ?? ""));
  }
  if (news.disableExecuteApiEndpoint !== prev.disableExecuteApiEndpoint) {
    patches.push(
      patchReplace(
        "/disableExecuteApiEndpoint",
        String(!!news.disableExecuteApiEndpoint),
      ),
    );
  }
  if (news.securityPolicy !== prev.securityPolicy) {
    patches.push(
      patchReplace("/securityPolicy", news.securityPolicy ?? "TLS_1_0"),
    );
  }
  if (news.endpointAccessMode !== prev.endpointAccessMode) {
    patches.push(
      patchReplace("/endpointAccessMode", news.endpointAccessMode ?? ""),
    );
  }
  return patches;
};

export const RestApiProvider = () =>
  Provider.effect(
    RestApi,
    Effect.gen(function* () {
      const awsRegion = yield* Region;

      return {
        stables: ["restApiId", "rootResourceId"] as const,
        diff: Effect.fn(function* ({ news: newsIn, olds }) {
          if (!isResolved(newsIn)) return;
          const news = newsIn as RestApiProps;
          if (
            // Endpoint type, private endpoint IDs, and IP address type are part
            // of the REST API endpoint shape; replacing avoids partial endpoint
            // drift that API Gateway cannot consistently patch in place.
            !deepEqual(
              news.endpointConfiguration?.types,
              olds.endpointConfiguration?.types,
            ) ||
            !deepEqual(
              news.endpointConfiguration?.vpcEndpointIds,
              olds.endpointConfiguration?.vpcEndpointIds,
            ) ||
            !deepEqual(
              news.endpointConfiguration?.ipAddressType,
              olds.endpointConfiguration?.ipAddressType,
            )
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.restApiId) return undefined;
          const api = yield* ag
            .getRestApi({ restApiId: output.restApiId })
            .pipe(
              Effect.catchTag("NotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (!api?.id) return undefined;
          return snapshotFromApi(api);
        }),
        // The REST API is brought up in two phases. `precreate` creates the
        // REST API in full so child resources (`Method`, `Resource`, etc.)
        // can resolve `api.restApiId` and start their own creates — this is
        // the cycle-breaker that lets children register themselves back onto
        // the API via `restApi.bind`. `create` then runs last — after every
        // bound child — and is effectively a no-op that re-reads the API to
        // publish the final snapshot. The key property is that any
        // `Deployment` referencing `api.*` outputs will see a value produced
        // only after every bound child has settled, because the bindings on
        // the API force `create` to wait for them before returning.
        precreate: Effect.fn(function* ({ id, news: newsIn, session }) {
          if (!isResolved(newsIn)) {
            return yield* Effect.die("RestApi props were not resolved");
          }
          const news = newsIn as RestApiProps;
          const name = yield* generatedName(id, news);
          const internalTags = yield* createInternalTags(id);
          const allTags = { ...(news.tags ?? {}), ...internalTags };
          const created = yield* retryOnApiStatusUpdating(
            ag.createRestApi({
              name,
              description: news.description,
              version: news.version,
              cloneFrom: news.cloneFrom,
              binaryMediaTypes: news.binaryMediaTypes,
              minimumCompressionSize: news.minimumCompressionSize,
              apiKeySource: news.apiKeySource,
              endpointConfiguration: news.endpointConfiguration,
              policy: news.policy,
              tags: allTags,
              disableExecuteApiEndpoint: news.disableExecuteApiEndpoint,
              securityPolicy: news.securityPolicy,
              endpointAccessMode: news.endpointAccessMode,
            }),
          );
          if (!created.id || !created.rootResourceId) {
            return yield* Effect.die(
              "createRestApi missing id or rootResourceId",
            );
          }
          yield* session.note(`Created REST API ${created.id}`);
          const full = yield* ag.getRestApi({ restApiId: created.id });
          return snapshotFromApi(full);
        }),
        reconcile: Effect.fn(function* ({ id, news: newsIn, output, session }) {
          if (!isResolved(newsIn)) {
            return yield* Effect.die("RestApi props were not resolved");
          }
          const news = newsIn as RestApiProps;

          // RestApi has a `precreate` that always runs before `reconcile`
          // for greenfield deployments — it creates the REST API in full
          // so that `restApi.restApiId` is resolvable and child resources
          // (Method, Resource, Authorizer) can register themselves back on
          // the API via `restApi.bind`. By the time `reconcile` runs the id
          // is populated; we never expect `output === undefined` here, but
          // we still handle it defensively.
          if (!output?.restApiId) {
            return yield* Effect.die(
              "RestApi reconcile reached without a precreate output",
            );
          }

          // Observe — fetch live cloud state. `output` is treated as a
          // cache for the stable id only.
          const observed = yield* ag
            .getRestApi({ restApiId: output.restApiId })
            .pipe(
              Effect.catchTag("NotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (!observed?.id) {
            return yield* Effect.die(
              `RestApi ${output.restApiId} disappeared between precreate and reconcile`,
            );
          }
          const observedSnapshot = snapshotFromApi(observed);

          // Sync mutable scalar fields — diff observed cloud state against
          // desired and emit only the delta as PATCH operations.
          const patches = buildUpdatePatches(news, observedSnapshot);
          if (patches.length > 0) {
            yield* retryOnApiStatusUpdating(
              ag.updateRestApi({
                restApiId: output.restApiId,
                patchOperations: patches,
              }),
            );
          }

          // Sync tags — observed ↔ desired so adoption converges without
          // fighting the existing tag set.
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };
          if (!deepEqual(observedSnapshot.tags, desiredTags)) {
            const arn = restApiArn(awsRegion, output.restApiId);
            yield* syncTags({
              resourceArn: arn,
              oldTags: observedSnapshot.tags,
              newTags: desiredTags,
            });
          }

          yield* session.note(`Reconciled REST API ${output.restApiId}`);

          // Re-read so the returned attributes reflect what's actually in
          // the cloud after all sync steps.
          const final = yield* ag.getRestApi({ restApiId: output.restApiId });
          if (!final.id) {
            return yield* Effect.die("getRestApi missing id after reconcile");
          }
          return snapshotFromApi(final);
        }),
        delete: Effect.fn(function* ({ output, session }) {
          yield* retryOnApiStatusUpdating(
            ag
              .deleteRestApi({ restApiId: output.restApiId })
              .pipe(Effect.catchTag("NotFoundException", () => Effect.void)),
          );
          yield* session.note(`Deleted REST API ${output.restApiId}`);
        }),
      };
    }),
  );
