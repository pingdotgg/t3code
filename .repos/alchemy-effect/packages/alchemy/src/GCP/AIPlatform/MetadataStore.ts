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
import { hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  createInternalLabels,
  encodeDescription,
  hasOwnershipMarker,
  listLocations,
  locationOf,
  lastSegment,
  normalizeLocation,
  parseDescription,
  projectOf,
  toResourceId,
} from "./names.ts";
import { waitForOperation } from "./operations.ts";

export type MetadataStoreProps = {
  /**
   * MetadataStore id (the `{metadatastore}` segment of
   * `projects/{project}/locations/{location}/metadataStores/{metadatastore}`).
   * If omitted, a unique name is generated. Must be 4-128 characters of
   * `a-z` and `-`. Immutable — changing it replaces the store.
   */
  metadataStoreId?: string;
  /**
   * Vertex AI location. Immutable — changing it replaces the store.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Human-readable description. Metadata stores have no labels field, so
   * Alchemy ownership is stored in a `[alchemy …]` prefix and stripped
   * from attributes.
   */
  description?: string;
  /**
   * Customer-managed encryption key. Immutable.
   */
  encryptionSpec?: aiplatform.GoogleCloudAiplatformV1EncryptionSpec;
  /**
   * Dataplex integration settings.
   */
  dataplexConfig?: aiplatform.GoogleCloudAiplatformV1MetadataStoreDataplexConfig;
};

export type MetadataStore = Resource<
  "GCP.AIPlatform.MetadataStore",
  MetadataStoreProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/metadataStores/{metadatastore}`. */
    name: string;
    /** MetadataStore id (last path segment). */
    metadataStoreId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Disk utilization of the store, in bytes. */
    diskUtilizationBytes: string | undefined;
    /** KMS key used for encryption, if any. */
    kmsKeyName: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Vertex ML Metadata store for artifacts, contexts, and executions.
 *
 * Metadata stores have no labels field, so Alchemy stamps ownership into
 * the description for `list` / nuke. There is no update API — changing
 * identity, location, encryption, or Dataplex config replaces the store.
 *
 * ### Creating a MetadataStore
 * **Example:** Generated id
 * ```typescript
 * const store = yield* GCP.AIPlatform.MetadataStore("Mlmd", {
 *   description: "pipeline metadata",
 * });
 * ```
 *
 * @resource
 * @category AIPlatform
 */
export const MetadataStore = Resource<MetadataStore>(
  "GCP.AIPlatform.MetadataStore",
);

export class MetadataStoreNotResolved extends Data.TaggedError(
  "GCP.AIPlatform.MetadataStoreNotResolved",
)<{
  name: string;
}> {}

export class MetadataStoreStillExists extends Data.TaggedError(
  "GCP.AIPlatform.MetadataStoreStillExists",
)<{
  name: string;
}> {}

const resourceName = (
  project: string,
  location: string,
  metadataStoreId: string,
) =>
  `projects/${project}/locations/${location}/metadataStores/${metadataStoreId}`;

const toAttrs = (
  store: aiplatform.GoogleCloudAiplatformV1MetadataStore,
  project: string,
) => {
  const name = store.name ?? "";
  const parsed = parseDescription(store.description);
  return {
    name,
    metadataStoreId: lastSegment(name),
    project: projectOf(name, project),
    location: locationOf(name),
    description: parsed.description,
    diskUtilizationBytes: store.state?.diskUtilizationBytes,
    kmsKeyName: store.encryptionSpec?.kmsKeyName,
    createTime: store.createTime,
    updateTime: store.updateTime,
  };
};

const getByName = (name: string) =>
  aiplatform
    .getProjectsLocationsMetadataStores({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listPage = (parent: string) =>
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

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (store): store is aiplatform.GoogleCloudAiplatformV1MetadataStore =>
        store !== undefined,
      () => new MetadataStoreNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.AIPlatform.MetadataStoreNotResolved",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (store) => store === undefined,
      () => new MetadataStoreStillExists({ name }),
    ),
    Effect.asVoid,
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.AIPlatform.MetadataStoreStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const MetadataStoreProvider = () =>
  Provider.succeed(MetadataStore, {
    stables: [
      "name",
      "metadataStoreId",
      "project",
      "location",
      "kmsKeyName",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      const env = yield* GcpEnvironment.current;
      if (!isResolved(news)) return undefined;
      const previousId = olds?.metadataStoreId ?? output?.metadataStoreId;
      const nextId = news.metadataStoreId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      const previousKms =
        olds?.encryptionSpec?.kmsKeyName ?? output?.kmsKeyName ?? "";
      const nextKms = news.encryptionSpec?.kmsKeyName ?? previousKms;
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        nextKms !== previousKms
      ) {
        return {
          action: "replace" as const,
          deleteFirst:
            previousLocation === nextLocation &&
            previousId !== undefined &&
            nextId === previousId,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const metadataStoreId = yield* toResourceId(
        id,
        olds?.metadataStoreId,
        output?.metadataStoreId,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, metadataStoreId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* Effect.forEach(
          listLocations(env.region),
          (location) =>
            listPage(`projects/${env.project}/locations/${location}`),
          { concurrency: 4 },
        );
        return pages
          .flat()
          .filter((store) => hasOwnershipMarker(store.description))
          .map((store) => toAttrs(store, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const metadataStoreId = yield* toResourceId(
        id,
        news.metadataStoreId,
        output?.metadataStoreId,
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, metadataStoreId);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* aiplatform
          .createProjectsLocationsMetadataStores({
            parent: `projects/${env.project}/locations/${location}`,
            metadataStoreId,
            body: {
              description: desiredDescription,
              encryptionSpec: news.encryptionSpec,
              dataplexConfig: news.dataplexConfig,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(name);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* aiplatform
        .deleteProjectsLocationsMetadataStores({
          name: output.name,
          force: true,
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
