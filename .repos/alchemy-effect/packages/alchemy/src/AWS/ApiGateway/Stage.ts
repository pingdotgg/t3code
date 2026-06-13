import { Region } from "@distilled.cloud/aws/Region";
import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Effect from "effect/Effect";
import { deepEqual, isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createInternalTags } from "../../Tags.ts";

import type { RestApi } from "./RestApi.ts";
import { retryOnApiStatusUpdating, stageArn, syncTags } from "./common.ts";

export interface StageProps {
  /**
   * The `RestApi` this stage belongs to. When supplied, `restApiId` is
   * derived from `restApi.restApiId` automatically.
   */
  restApi?: RestApi;
  /**
   * ID of the REST API. Usually derived from `restApi.restApiId`.
   */
  restApiId?: Input<string>;
  stageName: string;
  /**
   * The `deploymentId` this stage points at. Pass `deployment.deploymentId`
   * — Alchemy will automatically wait for the deployment to be created
   * before creating the stage.
   */
  deploymentId: Input<string>;
  description?: string;
  cacheClusterEnabled?: boolean;
  cacheClusterSize?: ag.CacheClusterSize;
  variables?: { [key: string]: string | undefined };
  documentationVersion?: string;
  canarySettings?: ag.CanarySettings;
  tracingEnabled?: boolean;
  /**
   * Map of resource path pattern to method settings; keys use `{resourcePath}/{httpMethod}`.
   */
  methodSettings?: { [key: string]: ag.MethodSetting | undefined };
  accessLogSettings?: ag.AccessLogSettings;
  webAclArn?: string;
  tags?: Record<string, string>;
}

export interface ApiGatewayStage extends Resource<
  "AWS.ApiGateway.Stage",
  StageProps,
  {
    restApiId: string;
    stageName: string;
    deploymentId: string;
    description: string | undefined;
    cacheClusterEnabled: boolean | undefined;
    cacheClusterSize: ag.CacheClusterSize | undefined;
    variables: { [key: string]: string | undefined } | undefined;
    documentationVersion: string | undefined;
    canarySettings: ag.CanarySettings | undefined;
    tracingEnabled: boolean | undefined;
    methodSettings: { [key: string]: ag.MethodSetting | undefined } | undefined;
    accessLogSettings: ag.AccessLogSettings | undefined;
    webAclArn: string | undefined;
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A stage for a REST API deployment.
 *
 * A Stage is what clients actually call. It binds a name (`dev`, `prod`,
 * `v2`) to a specific `Deployment` of a `RestApi` and exposes it at a
 * stable URL:
 *
 * ```
 * https://<restApiId>.execute-api.<region>.amazonaws.com/<stageName>/
 * ```
 *
 * @section Stages
 * @example A dev stage pointing at the latest deployment
 * ```typescript
 * const stage = yield* ApiGateway.Stage("Dev", {
 *   restApi: api,
 *   stageName: "dev",
 *   deploymentId: deployment.deploymentId,
 * });
 * ```
 *
 * @section Stage variables
 * @example Override values per stage
 * ```typescript
 * const stage = yield* ApiGateway.Stage("Prod", {
 *   restApi: api,
 *   stageName: "prod",
 *   deploymentId: deployment.deploymentId,
 *   variables: {
 *     logLevel: "info",
 *     featureFlag: "on",
 *   },
 * });
 * ```
 *
 * @section Canary deployments
 * Point `canarySettings` at a different `Deployment` to split traffic
 * between the stable and canary versions. `percentTraffic` is the
 * percent of requests routed to the canary deployment.
 *
 * @example Shift 10% of traffic to a canary deployment
 * ```typescript
 * const stage = yield* ApiGateway.Stage("Prod", {
 *   restApi: api,
 *   stageName: "prod",
 *   deploymentId: stableDeployment.deploymentId,
 *   canarySettings: {
 *     percentTraffic: 10,
 *     deploymentId: canaryDeployment.deploymentId,
 *   },
 * });
 * ```
 */
export const StageResource = Resource<ApiGatewayStage>("AWS.ApiGateway.Stage");

interface StageInputProps {
  restApi?: RestApi;
  restApiId?: Input<string>;
  stageName: Input<string>;
  deploymentId: Input<string>;
  description?: Input<string>;
  cacheClusterEnabled?: Input<boolean>;
  cacheClusterSize?: Input<ag.CacheClusterSize>;
  variables?: Input<{ [key: string]: string | undefined }>;
  documentationVersion?: Input<string>;
  canarySettings?: Input<ag.CanarySettings>;
  tracingEnabled?: Input<boolean>;
  methodSettings?: Input<{ [key: string]: ag.MethodSetting | undefined }>;
  accessLogSettings?: Input<ag.AccessLogSettings>;
  webAclArn?: Input<string>;
  tags?: Input<Record<string, string>>;
}

/**
 * User-facing wrapper that derives `restApiId` from `restApi` when supplied.
 */
const StageImpl = (id: string, props: StageInputProps) =>
  Effect.gen(function* () {
    const { restApi, ...rest } = props;
    const restApiId = rest.restApiId ?? restApi?.restApiId;
    if (!restApiId) {
      return yield* Effect.die(
        "Stage requires either `restApi` (preferred) or explicit `restApiId`.",
      );
    }
    return yield* StageResource(id, { ...rest, restApiId } as any);
  });

export const Stage = StageImpl;

const toTagRecord = (tags: ag.Stage["tags"]) =>
  Object.fromEntries(
    Object.entries(tags ?? {}).filter(
      (e): e is [string, string] => e[1] !== undefined,
    ),
  );

const encodeJsonPointerSegment = (s: string) =>
  s.replace(/~/g, "~0").replace(/\//g, "~1");

const snapshotStage = (s: ag.Stage, restApiId: string, stageName: string) => ({
  restApiId,
  stageName,
  deploymentId: s.deploymentId!,
  description: s.description,
  cacheClusterEnabled: s.cacheClusterEnabled,
  cacheClusterSize: s.cacheClusterSize,
  variables: s.variables,
  documentationVersion: s.documentationVersion,
  canarySettings: s.canarySettings,
  tracingEnabled: s.tracingEnabled,
  methodSettings: s.methodSettings,
  accessLogSettings: s.accessLogSettings,
  webAclArn: s.webAclArn,
  tags: toTagRecord(s.tags),
});

const parseMethodSettingKey = (key: string) => {
  const idx = key.lastIndexOf("/");
  if (idx <= 0) {
    return { resourcePath: key, httpMethod: "*" };
  }
  return {
    resourcePath: key.slice(0, idx),
    httpMethod: key.slice(idx + 1),
  };
};

/**
 * API Gateway `updateStage` rejects patch paths that use the raw schema
 * field name (e.g. `/*\/*\/throttlingBurstLimit`). Each field maps to a
 * slashed path under a category (`throttling`, `caching`, `metrics`,
 * `logging`). The accepted forms are documented at:
 * https://docs.aws.amazon.com/apigateway/latest/api/API_UpdateStage.html
 */
const methodSettingFieldToPath: Record<keyof ag.MethodSetting, string> = {
  metricsEnabled: "metrics/enabled",
  loggingLevel: "logging/loglevel",
  dataTraceEnabled: "logging/dataTrace",
  throttlingBurstLimit: "throttling/burstLimit",
  throttlingRateLimit: "throttling/rateLimit",
  cachingEnabled: "caching/enabled",
  cacheTtlInSeconds: "caching/ttlInSeconds",
  cacheDataEncrypted: "caching/dataEncrypted",
  requireAuthorizationForCacheControl:
    "caching/requireAuthorizationForCacheControl",
  unauthorizedCacheControlHeaderStrategy:
    "caching/unauthorizedCacheControlHeaderStrategy",
};

function methodSettingScalarPatch(
  base: string,
  field: keyof ag.MethodSetting,
  prev: ag.MethodSetting | undefined,
  next: ag.MethodSetting | undefined,
): ag.PatchOperation | undefined {
  const pv = prev?.[field];
  const nv = next?.[field];
  if (pv === nv) return undefined;
  const segment = methodSettingFieldToPath[field];
  if (nv === undefined) {
    // Only emit `remove` if the field was actually set upstream; AWS
    // rejects removes against fields that have no existing setting with
    // `Cannot remove method setting ... because there is no method setting
    // for this method`.
    if (pv === undefined) return undefined;
    return { op: "remove", path: `${base}/${segment}` };
  }
  return {
    op: "replace",
    path: `${base}/${segment}`,
    value: typeof nv === "boolean" ? String(nv) : String(nv),
  };
}

/**
 * AWS API Gateway's `getStage` response populates `methodSettings` with
 * every field defaulted (e.g. `metricsEnabled: false`, `loggingLevel: "OFF"`),
 * even when the user only set one field like `throttlingBurstLimit`. This
 * makes round-tripping tricky: we cannot tell which fields the user
 * actually set versus which AWS defaulted. If we naively diff the full
 * object and emit a `remove` op for every field that's missing from the
 * user's next spec, AWS rejects with "Cannot remove method setting ...
 * because there is no method setting for this method".
 *
 * The pragmatic policy is additive: for each `(resourcePath, httpMethod)`
 * key that appears in the user's `next` spec, emit `replace` ops only
 * for fields the user explicitly set (own-property on `next[key]`).
 * Fields the user never specified are left alone, matching the
 * "fields default to whatever AWS chose" semantic the API itself uses.
 *
 * To *clear* a field, the user can explicitly set it to `undefined` on
 * `next[key]`; that path still produces a `remove` op, and `remove`s are
 * only emitted when `prev[key][field]` was actually set (see
 * `methodSettingScalarPatch`).
 *
 * To drop a whole `(resourcePath, httpMethod)` key, we walk the fields
 * present on `prev[key]` and emit `remove`s for each — but again only
 * if that field was actually set upstream.
 */
const buildMethodSettingPatches = (
  prev: { [key: string]: ag.MethodSetting | undefined } | undefined,
  next: { [key: string]: ag.MethodSetting | undefined } | undefined,
): ag.PatchOperation[] => {
  const keys = new Set([
    ...Object.keys(prev ?? {}),
    ...Object.keys(next ?? {}),
  ]);
  const patches: ag.PatchOperation[] = [];
  for (const key of keys) {
    const p = prev?.[key];
    const n = next?.[key];
    if (!n && !p) continue;
    const { resourcePath, httpMethod } = parseMethodSettingKey(key);
    const rp = encodeJsonPointerSegment(resourcePath);
    const hm = encodeJsonPointerSegment(httpMethod);
    const base = `/${rp}/${hm}`;
    if (!n) {
      // Key removed entirely: try to clear each field that was explicitly
      // set on the prior spec. `methodSettingScalarPatch` will drop the
      // remove if the field wasn't actually present on `p`.
      for (const f of Object.keys(p ?? {}) as (keyof ag.MethodSetting)[]) {
        const op = methodSettingScalarPatch(base, f, p, undefined);
        if (op) patches.push(op);
      }
      continue;
    }
    if (p && deepEqual(p, n)) continue;
    // Iterate only the fields the user actually specified on `n`. This
    // intentionally ignores AWS-default fields that leaked into `p` via
    // `getStage`, so we never emit phantom `remove` ops for defaults.
    for (const f of Object.keys(n) as (keyof ag.MethodSetting)[]) {
      const op = methodSettingScalarPatch(base, f, p, n);
      if (op) patches.push(op);
    }
  }
  return patches;
};

const buildVariablePatches = (
  prev: { [key: string]: string | undefined } | undefined,
  next: { [key: string]: string | undefined } | undefined,
): ag.PatchOperation[] => {
  const keys = new Set([
    ...Object.keys(prev ?? {}),
    ...Object.keys(next ?? {}),
  ]);
  const patches: ag.PatchOperation[] = [];
  for (const k of keys) {
    const pv = prev?.[k];
    const nv = next?.[k];
    if (pv === nv) continue;
    const enc = encodeJsonPointerSegment(k);
    if (nv === undefined) {
      patches.push({ op: "remove", path: `/variables/${enc}` });
    } else {
      patches.push({ op: "replace", path: `/variables/${enc}`, value: nv });
    }
  }
  return patches;
};

const buildAccessLogPatches = (
  prev: ag.AccessLogSettings | undefined,
  next: ag.AccessLogSettings | undefined,
): ag.PatchOperation[] => {
  const patches: ag.PatchOperation[] = [];
  if (prev?.destinationArn !== next?.destinationArn) {
    if (
      next?.destinationArn === undefined &&
      prev?.destinationArn !== undefined
    ) {
      patches.push({ op: "remove", path: "/accessLogSettings/destinationArn" });
    } else if (next?.destinationArn !== undefined) {
      patches.push({
        op: "replace",
        path: "/accessLogSettings/destinationArn",
        value: next.destinationArn,
      });
    }
  }
  if (prev?.format !== next?.format) {
    if (next?.format === undefined && prev?.format !== undefined) {
      patches.push({ op: "remove", path: "/accessLogSettings/format" });
    } else if (next?.format !== undefined) {
      patches.push({
        op: "replace",
        path: "/accessLogSettings/format",
        value: next.format,
      });
    }
  }
  return patches;
};

const buildCanaryOverridePatches = (
  prev: { [key: string]: string | undefined } | undefined,
  next: { [key: string]: string | undefined } | undefined,
): ag.PatchOperation[] => {
  const keys = new Set([
    ...Object.keys(prev ?? {}),
    ...Object.keys(next ?? {}),
  ]);
  const patches: ag.PatchOperation[] = [];
  for (const k of keys) {
    const pv = prev?.[k];
    const nv = next?.[k];
    if (pv === nv) continue;
    const enc = encodeJsonPointerSegment(k);
    if (nv === undefined) {
      patches.push({
        op: "remove",
        path: `/canarySettings/stageVariableOverrides/${enc}`,
      });
    } else {
      patches.push({
        op: "replace",
        path: `/canarySettings/stageVariableOverrides/${enc}`,
        value: nv,
      });
    }
  }
  return patches;
};

const buildCanaryPatches = (
  prev: ag.CanarySettings | undefined,
  next: ag.CanarySettings | undefined,
): ag.PatchOperation[] => {
  const patches: ag.PatchOperation[] = [];
  if (prev?.percentTraffic !== next?.percentTraffic) {
    if (
      next?.percentTraffic === undefined &&
      prev?.percentTraffic !== undefined
    ) {
      patches.push({ op: "remove", path: "/canarySettings/percentTraffic" });
    } else if (next?.percentTraffic !== undefined) {
      patches.push({
        op: "replace",
        path: "/canarySettings/percentTraffic",
        value: String(next.percentTraffic),
      });
    }
  }
  if (prev?.deploymentId !== next?.deploymentId) {
    if (next?.deploymentId === undefined && prev?.deploymentId !== undefined) {
      patches.push({ op: "remove", path: "/canarySettings/deploymentId" });
    } else if (next?.deploymentId !== undefined) {
      patches.push({
        op: "replace",
        path: "/canarySettings/deploymentId",
        value: next.deploymentId,
      });
    }
  }
  if (prev?.useStageCache !== next?.useStageCache) {
    if (next?.useStageCache === undefined) {
      patches.push({ op: "remove", path: "/canarySettings/useStageCache" });
    } else {
      patches.push({
        op: "replace",
        path: "/canarySettings/useStageCache",
        value: String(next.useStageCache),
      });
    }
  }
  patches.push(
    ...buildCanaryOverridePatches(
      prev?.stageVariableOverrides,
      next?.stageVariableOverrides,
    ),
  );
  return patches;
};

const buildStagePatches = (
  prev: ApiGatewayStage["Attributes"],
  news: Input.ResolveProps<StageProps>,
): ag.PatchOperation[] => {
  const patches: ag.PatchOperation[] = [];
  if (news.deploymentId !== prev.deploymentId) {
    patches.push({
      op: "replace",
      path: "/deploymentId",
      value: news.deploymentId as string,
    });
  }
  if (news.description !== prev.description) {
    patches.push({
      op: "replace",
      path: "/description",
      value: news.description ?? "",
    });
  }
  if (news.cacheClusterEnabled !== prev.cacheClusterEnabled) {
    patches.push({
      op: "replace",
      path: "/cacheClusterEnabled",
      value: String(news.cacheClusterEnabled ?? false),
    });
  }
  if (news.cacheClusterSize !== prev.cacheClusterSize) {
    if (news.cacheClusterSize === undefined) {
      patches.push({ op: "remove", path: "/cacheClusterSize" });
    } else {
      patches.push({
        op: "replace",
        path: "/cacheClusterSize",
        value: news.cacheClusterSize,
      });
    }
  }
  if (news.documentationVersion !== prev.documentationVersion) {
    if (news.documentationVersion === undefined) {
      patches.push({ op: "remove", path: "/documentationVersion" });
    } else {
      patches.push({
        op: "replace",
        path: "/documentationVersion",
        value: news.documentationVersion,
      });
    }
  }
  if (news.tracingEnabled !== prev.tracingEnabled) {
    patches.push({
      op: "replace",
      path: "/tracingEnabled",
      value: String(news.tracingEnabled ?? false),
    });
  }
  if (news.webAclArn !== prev.webAclArn) {
    if (news.webAclArn === undefined || news.webAclArn === "") {
      patches.push({ op: "remove", path: "/webAclArn" });
    } else {
      patches.push({
        op: "replace",
        path: "/webAclArn",
        value: news.webAclArn,
      });
    }
  }
  patches.push(...buildVariablePatches(prev.variables, news.variables));
  patches.push(
    ...buildMethodSettingPatches(prev.methodSettings, news.methodSettings),
  );
  patches.push(
    ...buildAccessLogPatches(prev.accessLogSettings, news.accessLogSettings),
  );
  if (!deepEqual(news.canarySettings, prev.canarySettings)) {
    patches.push(
      ...buildCanaryPatches(prev.canarySettings, news.canarySettings),
    );
  }
  return patches;
};

export const StageProvider = () =>
  Provider.effect(
    StageResource,
    Effect.gen(function* () {
      const awsRegion = yield* Region;

      return {
        stables: ["restApiId", "stageName"] as const,
        diff: Effect.fn(function* ({ news: newsIn, olds }) {
          if (!isResolved(newsIn)) return;
          const news = newsIn as Input.ResolveProps<StageProps>;
          if (
            news.restApiId !== olds.restApiId ||
            news.stageName !== olds.stageName
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output) return undefined;
          const s = yield* ag
            .getStage({
              restApiId: output.restApiId,
              stageName: output.stageName,
            })
            .pipe(
              Effect.catchTag("NotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (!s?.stageName) return undefined;
          return snapshotStage(s, output.restApiId, s.stageName);
        }),
        reconcile: Effect.fn(function* ({ id, news: newsIn, output, session }) {
          if (!isResolved(newsIn)) {
            return yield* Effect.die("Stage props were not resolved");
          }
          const news = newsIn as Input.ResolveProps<StageProps>;
          const restApiId = (output?.restApiId ?? news.restApiId) as string;
          const stageName = output?.stageName ?? news.stageName;
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // Observe — fetch live stage state. `output` is at most a cache
          // for the natural-key tuple (restApiId, stageName); the actual
          // mutable settings come from the cloud read on every reconcile.
          let observed = yield* ag
            .getStage({ restApiId, stageName })
            .pipe(
              Effect.catchTag("NotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );

          // Ensure — create the stage if missing. `createStage` only sets
          // a subset of the configurable surface; the rest is applied via
          // updateStage in the sync step below.
          if (!observed?.stageName) {
            yield* retryOnApiStatusUpdating(
              ag.createStage({
                restApiId: news.restApiId as string,
                stageName: news.stageName,
                deploymentId: news.deploymentId as string,
                description: news.description,
                cacheClusterEnabled: news.cacheClusterEnabled,
                cacheClusterSize: news.cacheClusterSize,
                variables: news.variables,
                documentationVersion: news.documentationVersion,
                canarySettings: news.canarySettings,
                tracingEnabled: news.tracingEnabled,
                tags: desiredTags,
              }),
            );
            yield* session.note(`Created stage ${news.stageName}`);
            observed = yield* ag.getStage({
              restApiId: news.restApiId as string,
              stageName: news.stageName,
            });
          }

          // Sync stage settings — diff observed cloud state against desired
          // and emit only the delta as PATCH operations. `buildStagePatches`
          // already handles every mutable aspect (deploymentId, description,
          // cache, variables, methodSettings, accessLog, canary, tracing,
          // webAcl).
          const observedSnapshot = snapshotStage(
            observed,
            restApiId,
            stageName,
          );
          const patches = buildStagePatches(observedSnapshot, news);
          if (patches.length > 0) {
            yield* retryOnApiStatusUpdating(
              ag.updateStage({
                restApiId,
                stageName,
                patchOperations: patches,
              }),
            );
          }

          // Sync tags — observed ↔ desired.
          if (!deepEqual(observedSnapshot.tags, desiredTags)) {
            const arn = stageArn(awsRegion, restApiId, stageName);
            yield* syncTags({
              resourceArn: arn,
              oldTags: observedSnapshot.tags,
              newTags: desiredTags,
            });
          }

          yield* session.note(`Reconciled stage ${stageName}`);
          const final = yield* ag.getStage({ restApiId, stageName });
          return snapshotStage(final, restApiId, stageName);
        }),
        delete: Effect.fn(function* ({ output, session }) {
          yield* retryOnApiStatusUpdating(
            ag
              .deleteStage({
                restApiId: output.restApiId,
                stageName: output.stageName,
              })
              .pipe(Effect.catchTag("NotFoundException", () => Effect.void)),
          );
          yield* session.note(`Deleted stage ${output.stageName}`);
        }),
      };
    }),
  );
