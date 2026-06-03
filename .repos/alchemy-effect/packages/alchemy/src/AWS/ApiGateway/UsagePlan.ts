import { Region } from "@distilled.cloud/aws/Region";
import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Effect from "effect/Effect";
import { deepEqual, isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createInternalTags, tagRecord } from "../../Tags.ts";

import { syncTags, usagePlanArn } from "./common.ts";

export interface UsagePlanProps {
  /**
   * Friendly name for the usage plan.
   *
   * If omitted, Alchemy generates a deterministic physical name.
   */
  name?: string;
  /**
   * Human-readable description for operators.
   */
  description?: string;
  /**
   * API stages associated with this plan.
   */
  apiStages?: ag.ApiStage[];
  /**
   * Default request throttle applied by the plan.
   */
  throttle?: ag.ThrottleSettings;
  /**
   * Quota limit and period applied by the plan.
   */
  quota?: ag.QuotaSettings;
  /**
   * User-defined tags. Alchemy internal tags are merged automatically.
   */
  tags?: Record<string, string>;
}

export interface UsagePlan extends Resource<
  "AWS.ApiGateway.UsagePlan",
  UsagePlanProps,
  {
    id: string;
    name: string | undefined;
    description: string | undefined;
    apiStages: ag.ApiStage[] | undefined;
    throttle: ag.ThrottleSettings | undefined;
    quota: ag.QuotaSettings | undefined;
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * Usage plan for API stages, throttling, and quotas.
 *
 * @section Usage plans
 * @example Usage plan with stage
 * ```typescript
 * const plan = yield* ApiGateway.UsagePlan("Standard", {
 *   apiStages: [{ apiId: api.restApiId, stage: stage.stageName }],
 * });
 * ```
 */
const UsagePlanResource = Resource<UsagePlan>("AWS.ApiGateway.UsagePlan");

export { UsagePlanResource as UsagePlan };

const generatedName = (id: string, props: UsagePlanProps) =>
  props.name
    ? Effect.succeed(props.name)
    : createPhysicalName({
        id,
        maxLength: 128,
      });

const encodeJsonPointerSegment = (s: string) =>
  s.replace(/~/g, "~0").replace(/\//g, "~1");

const apiStageKey = (stage: ag.ApiStage) => `${stage.apiId}:${stage.stage}`;

const parseThrottleKey = (key: string) => {
  const idx = key.lastIndexOf("/");
  if (idx <= 0) return { resourcePath: key, httpMethod: "*" };
  return {
    resourcePath: key.slice(0, idx),
    httpMethod: key.slice(idx + 1),
  };
};

const buildApiStageThrottlePatches = (
  stageKey: string,
  prev: { [key: string]: ag.ThrottleSettings | undefined } | undefined,
  next: { [key: string]: ag.ThrottleSettings | undefined } | undefined,
): ag.PatchOperation[] => {
  const keys = new Set([
    ...Object.keys(prev ?? {}),
    ...Object.keys(next ?? {}),
  ]);
  const patches: ag.PatchOperation[] = [];
  for (const key of keys) {
    const old = prev?.[key];
    const current = next?.[key];
    const { resourcePath, httpMethod } = parseThrottleKey(key);
    const base = `/apiStages/${encodeJsonPointerSegment(stageKey)}/throttle/${encodeJsonPointerSegment(resourcePath)}/${encodeJsonPointerSegment(httpMethod)}`;
    if (current?.burstLimit !== old?.burstLimit) {
      patches.push(
        current?.burstLimit === undefined
          ? { op: "remove", path: `${base}/burstLimit` }
          : {
              op: "replace",
              path: `${base}/burstLimit`,
              value: String(current.burstLimit),
            },
      );
    }
    if (current?.rateLimit !== old?.rateLimit) {
      patches.push(
        current?.rateLimit === undefined
          ? { op: "remove", path: `${base}/rateLimit` }
          : {
              op: "replace",
              path: `${base}/rateLimit`,
              value: String(current.rateLimit),
            },
      );
    }
  }
  return patches;
};

const buildApiStagePatches = (
  prev: ag.ApiStage[] | undefined,
  next: ag.ApiStage[] | undefined,
): ag.PatchOperation[] => {
  const prevMap = new Map((prev ?? []).map((s) => [apiStageKey(s), s]));
  const nextMap = new Map((next ?? []).map((s) => [apiStageKey(s), s]));
  const patches: ag.PatchOperation[] = [];
  for (const [key] of prevMap) {
    if (!nextMap.has(key)) {
      patches.push({ op: "remove", path: "/apiStages", value: key });
    }
  }
  for (const [key, stage] of nextMap) {
    const old = prevMap.get(key);
    if (!old) {
      patches.push({ op: "add", path: "/apiStages", value: key });
      patches.push(
        ...buildApiStageThrottlePatches(key, undefined, stage.throttle),
      );
      continue;
    }
    if (!deepEqual(stage.throttle, old.throttle)) {
      patches.push(
        ...buildApiStageThrottlePatches(key, old.throttle, stage.throttle),
      );
    }
  }
  return patches;
};

const buildThrottlePatches = (
  prev: ag.ThrottleSettings | undefined,
  next: ag.ThrottleSettings | undefined,
) => {
  const patches: ag.PatchOperation[] = [];
  if (next?.burstLimit !== prev?.burstLimit) {
    patches.push(
      next?.burstLimit === undefined
        ? { op: "remove", path: "/throttle/burstLimit" }
        : {
            op: "replace",
            path: "/throttle/burstLimit",
            value: String(next.burstLimit),
          },
    );
  }
  if (next?.rateLimit !== prev?.rateLimit) {
    patches.push(
      next?.rateLimit === undefined
        ? { op: "remove", path: "/throttle/rateLimit" }
        : {
            op: "replace",
            path: "/throttle/rateLimit",
            value: String(next.rateLimit),
          },
    );
  }
  return patches;
};

const buildQuotaPatches = (
  prev: ag.QuotaSettings | undefined,
  next: ag.QuotaSettings | undefined,
) => {
  const patches: ag.PatchOperation[] = [];
  if (next?.limit !== prev?.limit) {
    patches.push(
      next?.limit === undefined
        ? { op: "remove", path: "/quota/limit" }
        : {
            op: "replace",
            path: "/quota/limit",
            value: String(next.limit),
          },
    );
  }
  if (next?.offset !== prev?.offset) {
    patches.push(
      next?.offset === undefined
        ? { op: "remove", path: "/quota/offset" }
        : {
            op: "replace",
            path: "/quota/offset",
            value: String(next.offset),
          },
    );
  }
  if (next?.period !== prev?.period) {
    patches.push(
      next?.period === undefined
        ? { op: "remove", path: "/quota/period" }
        : { op: "replace", path: "/quota/period", value: next.period },
    );
  }
  return patches;
};

export const UsagePlanProvider = () =>
  Provider.effect(
    UsagePlanResource,
    Effect.gen(function* () {
      const awsRegion = yield* Region;

      return {
        stables: ["id"] as const,
        diff: Effect.fn(function* ({ news: newsIn, olds }) {
          if (!isResolved(newsIn)) return;
          const news = newsIn as UsagePlanProps;
          if (news.name !== undefined && news.name !== olds.name) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.id) return undefined;
          const p = yield* ag
            .getUsagePlan({ usagePlanId: output.id })
            .pipe(
              Effect.catchTag("NotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (!p?.id) return undefined;
          return {
            id: p.id,
            name: p.name,
            description: p.description,
            apiStages: p.apiStages,
            throttle: p.throttle,
            quota: p.quota,
            tags: tagRecord(p.tags),
          };
        }),
        reconcile: Effect.fn(function* ({ id, news: newsIn, output, session }) {
          if (!isResolved(newsIn)) {
            return yield* Effect.die("UsagePlan props were not resolved");
          }
          const news = newsIn as UsagePlanProps;
          const name = yield* generatedName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // Observe — fetch live usage plan if we have a cached id. We
          // never trust `output.apiStages`/`output.throttle`/etc. for
          // diffing; we re-read every reconcile so adoption converges.
          let observed = output?.id
            ? yield* ag
                .getUsagePlan({ usagePlanId: output.id })
                .pipe(
                  Effect.catchTag("NotFoundException", () =>
                    Effect.succeed(undefined),
                  ),
                )
            : undefined;

          // Ensure — create the usage plan if missing.
          if (!observed?.id) {
            const created = yield* ag.createUsagePlan({
              name,
              description: news.description,
              apiStages: news.apiStages,
              throttle: news.throttle,
              quota: news.quota,
              tags: desiredTags,
            });
            if (!created.id)
              return yield* Effect.die("createUsagePlan missing id");
            yield* session.note(`Created usage plan ${created.id}`);
            observed = yield* ag.getUsagePlan({ usagePlanId: created.id });
          }

          const planId = observed.id!;

          // Sync mutable plan fields — diff observed cloud state against
          // desired and emit only the delta as PATCH operations.
          const patches: ag.PatchOperation[] = [];
          if (news.description !== observed.description) {
            patches.push({
              op: "replace",
              path: "/description",
              value: news.description ?? "",
            });
          }
          patches.push(
            ...buildApiStagePatches(observed.apiStages, news.apiStages),
          );
          patches.push(
            ...buildThrottlePatches(observed.throttle, news.throttle),
          );
          patches.push(...buildQuotaPatches(observed.quota, news.quota));
          if (patches.length > 0) {
            yield* ag.updateUsagePlan({
              usagePlanId: planId,
              patchOperations: patches,
            });
          }

          // Sync tags — observed ↔ desired.
          const observedTags = tagRecord(observed.tags);
          if (!deepEqual(observedTags, desiredTags)) {
            yield* syncTags({
              resourceArn: usagePlanArn(awsRegion, planId),
              oldTags: observedTags,
              newTags: desiredTags,
            });
          }

          yield* session.note(`Reconciled usage plan ${planId}`);
          const final = yield* ag.getUsagePlan({ usagePlanId: planId });
          return {
            id: planId,
            name: final.name,
            description: final.description,
            apiStages: final.apiStages,
            throttle: final.throttle,
            quota: final.quota,
            tags: tagRecord(final.tags),
          };
        }),
        delete: Effect.fn(function* ({ output, session }) {
          yield* ag
            .deleteUsagePlan({ usagePlanId: output.id })
            .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
          yield* session.note(`Deleted usage plan ${output.id}`);
        }),
      };
    }),
  );
