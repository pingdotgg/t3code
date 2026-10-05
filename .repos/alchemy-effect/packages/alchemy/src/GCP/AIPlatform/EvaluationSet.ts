import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { waitForOperation } from "./operations.ts";
import {
  fingerprint,
  normalizeLocation,
  parseResourceName,
  specifiedEquals,
  toPhysicalRfc1035,
} from "./helpers.ts";

const MAX_NAME_LENGTH = 63;

export type EvaluationSetProps = {
  /**
   * Evaluation set id (the `{evaluation_set}` segment). Assigned by
   * Vertex on create. Provide to target an existing set.
   */
  evaluationSetId?: string;
  /**
   * Region. Immutable — changing it replaces the set.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Display name. Defaults to a generated id when omitted.
   */
  displayName?: string;
  /**
   * Evaluation item resource names that belong to this set.
   */
  evaluationItems: string[];
  /**
   * Static agent configs keyed by agent id.
   */
  agentConfigs?: Record<string, aiplatform.GoogleCloudAiplatformV1AgentConfig>;
  /**
   * Caller metadata. Evaluation Sets have no labels field, so Alchemy
   * ownership keys (`alchemy-stack`, `alchemy-stage`, `alchemy-id`) are
   * merged into this object for `list` / nuke.
   */
  metadata?: unknown;
};

export type EvaluationSet = Resource<
  "GCP.AIPlatform.EvaluationSet",
  EvaluationSetProps,
  {
    /** Full resource name. */
    name: string;
    /** Evaluation set id (last path segment). */
    evaluationSetId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** Member evaluation item names. */
    evaluationItems: string[];
    /** Agent configs. */
    agentConfigs: aiplatform.GoogleCloudAiplatformV1AgentConfigMap | undefined;
    /** Caller metadata with Alchemy ownership keys stripped. */
    metadata: unknown;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Vertex AI Evaluation Set — a collection of Evaluation Items evaluated
 * together.
 *
 * Evaluation Sets have no labels field, so Alchemy stamps ownership into
 * `metadata`. Member items and agent configs update in place; display
 * name, metadata, and location changes replace the set.
 *
 * ### Creating an Evaluation Set
 * **Example:** Group request items
 * ```typescript
 * const set = yield* GCP.AIPlatform.EvaluationSet("Prompts", {
 *   evaluationItems: [item.name],
 * });
 * ```
 *
 * ### Updating an Evaluation Set
 * **Example:** Add items
 * ```typescript
 * // Same logical id, changed props: the engine updates it in place.
 * const set = yield* GCP.AIPlatform.EvaluationSet("Prompts", {
 *   evaluationItems: [item.name, extra.name],
 * });
 * ```
 *
 * @resource
 * @category AIPlatform
 */
export const EvaluationSet = Resource<EvaluationSet>(
  "GCP.AIPlatform.EvaluationSet",
);

export class EvaluationSetNotResolved extends Data.TaggedError(
  "GCP.AIPlatform.EvaluationSetNotResolved",
)<{
  name: string;
}> {}

export class EvaluationSetStillExists extends Data.TaggedError(
  "GCP.AIPlatform.EvaluationSetStillExists",
)<{
  name: string;
}> {}

const resourceName = (project: string, location: string, setId: string) =>
  `projects/${project}/locations/${location}/evaluationSets/${setId}`;

const metadataObject = (value: unknown): Record<string, unknown> => {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>) };
  }
  if (value === undefined) return {};
  return { value };
};

const encodeMetadata = (
  ownership: Record<string, string>,
  metadata: unknown,
): Record<string, unknown> => ({
  ...metadataObject(metadata),
  ...ownership,
});

const stripOwnershipMeta = (metadata: unknown): unknown => {
  const rest = Object.fromEntries(
    Object.entries(metadataObject(metadata)).filter(
      ([key]) => !key.startsWith("alchemy-"),
    ),
  );
  return Object.keys(rest).length === 0 ? undefined : rest;
};

const metadataLabels = (metadata: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadataObject(metadata))) {
    if (key.startsWith("alchemy-") && typeof value === "string") {
      out[key] = value;
    }
  }
  return out;
};

const hasOwnershipMarker = (metadata: unknown) =>
  Object.keys(metadataLabels(metadata)).length > 0;

const sortedItems = (items: readonly string[] | undefined) =>
  [...(items ?? [])].sort((left, right) => left.localeCompare(right));

const toAttrs = (
  set: aiplatform.GoogleCloudAiplatformV1EvaluationSet,
  project: string,
) => {
  const name = set.name ?? "";
  const parsed = parseResourceName(name, "evaluationSets");
  return {
    name,
    evaluationSetId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: set.displayName,
    evaluationItems: sortedItems(set.evaluationItems),
    agentConfigs: set.agentConfigs,
    metadata: stripOwnershipMeta(set.metadata),
    createTime: set.createTime,
    updateTime: set.updateTime,
  };
};

const getByName = (name: string) =>
  aiplatform
    .getProjectsLocationsEvaluationSets({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, location = "-") =>
  aiplatform.listProjectsLocationsEvaluationSets
    .pages({
      parent: `projects/${project}/locations/${location}`,
      pageSize: 100,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.evaluationSets ?? [])),
      Stream.filter((set) => hasOwnershipMarker(set.metadata)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const findOwned = (id: string, project: string, location?: string) =>
  Effect.gen(function* () {
    const sets = yield* listOwned(project, location);
    for (const set of sets) {
      if (yield* hasAlchemyLabels(id, metadataLabels(set.metadata))) {
        return set;
      }
    }
    return undefined;
  });

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((set) =>
      set === undefined
        ? Effect.void
        : Effect.fail(new EvaluationSetStillExists({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.AIPlatform.EvaluationSetStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const EvaluationSetProvider = () =>
  Provider.succeed(EvaluationSet, {
    stables: ["name", "evaluationSetId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      const env = yield* GcpEnvironment.current;
      if (!isResolved(news)) return undefined;
      const previousId = olds?.evaluationSetId ?? output?.evaluationSetId;
      const nextId = news.evaluationSetId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const displayNameChanged =
        olds !== undefined && news.displayName !== olds.displayName;
      const metadataChanged =
        olds !== undefined &&
        fingerprint(news.metadata ?? null) !==
          fingerprint(olds.metadata ?? null);
      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        displayNameChanged ||
        metadataChanged;
      if (!replace) return undefined;
      return { action: "replace" as const, deleteFirst: false };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const setId = olds?.evaluationSetId ?? output?.evaluationSetId;
      const name =
        output?.name ??
        (setId ? resourceName(env.project, location, setId) : undefined);
      const existing = name
        ? yield* getByName(name)
        : yield* findOwned(id, env.project, location);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, metadataLabels(existing.metadata)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const sets = yield* listOwned(env.project);
        return sets.map((set) => toAttrs(set, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const setId = news.evaluationSetId ?? output?.evaluationSetId;
      const name =
        output?.name ??
        (setId ? resourceName(env.project, location, setId) : undefined);
      const ownership = yield* createInternalLabels(id);
      const desiredMetadata = encodeMetadata(ownership, news.metadata);
      const displayName =
        news.displayName ??
        (yield* toPhysicalRfc1035(id, undefined, undefined, MAX_NAME_LENGTH));
      const evaluationItems = sortedItems(news.evaluationItems);

      let current = name
        ? yield* getByName(name)
        : yield* findOwned(id, env.project, location);

      if (current === undefined) {
        current = yield* aiplatform
          .createProjectsLocationsEvaluationSets({
            parent: `projects/${env.project}/locations/${location}`,
            body: {
              displayName,
              evaluationItems,
              agentConfigs: news.agentConfigs,
              metadata: desiredMetadata,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findOwned(id, env.project, location),
            ),
          );
      }

      if (current === undefined) {
        return yield* new EvaluationSetNotResolved({
          name: name ?? displayName,
        });
      }

      const resolvedName = current.name ?? name ?? "";
      // Only `evaluation_items` and `agent_configs` are mutable; display
      // name and metadata changes replace the set (see `diff`).
      const itemsChanged =
        fingerprint(sortedItems(current.evaluationItems)) !==
        fingerprint(evaluationItems);
      const agentChanged =
        news.agentConfigs !== undefined &&
        !specifiedEquals(news.agentConfigs, current.agentConfigs);

      if (itemsChanged || agentChanged) {
        const updateMask = [
          itemsChanged ? "evaluation_items" : undefined,
          agentChanged ? "agent_configs" : undefined,
        ].filter((field): field is string => field !== undefined);

        current = yield* aiplatform
          .patchProjectsLocationsEvaluationSets({
            name: resolvedName,
            updateMask: updateMask.join(","),
            body: {
              name: resolvedName,
              evaluationItems,
              agentConfigs: news.agentConfigs,
            },
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 8,
              schedule: Schedule.spaced("5 seconds"),
            }),
          );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* aiplatform
        .deleteProjectsLocationsEvaluationSets({ name: output.name })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("5 seconds"),
          }),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
