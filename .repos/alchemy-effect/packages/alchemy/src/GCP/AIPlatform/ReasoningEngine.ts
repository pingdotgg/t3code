import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  compact,
  normalizeLocation,
  parentOf,
  parseName,
  stableJson,
  toPhysicalId,
  listLocations,
} from "./names.ts";
import { resourceNameFromOperation, waitForOperation } from "./operations.ts";

export type ReasoningEngineSpec =
  aiplatform.GoogleCloudAiplatformV1ReasoningEngineSpec;
export type ReasoningEngineContextSpec =
  aiplatform.GoogleCloudAiplatformV1ReasoningEngineContextSpec;
export type ReasoningEngineEncryptionSpec =
  aiplatform.GoogleCloudAiplatformV1EncryptionSpec;

export type ReasoningEngineProps = {
  /**
   * Engine id (the `{reasoning_engine}` segment). Vertex assigns this on
   * create. Pass the value from a previous deploy to target the same
   * engine. Immutable — changing it replaces the engine.
   */
  reasoningEngineId?: string;
  /**
   * Vertex AI location. Immutable — changing it replaces the engine.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Display name. Required by Vertex. Defaults to a generated id.
   */
  displayName?: string;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Engine configurations (framework, source, package, container).
   */
  spec?: ReasoningEngineSpec;
  /**
   * Context management (Memory Bank) configuration.
   */
  contextSpec?: ReasoningEngineContextSpec;
  /**
   * Customer-managed encryption key. Immutable — changing it replaces
   * the engine.
   */
  encryptionSpec?: ReasoningEngineEncryptionSpec;
};

export type ReasoningEngine = Resource<
  "GCP.AIPlatform.ReasoningEngine",
  ReasoningEngineProps,
  {
    /** Full resource name. */
    name: string;
    /** Engine id (last path segment). */
    reasoningEngineId: string;
    /** Location id. */
    location: string;
    /** Project id. */
    project: string;
    /** Display name. */
    displayName: string | undefined;
    /** Description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Agent framework. */
    agentFramework: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** Etag for read-modify-write. */
    etag: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Vertex AI Reasoning Engine (Agent Engine) — a customizable runtime
 * for models that choose which actions to take and in which order.
 *
 * Changing `reasoningEngineId`, `location`, or `encryptionSpec` replaces
 * the engine. Display name, description, labels, and spec update in place.
 *
 * ### Creating a Reasoning Engine
 * **Example:** Display name and labels
 * ```typescript
 * const engine = yield* GCP.AIPlatform.ReasoningEngine("Agent", {
 *   displayName: "support-agent",
 *   labels: { env: "prod" },
 *   spec: { agentFramework: "custom" },
 * });
 * ```
 *
 * ### Querying
 * **Example:** Call the default query method
 * ```typescript
 * const query = yield* GCP.AIPlatform.QueryReasoningEngine(engine);
 * const result = yield* query({ body: { input: { input: "hello" } } });
 * ```
 *
 * @resource
 * @category AIPlatform
 */
export const ReasoningEngine = Resource<ReasoningEngine>(
  "GCP.AIPlatform.ReasoningEngine",
);

export class ReasoningEngineNotResolved extends Data.TaggedError(
  "GCP.AIPlatform.ReasoningEngineNotResolved",
)<{
  name: string;
}> {}

export class ReasoningEngineStillExists extends Data.TaggedError(
  "GCP.AIPlatform.ReasoningEngineStillExists",
)<{
  name: string;
}> {}

const resourceName = (
  project: string,
  location: string,
  reasoningEngineId: string,
) =>
  `projects/${project}/locations/${location}/reasoningEngines/${reasoningEngineId}`;

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toAttrs = (
  engine: aiplatform.GoogleCloudAiplatformV1ReasoningEngine,
  project: string,
) => {
  const name = engine.name ?? "";
  const parsed = parseName(name, "reasoningEngines");
  return {
    name,
    reasoningEngineId: parsed.resourceId,
    location: parsed.location,
    project: parsed.project || project,
    displayName: engine.displayName,
    description: engine.description,
    labels: userLabels(engine.labels),
    agentFramework: engine.spec?.agentFramework,
    createTime: engine.createTime,
    updateTime: engine.updateTime,
    etag: engine.etag,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : aiplatform
        .getProjectsLocationsReasoningEngines({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string) =>
  aiplatform.listProjectsLocationsReasoningEngines
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.reasoningEngines ?? []),
      ),
      Stream.take(500),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

export const listAlchemyReasoningEngines = (
  project: string,
  location: string,
) =>
  listAt(parentOf(project, location)).pipe(
    Effect.map((engines) =>
      engines.filter((engine) =>
        Object.keys(engine.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ),
    ),
  );

const findOwned = (id: string, parent: string) =>
  Effect.gen(function* () {
    const expected = yield* createInternalLabels(id);
    const engines = yield* listAt(parent);
    return engines.find((engine) =>
      Object.entries(expected).every(
        ([key, value]) => (engine.labels ?? {})[key] === value,
      ),
    );
  });

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((engine) =>
      engine === undefined
        ? Effect.void
        : Effect.fail(new ReasoningEngineStillExists({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.AIPlatform.ReasoningEngineStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

// Engine writes share a small per-minute regional quota ("Reasoning Engine
// Write Requests per minute per region"); wait out the window.
const retryWriteQuota = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (error) => error._tag === "TooManyRequests",
      times: 8,
      schedule: Schedule.spaced("15 seconds"),
    }),
  );

export const ReasoningEngineProvider = () =>
  Provider.succeed(ReasoningEngine, {
    stables: ["name", "reasoningEngineId", "location", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      const env = yield* GcpEnvironment.current;
      if (!isResolved(news)) return undefined;
      const previousId = olds?.reasoningEngineId ?? output?.reasoningEngineId;
      const nextId = news.reasoningEngineId ?? previousId;
      const idChanged =
        previousId !== undefined &&
        nextId !== undefined &&
        nextId !== previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const encryptionChanged =
        (news.encryptionSpec?.kmsKeyName ?? "") !==
        (olds?.encryptionSpec?.kmsKeyName ?? "");
      if (
        idChanged ||
        previousLocation !== nextLocation ||
        (olds !== undefined && encryptionChanged)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ??
        (olds?.reasoningEngineId !== undefined
          ? resourceName(env.project, location, olds.reasoningEngineId)
          : "");
      const existing =
        (name.length > 0 ? yield* getByName(name) : undefined) ??
        (yield* findOwned(id, parentOf(env.project, location)));
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const engines = (yield* Effect.forEach(
          listLocations(env.region),
          (location) => listAt(parentOf(env.project, location)),
        )).flat();
        return engines
          .filter((engine) =>
            Object.keys(engine.labels ?? {}).some((key) =>
              key.startsWith("alchemy-"),
            ),
          )
          .map((engine) => toAttrs(engine, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const parent = parentOf(env.project, location);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const displayName =
        news.displayName ??
        (yield* toPhysicalId(
          id,
          news.reasoningEngineId,
          output?.reasoningEngineId,
        ));

      let current =
        (output?.name !== undefined
          ? yield* getByName(output.name)
          : undefined) ?? (yield* findOwned(id, parent));

      if (current === undefined) {
        const created = yield* retryWriteQuota(
          aiplatform.createProjectsLocationsReasoningEngines({
            parent,
            body: compact({
              displayName,
              description: news.description,
              labels: desiredLabels,
              spec: news.spec,
              contextSpec: news.contextSpec,
              encryptionSpec: news.encryptionSpec,
            }),
          }),
        ).pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created, { alreadyExistsOk: true });
        }
        const createdName = resourceNameFromOperation(created ?? {});
        current =
          createdName !== undefined
            ? yield* getByName(createdName)
            : yield* findOwned(id, parent);
      }

      if (current === undefined || current.name === undefined) {
        return yield* new ReasoningEngineNotResolved({
          name: output?.name ?? parent,
        });
      }

      const observedName = current.name;
      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const displayChanged = (current.displayName ?? "") !== displayName;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const specChanged =
        stableJson(current.spec) !== stableJson(news.spec ?? current.spec);

      if (
        labelsChanged ||
        displayChanged ||
        descriptionChanged ||
        specChanged
      ) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          displayChanged ? "display_name" : undefined,
          descriptionChanged ? "description" : undefined,
          specChanged ? "spec" : undefined,
        ].filter((field): field is string => field !== undefined);
        const patched = yield* retryWriteQuota(
          aiplatform.patchProjectsLocationsReasoningEngines({
            name: observedName,
            updateMask: updateMask.join(","),
            body: compact({
              name: observedName,
              displayName,
              description: news.description,
              labels: desiredLabels,
              spec: news.spec,
              etag: current.etag,
            }),
          }),
        );
        yield* waitForOperation(patched);
        current = yield* getByName(observedName);
      }

      if (current === undefined) {
        return yield* new ReasoningEngineNotResolved({ name: observedName });
      }
      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* retryWriteQuota(
        aiplatform.deleteProjectsLocationsReasoningEngines({
          name: output.name,
          force: true,
        }),
      ).pipe(
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        Effect.catchTag("BadRequest", () => Effect.succeed(undefined)),
      );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
