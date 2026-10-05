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
import { hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  createInternalLabels,
  hasAlchemyPrefix,
  labelsDiffer,
  listLocations,
  locationOf,
  lastSegment,
  projectOf,
  stableJson,
  toDisplayName,
  toLabels,
  toResourceId,
  userLabels,
} from "./names.ts";
import { waitForOperation } from "./operations.ts";

const DEFAULT_SCHEMA_TITLE = "system.Run";

export type MetadataStoresExecutionProps = {
  /**
   * Parent MetadataStore resource name
   * `projects/{project}/locations/{location}/metadataStores/{metadatastore}`.
   * Immutable — changing it replaces the execution.
   */
  metadataStore: string;
  /**
   * Execution id. If omitted, a unique id is generated. Must be 4-128
   * characters of `a-z` and `-`. Immutable.
   */
  executionId?: string;
  /**
   * Display name (max 128 Unicode characters).
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
   * Execution lifecycle state.
   */
  state?: aiplatform.GoogleCloudAiplatformV1ExecutionStateEnum | (string & {});
  /**
   * Schema title registered in the MetadataStore. Vertex AI rejects
   * entries without one.
   * @default "system.Run"
   */
  schemaTitle?: string;
  /**
   * Schema version registered in the MetadataStore.
   */
  schemaVersion?: string;
  /**
   * Arbitrary metadata properties.
   */
  metadata?: aiplatform.DocumentMap;
};

export type MetadataStoresExecution = Resource<
  "GCP.AIPlatform.MetadataStoresExecution",
  MetadataStoresExecutionProps,
  {
    /** Full resource name. */
    name: string;
    /** Execution id (last path segment). */
    executionId: string;
    /** Parent MetadataStore resource name. */
    metadataStore: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** User-provided description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Execution state. */
    state: string | undefined;
    /** Schema title. */
    schemaTitle: string | undefined;
    /** Schema version. */
    schemaVersion: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Vertex ML Metadata Execution associated with a MetadataStore.
 *
 * Changing `metadataStore` or `executionId` replaces the execution. Display
 * name, description, labels, state, schema, and metadata update in place.
 *
 * ### Creating an Execution
 * **Example:** Training execution
 * ```typescript
 * const execution = yield* GCP.AIPlatform.MetadataStoresExecution("Train", {
 *   metadataStore: store.name,
 *   displayName: "train-step",
 *   state: "RUNNING",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category AIPlatform
 */
export const MetadataStoresExecution = Resource<MetadataStoresExecution>(
  "GCP.AIPlatform.MetadataStoresExecution",
);

export class MetadataStoresExecutionNotResolved extends Data.TaggedError(
  "GCP.AIPlatform.MetadataStoresExecutionNotResolved",
)<{
  name: string;
}> {}

export class MetadataStoresExecutionStillExists extends Data.TaggedError(
  "GCP.AIPlatform.MetadataStoresExecutionStillExists",
)<{
  name: string;
}> {}

const parentOf = (name: string) => {
  const at = name.lastIndexOf("/executions/");
  return at >= 0 ? name.slice(0, at) : name;
};

const resourceName = (metadataStore: string, executionId: string) =>
  `${metadataStore}/executions/${executionId}`;

const toAttrs = (
  execution: aiplatform.GoogleCloudAiplatformV1Execution,
  project: string,
) => {
  const name = execution.name ?? "";
  return {
    name,
    executionId: lastSegment(name),
    metadataStore: parentOf(name),
    project: projectOf(name, project),
    location: locationOf(name),
    displayName: execution.displayName,
    description: execution.description,
    labels: userLabels(execution.labels),
    state: execution.state,
    schemaTitle: execution.schemaTitle,
    schemaVersion: execution.schemaVersion,
    createTime: execution.createTime,
    updateTime: execution.updateTime,
  };
};

const getByName = (name: string) =>
  aiplatform
    .getProjectsLocationsMetadataStoresExecutions({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listExecutions = (parent: string) =>
  aiplatform.listProjectsLocationsMetadataStoresExecutions
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.runCollect,
      Effect.map((pages) =>
        Array.from(pages).flatMap((page) => page.executions ?? []),
      ),
      Effect.catchTag("NotFound", () =>
        Effect.succeed([] as aiplatform.GoogleCloudAiplatformV1Execution[]),
      ),
    );

const listStores = (parent: string) =>
  aiplatform.listProjectsLocationsMetadataStores
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.runCollect,
      Effect.map((pages) =>
        Array.from(pages).flatMap((page) => page.metadataStores ?? []),
      ),
      Effect.catchTag("NotFound", () =>
        Effect.succeed([] as aiplatform.GoogleCloudAiplatformV1MetadataStore[]),
      ),
    );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (execution) => execution === undefined,
      () => new MetadataStoresExecutionStillExists({ name }),
    ),
    Effect.asVoid,
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.AIPlatform.MetadataStoresExecutionStillExists",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const MetadataStoresExecutionProvider = () =>
  Provider.succeed(MetadataStoresExecution, {
    stables: [
      "name",
      "executionId",
      "metadataStore",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.metadataStore ?? output?.metadataStore;
      const nextParent = news.metadataStore ?? previousParent;
      const previousId = olds?.executionId ?? output?.executionId;
      const nextId = news.executionId ?? previousId;
      if (
        (previousParent !== undefined &&
          nextParent !== undefined &&
          nextParent !== previousParent) ||
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId)
      ) {
        return {
          action: "replace" as const,
          deleteFirst:
            previousParent === nextParent &&
            previousId !== undefined &&
            nextId === previousId,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const executionId = yield* toResourceId(
        id,
        olds?.executionId,
        output?.executionId,
      );
      const metadataStore = olds?.metadataStore ?? output?.metadataStore;
      const name =
        output?.name ??
        (metadataStore !== undefined
          ? resourceName(metadataStore, executionId)
          : "");
      if (name.length === 0) return undefined;
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const stores = yield* Effect.forEach(
          listLocations(env.region),
          (location) =>
            listStores(`projects/${env.project}/locations/${location}`),
          { concurrency: 4 },
        );
        const executions = yield* Effect.forEach(
          stores.flat().filter((store) => store.name !== undefined),
          (store) => listExecutions(store.name!),
          { concurrency: 4 },
        );
        return executions
          .flat()
          .filter((execution) => hasAlchemyPrefix(execution.labels))
          .map((execution) => toAttrs(execution, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const executionId = yield* toResourceId(
        id,
        news.executionId,
        output?.executionId,
      );
      const metadataStore = news.metadataStore;
      const name = resourceName(metadataStore, executionId);
      const displayName = yield* toDisplayName(
        id,
        news.displayName,
        output?.displayName,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* aiplatform
          .createProjectsLocationsMetadataStoresExecutions({
            parent: metadataStore,
            executionId,
            body: {
              displayName,
              description: news.description,
              labels: desiredLabels,
              state: news.state,
              schemaTitle: news.schemaTitle ?? DEFAULT_SCHEMA_TITLE,
              schemaVersion: news.schemaVersion,
              metadata: news.metadata,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new MetadataStoresExecutionNotResolved({ name });
      }

      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const displayChanged = (current.displayName ?? "") !== displayName;
      const labelsChanged = labelsDiffer(current.labels, desiredLabels);
      const stateChanged = (current.state ?? "") !== (news.state ?? "");
      const schemaTitleChanged =
        (current.schemaTitle ?? "") !==
        (news.schemaTitle ?? DEFAULT_SCHEMA_TITLE);
      const schemaVersionChanged =
        (current.schemaVersion ?? "") !== (news.schemaVersion ?? "");
      const metadataChanged =
        news.metadata !== undefined &&
        stableJson(current.metadata) !== stableJson(news.metadata);

      if (
        descriptionChanged ||
        displayChanged ||
        labelsChanged ||
        stateChanged ||
        schemaTitleChanged ||
        schemaVersionChanged ||
        metadataChanged
      ) {
        current =
          yield* aiplatform.patchProjectsLocationsMetadataStoresExecutions({
            name,
            updateMask: [
              descriptionChanged ? "description" : undefined,
              displayChanged ? "display_name" : undefined,
              labelsChanged ? "labels" : undefined,
              stateChanged ? "state" : undefined,
              schemaTitleChanged ? "schema_title" : undefined,
              schemaVersionChanged ? "schema_version" : undefined,
              metadataChanged ? "metadata" : undefined,
            ]
              .filter((field): field is string => field !== undefined)
              .join(","),
            body: {
              name,
              displayName,
              description: news.description,
              labels: desiredLabels,
              state: news.state,
              schemaTitle: news.schemaTitle ?? DEFAULT_SCHEMA_TITLE,
              schemaVersion: news.schemaVersion,
              metadata: news.metadata,
              etag: current.etag,
            },
          });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* aiplatform
        .deleteProjectsLocationsMetadataStoresExecutions({
          name: output.name,
        })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
