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

const DEFAULT_SCHEMA_TITLE = "system.Experiment";

export type MetadataStoresContextProps = {
  /**
   * Parent MetadataStore resource name
   * `projects/{project}/locations/{location}/metadataStores/{metadatastore}`.
   * Immutable — changing it replaces the context.
   */
  metadataStore: string;
  /**
   * Context id. If omitted, a unique id is generated. Must be 4-128
   * characters of `a-z` and `-`. Immutable.
   */
  contextId?: string;
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
   * Schema title registered in the MetadataStore. Vertex AI rejects
   * entries without one.
   * @default "system.Experiment"
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

export type MetadataStoresContext = Resource<
  "GCP.AIPlatform.MetadataStoresContext",
  MetadataStoresContextProps,
  {
    /** Full resource name. */
    name: string;
    /** Context id (last path segment). */
    contextId: string;
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
    /** Schema title. */
    schemaTitle: string | undefined;
    /** Schema version. */
    schemaVersion: string | undefined;
    /** Parent context resource names. */
    parentContexts: string[];
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Vertex ML Metadata Context associated with a MetadataStore.
 *
 * Changing `metadataStore` or `contextId` replaces the context. Display
 * name, description, labels, schema, and metadata update in place.
 *
 * ### Creating a Context
 * **Example:** Experiment context
 * ```typescript
 * const context = yield* GCP.AIPlatform.MetadataStoresContext("Experiment", {
 *   metadataStore: store.name,
 *   displayName: "training-run",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category AIPlatform
 */
export const MetadataStoresContext = Resource<MetadataStoresContext>(
  "GCP.AIPlatform.MetadataStoresContext",
);

export class MetadataStoresContextNotResolved extends Data.TaggedError(
  "GCP.AIPlatform.MetadataStoresContextNotResolved",
)<{
  name: string;
}> {}

export class MetadataStoresContextStillExists extends Data.TaggedError(
  "GCP.AIPlatform.MetadataStoresContextStillExists",
)<{
  name: string;
}> {}

const parentOf = (name: string) => {
  const at = name.lastIndexOf("/contexts/");
  return at >= 0 ? name.slice(0, at) : name;
};

const resourceName = (metadataStore: string, contextId: string) =>
  `${metadataStore}/contexts/${contextId}`;

const toAttrs = (
  context: aiplatform.GoogleCloudAiplatformV1Context,
  project: string,
) => {
  const name = context.name ?? "";
  return {
    name,
    contextId: lastSegment(name),
    metadataStore: parentOf(name),
    project: projectOf(name, project),
    location: locationOf(name),
    displayName: context.displayName,
    description: context.description,
    labels: userLabels(context.labels),
    schemaTitle: context.schemaTitle,
    schemaVersion: context.schemaVersion,
    parentContexts: context.parentContexts ?? [],
    createTime: context.createTime,
    updateTime: context.updateTime,
  };
};

const getByName = (name: string) =>
  aiplatform
    .getProjectsLocationsMetadataStoresContexts({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listContexts = (parent: string) =>
  aiplatform.listProjectsLocationsMetadataStoresContexts
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.runCollect,
      Effect.map((pages) =>
        Array.from(pages).flatMap((page) => page.contexts ?? []),
      ),
      Effect.catchTag("NotFound", () =>
        Effect.succeed([] as aiplatform.GoogleCloudAiplatformV1Context[]),
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
      (context) => context === undefined,
      () => new MetadataStoresContextStillExists({ name }),
    ),
    Effect.asVoid,
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.AIPlatform.MetadataStoresContextStillExists",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const MetadataStoresContextProvider = () =>
  Provider.succeed(MetadataStoresContext, {
    stables: [
      "name",
      "contextId",
      "metadataStore",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.metadataStore ?? output?.metadataStore;
      const nextParent = news.metadataStore ?? previousParent;
      const previousId = olds?.contextId ?? output?.contextId;
      const nextId = news.contextId ?? previousId;
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
      const contextId = yield* toResourceId(
        id,
        olds?.contextId,
        output?.contextId,
      );
      const metadataStore = olds?.metadataStore ?? output?.metadataStore;
      const name =
        output?.name ??
        (metadataStore !== undefined
          ? resourceName(metadataStore, contextId)
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
        const contexts = yield* Effect.forEach(
          stores.flat().filter((store) => store.name !== undefined),
          (store) => listContexts(store.name!),
          { concurrency: 4 },
        );
        return contexts
          .flat()
          .filter((context) => hasAlchemyPrefix(context.labels))
          .map((context) => toAttrs(context, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const contextId = yield* toResourceId(
        id,
        news.contextId,
        output?.contextId,
      );
      const metadataStore = news.metadataStore;
      const name = resourceName(metadataStore, contextId);
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
          .createProjectsLocationsMetadataStoresContexts({
            parent: metadataStore,
            contextId,
            body: {
              displayName,
              description: news.description,
              labels: desiredLabels,
              schemaTitle: news.schemaTitle ?? DEFAULT_SCHEMA_TITLE,
              schemaVersion: news.schemaVersion,
              metadata: news.metadata,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new MetadataStoresContextNotResolved({ name });
      }

      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const displayChanged = (current.displayName ?? "") !== displayName;
      const labelsChanged = labelsDiffer(current.labels, desiredLabels);
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
        schemaTitleChanged ||
        schemaVersionChanged ||
        metadataChanged
      ) {
        current =
          yield* aiplatform.patchProjectsLocationsMetadataStoresContexts({
            name,
            updateMask: [
              descriptionChanged ? "description" : undefined,
              displayChanged ? "display_name" : undefined,
              labelsChanged ? "labels" : undefined,
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
        .deleteProjectsLocationsMetadataStoresContexts({
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
