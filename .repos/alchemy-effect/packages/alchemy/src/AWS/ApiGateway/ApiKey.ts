import { Region } from "@distilled.cloud/aws/Region";
import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { deepEqual, isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createInternalTags, hasAlchemyTags, tagRecord } from "../../Tags.ts";

import { apiKeyArn, syncTags } from "./common.ts";

export interface ApiKeyProps {
  /**
   * Friendly name for the API key.
   *
   * If omitted, Alchemy generates a deterministic physical name from the
   * stack, stage, logical ID, and instance ID.
   */
  name?: string;
  /**
   * Human-readable description shown in API Gateway.
   */
  description?: string;
  /**
   * Whether clients can use the key.
   *
   * @default true
   */
  enabled?: boolean;
  /**
   * Appends a distinct suffix to the generated key value when AWS generates it.
   */
  generateDistinctId?: boolean;
  /**
   * Write-only value when creating; never stored in resource state or outputs.
   * Wrap with `Redacted.make` so state encoding preserves redaction.
   */
  value?: Redacted.Redacted<string>;
  /**
   * Stage associations to attach directly to this API key.
   */
  stageKeys?: ag.StageKey[];
  /**
   * External customer identifier associated with the key.
   */
  customerId?: string;
  /**
   * User-defined tags. Alchemy internal tags are merged automatically.
   */
  tags?: Record<string, string>;
}

export interface ApiKey extends Resource<
  "AWS.ApiGateway.ApiKey",
  ApiKeyProps,
  {
    id: string;
    name: string | undefined;
    enabled: boolean | undefined;
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * API Gateway API key for usage plans and `apiKeyRequired` methods.
 *
 * @section API keys
 * @example Generated key
 * ```typescript
 * const key = yield* ApiGateway.ApiKey("PartnerKey", {
 *   generateDistinctId: true,
 * });
 * ```
 */
const ApiKeyResource = Resource<ApiKey>("AWS.ApiGateway.ApiKey");

export { ApiKeyResource as ApiKey };

const resolvedValue = (value: Redacted.Redacted<string> | undefined) =>
  value ? Redacted.value(value) : undefined;

const generatedName = (id: string, props: ApiKeyProps) =>
  props.name
    ? Effect.succeed(props.name)
    : createPhysicalName({
        id,
        maxLength: 128,
      });

const readByName = Effect.fn(function* (id: string, name: string) {
  const keys = yield* ag.getApiKeys
    .items({ nameQuery: name, limit: 500, includeValues: false })
    .pipe(Stream.runCollect);

  for (const key of keys) {
    if (key.name !== name || !key.id) continue;
    if (yield* hasAlchemyTags(id, key.tags)) {
      return key;
    }
  }
  return undefined;
});

export const ApiKeyProvider = () =>
  Provider.effect(
    ApiKeyResource,
    Effect.gen(function* () {
      const awsRegion = yield* Region;

      return {
        stables: ["id"] as const,
        diff: Effect.fn(function* ({ news: newsIn, olds }) {
          if (!isResolved(newsIn)) return;
          const news = newsIn as ApiKeyProps;
          if (
            // API Gateway never returns the key value after create, so rotating
            // a user-supplied value is modeled as replacement instead of patch.
            resolvedValue(news.value) !== resolvedValue(olds.value) ||
            news.customerId !== olds.customerId
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.id) return undefined;
          const k = yield* ag
            .getApiKey({ apiKey: output.id, includeValue: false })
            .pipe(
              Effect.catchTag("NotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (!k?.id) return undefined;
          return {
            id: k.id,
            name: k.name,
            enabled: k.enabled,
            tags: tagRecord(k.tags),
          };
        }),
        reconcile: Effect.fn(function* ({ id, news: newsIn, output, session }) {
          if (!isResolved(newsIn)) {
            return yield* Effect.die("ApiKey props were not resolved");
          }
          const news = newsIn as ApiKeyProps;
          const name = yield* generatedName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // Observe — find the API key. We try the cached id first, fall
          // back to scanning by name with the alchemy ownership filter so
          // the reconciler converges after an out-of-band recreate or an
          // adoption that bypassed our id cache.
          let observed = output?.id
            ? yield* ag
                .getApiKey({ apiKey: output.id, includeValue: false })
                .pipe(
                  Effect.catchTag("NotFoundException", () =>
                    Effect.succeed(undefined),
                  ),
                )
            : undefined;
          if (!observed?.id) {
            observed = yield* readByName(id, name);
          }

          // Ensure — create if missing. Tolerate `ConflictException` as a
          // race with a peer reconciler or a stray key with the same name:
          // re-look up by name and treat the alchemy-owned hit as observed.
          if (!observed?.id) {
            const created = yield* ag
              .createApiKey({
                name,
                description: news.description,
                enabled: news.enabled,
                generateDistinctId: news.generateDistinctId,
                value: resolvedValue(news.value),
                stageKeys: news.stageKeys,
                customerId: news.customerId,
                tags: desiredTags,
              })
              .pipe(
                Effect.catchTag("ConflictException", () =>
                  Effect.gen(function* () {
                    const existing = yield* readByName(id, name);
                    if (existing) return existing;
                    return yield* Effect.fail(
                      new ag.ConflictException({
                        message: `API key '${name}' already exists and is not managed by alchemy`,
                      }),
                    );
                  }),
                ),
              );
            if (!created.id)
              return yield* Effect.die("createApiKey missing id");
            yield* session.note(`Created API key ${created.id}`);
            observed = yield* ag.getApiKey({
              apiKey: created.id,
              includeValue: false,
            });
          }

          const apiKeyId = observed.id!;

          // Sync mutable scalar fields — observed ↔ desired patch list.
          const patches: ag.PatchOperation[] = [];
          if (news.name !== undefined && news.name !== observed.name) {
            patches.push({
              op: "replace",
              path: "/name",
              value: news.name,
            });
          }
          if (
            news.description !== undefined &&
            news.description !== observed.description
          ) {
            patches.push({
              op: "replace",
              path: "/description",
              value: news.description,
            });
          }
          if (news.enabled !== undefined && news.enabled !== observed.enabled) {
            patches.push({
              op: "replace",
              path: "/enabled",
              value: String(news.enabled),
            });
          }
          if (patches.length > 0) {
            yield* ag.updateApiKey({
              apiKey: apiKeyId,
              patchOperations: patches,
            });
          }

          // Sync tags — diff observed cloud tags against desired so adoption
          // converges without fighting whatever tag set was already there.
          const observedTags = tagRecord(observed.tags);
          if (!deepEqual(observedTags, desiredTags)) {
            yield* syncTags({
              resourceArn: apiKeyArn(awsRegion, apiKeyId),
              oldTags: observedTags,
              newTags: desiredTags,
            });
          }

          yield* session.note(`Reconciled API key ${apiKeyId}`);
          const final = yield* ag.getApiKey({
            apiKey: apiKeyId,
            includeValue: false,
          });
          if (!final.id) return yield* Effect.die("getApiKey missing id");
          return {
            id: final.id,
            name: final.name,
            enabled: final.enabled,
            tags: tagRecord(final.tags),
          };
        }),
        delete: Effect.fn(function* ({ output, session }) {
          yield* ag
            .deleteApiKey({ apiKey: output.id })
            .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
          yield* session.note(`Deleted API key ${output.id}`);
        }),
      };
    }),
  );
