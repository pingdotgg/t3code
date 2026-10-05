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

const DEFAULT_SCHEMA_TITLE = "system.Artifact";

export type MetadataStoresArtifactProps = {
  /**
   * Parent MetadataStore resource name
   * `projects/{project}/locations/{location}/metadataStores/{metadatastore}`.
   * Immutable — changing it replaces the artifact.
   */
  metadataStore: string;
  /**
   * Artifact id. If omitted, a unique id is generated. Must be 4-128
   * characters of `a-z` and `-`. Immutable.
   */
  artifactId?: string;
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
   * Uniform resource identifier of the artifact file.
   */
  uri?: string;
  /**
   * Artifact lifecycle state.
   */
  state?: aiplatform.GoogleCloudAiplatformV1ArtifactStateEnum | (string & {});
  /**
   * Schema title registered in the MetadataStore. Vertex AI rejects
   * entries without one.
   * @default "system.Artifact"
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

export type MetadataStoresArtifact = Resource<
  "GCP.AIPlatform.MetadataStoresArtifact",
  MetadataStoresArtifactProps,
  {
    /** Full resource name. */
    name: string;
    /** Artifact id (last path segment). */
    artifactId: string;
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
    /** Artifact URI. */
    uri: string | undefined;
    /** Artifact state. */
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
 * A Vertex ML Metadata Artifact associated with a MetadataStore.
 *
 * Changing `metadataStore` or `artifactId` replaces the artifact. Display
 * name, description, labels, URI, state, schema, and metadata update in
 * place.
 *
 * ### Creating an Artifact
 * **Example:** Generated id
 * ```typescript
 * const artifact = yield* GCP.AIPlatform.MetadataStoresArtifact("Model", {
 *   metadataStore: store.name,
 *   displayName: "trained-model",
 *   uri: "gs://bucket/model",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category AIPlatform
 */
export const MetadataStoresArtifact = Resource<MetadataStoresArtifact>(
  "GCP.AIPlatform.MetadataStoresArtifact",
);

export class MetadataStoresArtifactNotResolved extends Data.TaggedError(
  "GCP.AIPlatform.MetadataStoresArtifactNotResolved",
)<{
  name: string;
}> {}

export class MetadataStoresArtifactStillExists extends Data.TaggedError(
  "GCP.AIPlatform.MetadataStoresArtifactStillExists",
)<{
  name: string;
}> {}

const parentOf = (name: string) => {
  const at = name.lastIndexOf("/artifacts/");
  return at >= 0 ? name.slice(0, at) : name;
};

const resourceName = (metadataStore: string, artifactId: string) =>
  `${metadataStore}/artifacts/${artifactId}`;

const toAttrs = (
  artifact: aiplatform.GoogleCloudAiplatformV1Artifact,
  project: string,
) => {
  const name = artifact.name ?? "";
  return {
    name,
    artifactId: lastSegment(name),
    metadataStore: parentOf(name),
    project: projectOf(name, project),
    location: locationOf(name),
    displayName: artifact.displayName,
    description: artifact.description,
    labels: userLabels(artifact.labels),
    uri: artifact.uri,
    state: artifact.state,
    schemaTitle: artifact.schemaTitle,
    schemaVersion: artifact.schemaVersion,
    createTime: artifact.createTime,
    updateTime: artifact.updateTime,
  };
};

const getByName = (name: string) =>
  aiplatform
    .getProjectsLocationsMetadataStoresArtifacts({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listArtifacts = (parent: string) =>
  aiplatform.listProjectsLocationsMetadataStoresArtifacts
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.runCollect,
      Effect.map((pages) =>
        Array.from(pages).flatMap((page) => page.artifacts ?? []),
      ),
      Effect.catchTag("NotFound", () =>
        Effect.succeed([] as aiplatform.GoogleCloudAiplatformV1Artifact[]),
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
      (artifact) => artifact === undefined,
      () => new MetadataStoresArtifactStillExists({ name }),
    ),
    Effect.asVoid,
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.AIPlatform.MetadataStoresArtifactStillExists",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const MetadataStoresArtifactProvider = () =>
  Provider.succeed(MetadataStoresArtifact, {
    stables: [
      "name",
      "artifactId",
      "metadataStore",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.metadataStore ?? output?.metadataStore;
      const nextParent = news.metadataStore ?? previousParent;
      const previousId = olds?.artifactId ?? output?.artifactId;
      const nextId = news.artifactId ?? previousId;
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
      const artifactId = yield* toResourceId(
        id,
        olds?.artifactId,
        output?.artifactId,
      );
      const metadataStore = olds?.metadataStore ?? output?.metadataStore;
      const name =
        output?.name ??
        (metadataStore !== undefined
          ? resourceName(metadataStore, artifactId)
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
        const artifacts = yield* Effect.forEach(
          stores.flat().filter((store) => store.name !== undefined),
          (store) => listArtifacts(store.name!),
          { concurrency: 4 },
        );
        return artifacts
          .flat()
          .filter((artifact) => hasAlchemyPrefix(artifact.labels))
          .map((artifact) => toAttrs(artifact, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const artifactId = yield* toResourceId(
        id,
        news.artifactId,
        output?.artifactId,
      );
      const metadataStore = news.metadataStore;
      const name = resourceName(metadataStore, artifactId);
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
          .createProjectsLocationsMetadataStoresArtifacts({
            parent: metadataStore,
            artifactId,
            body: {
              displayName,
              description: news.description,
              labels: desiredLabels,
              uri: news.uri,
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
        return yield* new MetadataStoresArtifactNotResolved({ name });
      }

      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const displayChanged = (current.displayName ?? "") !== displayName;
      const labelsChanged = labelsDiffer(current.labels, desiredLabels);
      const uriChanged = (current.uri ?? "") !== (news.uri ?? "");
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
        uriChanged ||
        stateChanged ||
        schemaTitleChanged ||
        schemaVersionChanged ||
        metadataChanged
      ) {
        current =
          yield* aiplatform.patchProjectsLocationsMetadataStoresArtifacts({
            name,
            updateMask: [
              descriptionChanged ? "description" : undefined,
              displayChanged ? "display_name" : undefined,
              labelsChanged ? "labels" : undefined,
              uriChanged ? "uri" : undefined,
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
              uri: news.uri,
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
        .deleteProjectsLocationsMetadataStoresArtifacts({
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
