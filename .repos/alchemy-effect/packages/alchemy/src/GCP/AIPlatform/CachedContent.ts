import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { listLocations } from "./names.ts";
import {
  encodeOwnership,
  hasOwnershipMarker,
  normalizeLocation,
  parentOf,
  parseOwnership,
  parseResourceName,
  rfc1035,
} from "./internal.ts";
import type { EncryptionSpec } from "./shared.ts";

export type CachedContentPart = {
  /** Text content of the part. */
  text?: string;
};

export type CachedContentMessage = {
  /**
   * Producer of the content (`user` or `model`). Defaults to `user`.
   */
  role?: string;
  /** Parts that make up the message. */
  parts?: CachedContentPart[];
};

export type CachedContentProps = {
  /**
   * Region. Immutable — changing it replaces the cache.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Publisher model used for the cache, for example
   * `projects/{project}/locations/{location}/publishers/google/models/gemini-2.0-flash-001`.
   * Immutable — changing it replaces the cache.
   */
  model: string;
  /**
   * Content to cache. Immutable — changing it replaces the cache.
   */
  contents?: CachedContentMessage[];
  /**
   * Developer system instruction (text only). Immutable — changing it
   * replaces the cache.
   */
  systemInstruction?: CachedContentMessage;
  /**
   * TTL such as `"3600s"`. The API computes `expireTime = now + ttl`.
   * This is the only field that updates in place (along with
   * `expireTime`).
   */
  ttl?: string;
  /**
   * Absolute expiration (RFC3339). Mutually exclusive with `ttl` on
   * update; either field may be patched.
   */
  expireTime?: string;
  /**
   * User-facing display name. Alchemy stamps ownership here (cached
   * content has no labels) so `list` / nuke can find the cache.
   */
  displayName?: string;
  /**
   * Customer-managed encryption. Immutable — changing it replaces the
   * cache.
   */
  encryptionSpec?: EncryptionSpec;
};

export type CachedContent = Resource<
  "GCP.AIPlatform.CachedContent",
  CachedContentProps,
  {
    /** Full resource name `.../cachedContents/{cached_content}`. */
    name: string;
    /** Cached content id (last path segment). */
    cachedContentId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Model resource name. */
    model: string | undefined;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Absolute expiration (RFC3339). */
    expireTime: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** Total tokens consumed by the cache. */
    totalTokenCount: number | undefined;
    /** Customer-managed KMS key, if any. */
    kmsKeyName: string | undefined;
  },
  never,
  Providers
>;

/**
 * Vertex AI cached content — explicit context cache for LLM queries.
 *
 * Cached content has no labels field, so Alchemy stamps ownership into
 * `displayName` for `list` / nuke. Model, contents, system instruction,
 * and CMEK are immutable. TTL / expire time update in place.
 *
 * ### Creating Cached Content
 * **Example:** Cache a system prompt for Gemini
 * ```typescript
 * const cache = yield* GCP.AIPlatform.CachedContent("Style", {
 *   model:
 *     "projects/my-project/locations/us-central1/publishers/google/models/gemini-2.0-flash-001",
 *   ttl: "3600s",
 *   contents: [
 *     { role: "user", parts: [{ text: "You are a terse assistant." }] },
 *   ],
 * });
 * ```
 *
 * ### Updating expiry
 * **Example:** Extend TTL
 * ```typescript
 * // Same logical id, changed TTL: the engine updates it in place.
 * const cache = yield* GCP.AIPlatform.CachedContent("Style", {
 *   model:
 *     "projects/my-project/locations/us-central1/publishers/google/models/gemini-2.0-flash-001",
 *   ttl: "7200s",
 *   contents: [
 *     { role: "user", parts: [{ text: "You are a terse assistant." }] },
 *   ],
 * });
 * ```
 *
 * @resource
 * @category AIPlatform
 */
export const CachedContent = Resource<CachedContent>(
  "GCP.AIPlatform.CachedContent",
);

export class CachedContentNotResolved extends Data.TaggedError(
  "GCP.AIPlatform.CachedContentNotResolved",
)<{
  name: string;
}> {}

const toContents = (
  contents: readonly CachedContentMessage[] | undefined,
): aiplatform.GoogleCloudAiplatformV1Content[] | undefined => {
  if (contents === undefined) return undefined;
  return contents.map((content) => ({
    role: content.role,
    parts: (content.parts ?? [])
      .filter((part) => part.text !== undefined)
      .map((part) => ({ text: part.text })),
  }));
};

const toAttrs = (
  cache: aiplatform.GoogleCloudAiplatformV1CachedContent,
  project: string,
) => {
  const name = cache.name ?? "";
  const parsed = parseResourceName(name, "cachedContents");
  const ownership = parseOwnership(cache.displayName);
  return {
    name,
    cachedContentId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    model: cache.model,
    displayName: ownership.text,
    expireTime: cache.expireTime,
    createTime: cache.createTime,
    updateTime: cache.updateTime,
    totalTokenCount: cache.usageMetadata?.totalTokenCount,
    kmsKeyName: cache.encryptionSpec?.kmsKeyName,
  };
};

const getByName = (name: string) =>
  aiplatform
    .getProjectsLocationsCachedContents({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listCaches = (project: string, region: string) => {
  const collect = (parent: string) =>
    aiplatform.listProjectsLocationsCachedContents
      .pages({ parent, pageSize: 100 })
      .pipe(
        Stream.flatMap((page) =>
          Stream.fromIterable(page.cachedContents ?? []),
        ),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
      );
  const fallback = Effect.forEach(listLocations(region), (location) =>
    collect(`projects/${project}/locations/${location}`),
  ).pipe(Effect.map((pages) => pages.flat()));
  // Vertex AI has no `locations/-` wildcard; scan known locations.
  return fallback.pipe(Effect.catchTag("NotFound", () => Effect.succeed([])));
};

const findOwned = (
  id: string,
  project: string,
  region: string,
  hinted?: string,
) =>
  Effect.gen(function* () {
    if (hinted !== undefined && hinted.length > 0) {
      const existing = yield* getByName(hinted);
      if (existing !== undefined) return existing;
    }
    const caches = yield* listCaches(project, region);
    for (const cache of caches) {
      const { labels } = parseOwnership(cache.displayName);
      if (yield* hasAlchemyLabels(id, labels)) return cache;
    }
    return undefined as
      | aiplatform.GoogleCloudAiplatformV1CachedContent
      | undefined;
  });

const fallbackDisplayName = (id: string) =>
  Effect.gen(function* () {
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: 63,
        lowercase: true,
      }),
    );
  });

export const CachedContentProvider = () =>
  Provider.succeed(CachedContent, {
    stables: [
      "name",
      "cachedContentId",
      "project",
      "location",
      "model",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      const env = yield* GcpEnvironment.current;
      if (!isResolved(news)) return undefined;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      const previousModel = olds?.model ?? output?.model ?? "";
      const previousKey =
        olds?.encryptionSpec?.kmsKeyName ?? output?.kmsKeyName ?? "";
      const nextKey = news.encryptionSpec?.kmsKeyName ?? previousKey;
      const replace =
        previousLocation !== nextLocation ||
        news.model !== previousModel ||
        nextKey !== previousKey;
      if (!replace) return undefined;
      return { action: "replace" as const, deleteFirst: true };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const existing = yield* findOwned(
        id,
        env.project,
        env.region,
        output?.name,
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseOwnership(existing.displayName);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const caches = yield* listCaches(env.project, env.region);
        return caches
          .filter((cache) => hasOwnershipMarker(cache.displayName))
          .map((cache) => toAttrs(cache, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const internal = yield* createInternalLabels(id);
      const desiredDisplayName = encodeOwnership(
        internal,
        news.displayName ?? (yield* fallbackDisplayName(id)),
        " ",
      );

      let current = yield* findOwned(id, env.project, env.region, output?.name);

      if (current === undefined) {
        const created = yield* aiplatform
          .createProjectsLocationsCachedContents({
            parent: parentOf(env.project, location),
            body: {
              model: news.model,
              contents: toContents(news.contents),
              systemInstruction: news.systemInstruction
                ? toContents([news.systemInstruction])?.[0]
                : undefined,
              ttl: news.ttl,
              expireTime: news.expireTime,
              displayName: desiredDisplayName,
              encryptionSpec: news.encryptionSpec,
            },
          })
          .pipe(
            // Vertex AI intermittently counts large content as "1 tokens".
            Effect.retry({
              while: (error) => error._tag === "CachedContentTooFewTokens",
              times: 4,
              schedule: Schedule.spaced("3 seconds"),
            }),
            Effect.catchTag("Conflict", () =>
              findOwned(id, env.project, env.region),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new CachedContentNotResolved({
          name: output?.name ?? parentOf(env.project, location),
        });
      }

      const name = current.name ?? "";
      const ttlChanged = news.ttl !== undefined && news.ttl.length > 0;
      const expireChanged =
        news.expireTime !== undefined &&
        news.expireTime !== (current.expireTime ?? "");

      if (ttlChanged || expireChanged) {
        current = yield* aiplatform.patchProjectsLocationsCachedContents({
          name,
          updateMask: ttlChanged ? "ttl" : "expire_time",
          body: {
            name,
            ttl: ttlChanged ? news.ttl : undefined,
            expireTime: expireChanged ? news.expireTime : undefined,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* aiplatform
        .deleteProjectsLocationsCachedContents({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
