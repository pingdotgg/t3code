import * as dataplex from "@distilled.cloud/gcp/dataplex_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
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
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  DataplexNotResolved,
  collectPages,
  fingerprint,
  hasAlchemyLabelMap,
  listAtLocation,
  normalizeLocation,
  parentOf,
  parseName,
  replaceOnIdentity,
  retryQuota,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type AspectTypeMetadataTemplate =
  dataplex.GoogleCloudDataplexV1AspectTypeMetadataTemplate;

export type AspectTypeAuthorization =
  dataplex.GoogleCloudDataplexV1AspectTypeAuthorization;

export type AspectTypeProps = {
  /**
   * AspectType id (the `{aspectType}` segment of
   * `projects/{project}/locations/{location}/aspectTypes/{aspectType}`).
   * If omitted, a unique name is generated. Must be 1-63 characters,
   * start with a letter, and match `[a-z]([a-z0-9-]*[a-z0-9])?`.
   * Immutable — changing it replaces the AspectType.
   */
  aspectTypeId?: string;
  /**
   * Region (`us-central1`, …). Immutable — changing it replaces the
   * AspectType. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User-friendly display name.
   */
  displayName?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Metadata template (JSON schema) for Aspects of this type. Required.
   */
  metadataTemplate: AspectTypeMetadataTemplate;
  /**
   * Immutable data classification. Changing it replaces the AspectType.
   */
  dataClassification?:
    | dataplex.GoogleCloudDataplexV1AspectTypeDataClassificationEnum
    | (string & {});
  /**
   * Immutable authorization for Dataplex Universal Catalog owned types.
   * Changing it replaces the AspectType.
   */
  authorization?: AspectTypeAuthorization;
};

export type AspectType = Resource<
  "GCP.Dataplex.AspectType",
  AspectTypeProps,
  {
    /** Full resource name. */
    name: string;
    /** AspectType id (last path segment). */
    aspectTypeId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Description. */
    description: string | undefined;
    /** Display name. */
    displayName: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Metadata template. */
    metadataTemplate: AspectTypeMetadataTemplate | undefined;
    /** Data classification. */
    dataClassification: string | undefined;
    /** Authorization. */
    authorization: AspectTypeAuthorization | undefined;
    /** Transfer status. */
    transferStatus: string | undefined;
    /** Server etag. */
    etag: string | undefined;
    /** System uid. */
    uid: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Dataplex AspectType — a template for Aspects on catalog Entries.
 *
 * Location, aspect type id, data classification, and authorization are
 * immutable. Description, display name, labels, and the metadata template
 * update in place.
 *
 * ### Creating an AspectType
 * **Example:** Generated id with a string field
 * ```typescript
 * const aspectType = yield* GCP.Dataplex.AspectType("Schema", {
 *   displayName: "schema fields",
 *   labels: { env: "test" },
 *   metadataTemplate: {
 *     name: "schema",
 *     type: "record",
 *     recordFields: [
 *       {
 *         name: "owner",
 *         type: "string",
 *         index: 1,
 *         annotations: { displayName: "Owner" },
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * @resource
 * @category Dataplex
 */
export const AspectType = Resource<AspectType>("GCP.Dataplex.AspectType");

const resourceName = (
  project: string,
  location: string,
  aspectTypeId: string,
) => `projects/${project}/locations/${location}/aspectTypes/${aspectTypeId}`;

const toAttrs = (
  aspectType: dataplex.GoogleCloudDataplexV1AspectType,
  project: string,
) => {
  const name = aspectType.name ?? "";
  const parsed = parseName(name, "aspectTypes");
  return {
    name,
    aspectTypeId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    description: aspectType.description,
    displayName: aspectType.displayName,
    labels: userLabels(aspectType.labels),
    metadataTemplate: aspectType.metadataTemplate,
    dataClassification: aspectType.dataClassification,
    authorization: aspectType.authorization,
    transferStatus: aspectType.transferStatus,
    etag: aspectType.etag,
    uid: aspectType.uid,
    createTime: aspectType.createTime,
    updateTime: aspectType.updateTime,
  };
};

const getByName = (name: string) =>
  retryQuota(dataplex.getProjectsLocationsAspectTypes({ name })).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const listTypes = (project: string, region: string) => {
  const collect = (parent: string) =>
    collectPages(
      dataplex.listProjectsLocationsAspectTypes.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.aspectTypes,
    ).pipe(
      Effect.map((items) =>
        items.filter((item) => hasAlchemyLabelMap(item.labels)),
      ),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );
  return listAtLocation(project, region, collect);
};

export const AspectTypeProvider = () =>
  Provider.succeed(AspectType, {
    stables: [
      "name",
      "aspectTypeId",
      "project",
      "location",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousId: olds?.aspectTypeId ?? output?.aspectTypeId,
        nextId: news.aspectTypeId ?? olds?.aspectTypeId ?? output?.aspectTypeId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra:
          fingerprint(news.dataClassification ?? olds?.dataClassification) !==
            fingerprint(
              olds?.dataClassification ?? output?.dataClassification,
            ) ||
          fingerprint(news.authorization ?? olds?.authorization) !==
            fingerprint(olds?.authorization ?? output?.authorization),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const aspectTypeId = yield* toPhysicalId(
        id,
        olds?.aspectTypeId,
        output?.aspectTypeId,
        "aspecttype",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, aspectTypeId);
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
        const items = yield* listTypes(env.project, env.region);
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const aspectTypeId = yield* toPhysicalId(
        id,
        news.aspectTypeId,
        output?.aspectTypeId,
        "aspecttype",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, aspectTypeId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* retryQuota(
          dataplex.createProjectsLocationsAspectTypes({
            parent: parentOf(env.project, location),
            aspectTypeId,
            body: {
              description: news.description,
              displayName: news.displayName,
              labels: desiredLabels,
              metadataTemplate: news.metadataTemplate,
              dataClassification: news.dataClassification,
              authorization: news.authorization,
            },
          }),
        ).pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new DataplexNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const displayNameChanged =
        (current.displayName ?? "") !== (news.displayName ?? "");
      const templateChanged =
        fingerprint(current.metadataTemplate) !==
        fingerprint(news.metadataTemplate);

      if (
        labelsChanged ||
        descriptionChanged ||
        displayNameChanged ||
        templateChanged
      ) {
        const operation = yield* retryQuota(
          dataplex.patchProjectsLocationsAspectTypes({
            name: current.name ?? name,
            updateMask: [
              labelsChanged ? "labels" : undefined,
              descriptionChanged ? "description" : undefined,
              displayNameChanged ? "displayName" : undefined,
              templateChanged ? "metadataTemplate" : undefined,
            ]
              .filter((field): field is string => field !== undefined)
              .join(","),
            body: {
              name: current.name ?? name,
              etag: current.etag,
              labels: desiredLabels,
              description: news.description,
              displayName: news.displayName,
              metadataTemplate: news.metadataTemplate,
            },
          }),
        );
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* retryQuota(
        dataplex.deleteProjectsLocationsAspectTypes({
          name: output.name,
          etag: output.etag,
        }),
      ).pipe(
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
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
