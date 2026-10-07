import * as apigee from "@distilled.cloud/gcp/apigee_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeDescription,
  hasOwnershipMarker,
  parseDescription,
} from "./ownership.ts";
import {
  lastSegment,
  orgParent,
  resolveOrgId,
  sameJson,
  toPhysicalId,
} from "./operations.ts";

const MAX_NAME_LENGTH = 255;

export type DatastoreConfig = {
  /**
   * Google Cloud project that owns the destination bucket or dataset.
   */
  projectId?: string;
  /**
   * Cloud Storage bucket name. Required when `targetType` is `gcs`.
   */
  bucketName?: string;
  /**
   * Path inside the Cloud Storage bucket. Required when `targetType` is
   * `gcs`.
   */
  path?: string;
  /**
   * BigQuery dataset name. Required when `targetType` is `bigquery`.
   */
  datasetName?: string;
  /**
   * BigQuery table prefix. Required when `targetType` is `bigquery`.
   */
  tablePrefix?: string;
};

export type AnalyticsDatastoreProps = {
  /**
   * Apigee organization id. Defaults to the GCP project id.
   * Immutable — changing it replaces the datastore.
   */
  organizationId?: string;
  /**
   * Display name shown in the UI. If omitted, a unique name is generated.
   * Alchemy ownership is stored in a `[alchemy …]` prefix.
   */
  displayName?: string;
  /**
   * Destination storage type: `gcs` or `bigquery`.
   * @default "gcs"
   */
  targetType?: string;
  /**
   * Destination configuration.
   */
  datastoreConfig?: DatastoreConfig;
};

export type AnalyticsDatastore = Resource<
  "GCP.Apigee.AnalyticsDatastore",
  AnalyticsDatastoreProps,
  {
    /** Resource name `organizations/{org}/analytics/datastores/{id}`. */
    name: string;
    /** Server-assigned datastore id. */
    datastoreId: string;
    /** Organization id. */
    organizationId: string;
    /** Project id. */
    project: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Destination type (`gcs` or `bigquery`). */
    targetType: string | undefined;
    /** Destination configuration. */
    datastoreConfig: DatastoreConfig | undefined;
    /** Create time in milliseconds since epoch. */
    createTime: string | undefined;
    /** Last update time in milliseconds since epoch. */
    lastUpdateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Apigee analytics datastore — an export target (Cloud Storage or
 * BigQuery) for organization analytics.
 *
 * Datastores have no labels field. Alchemy stamps ownership into
 * `displayName` so `list` / nuke can find them. The datastore id is
 * server-assigned.
 *
 * ### Creating a Datastore
 * **Example:** GCS export target
 * ```typescript
 * const store = yield* GCP.Apigee.AnalyticsDatastore("Exports", {
 *   targetType: "gcs",
 *   datastoreConfig: {
 *     projectId: "my-project",
 *     bucketName: "apigee-analytics",
 *     path: "exports",
 *   },
 * });
 * ```
 *
 * **Example:** BigQuery export target
 * ```typescript
 * const store = yield* GCP.Apigee.AnalyticsDatastore("BqExports", {
 *   targetType: "bigquery",
 *   datastoreConfig: {
 *     projectId: "my-project",
 *     datasetName: "apigee",
 *     tablePrefix: "analytics",
 *   },
 * });
 * ```
 *
 * @resource
 * @category Apigee
 */
export const AnalyticsDatastore = Resource<AnalyticsDatastore>(
  "GCP.Apigee.AnalyticsDatastore",
);

export class AnalyticsDatastoreNotResolved extends Data.TaggedError(
  "GCP.Apigee.AnalyticsDatastoreNotResolved",
)<{
  name: string;
}> {}

const resourceName = (organizationId: string, datastoreId: string) =>
  `${orgParent(organizationId)}/analytics/datastores/${datastoreId}`;

const normalizeName = (value: string | undefined, organizationId: string) => {
  if (value === undefined || value.length === 0) return undefined;
  const trimmed = value.replace(/^\/+/, "");
  return trimmed.includes("/")
    ? trimmed
    : resourceName(organizationId, trimmed);
};

const toAttrs = (
  datastore: apigee.GoogleCloudApigeeV1Datastore,
  project: string,
  organizationId: string,
) => {
  const name =
    normalizeName(datastore.self, organizationId) ??
    resourceName(organizationId, lastSegment(datastore.self ?? ""));
  const parsed = parseDescription(datastore.displayName);
  const config = datastore.datastoreConfig;
  return {
    name,
    datastoreId: lastSegment(name),
    organizationId: datastore.org ?? organizationId,
    project,
    displayName: parsed.description,
    targetType: datastore.targetType,
    datastoreConfig: config
      ? {
          projectId: config.projectId,
          bucketName: config.bucketName,
          path: config.path,
          datasetName: config.datasetName,
          tablePrefix: config.tablePrefix,
        }
      : undefined,
    createTime: datastore.createTime,
    lastUpdateTime: datastore.lastUpdateTime,
  };
};

const getByName = (name: string) =>
  apigee
    .getOrganizationsAnalyticsDatastores({ name })
    .pipe(
      Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

export const AnalyticsDatastoreProvider = () =>
  Provider.succeed(AnalyticsDatastore, {
    stables: ["name", "datastoreId", "organizationId", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousOrg = olds?.organizationId ?? output?.organizationId;
      const nextOrg = news.organizationId ?? previousOrg;
      if (previousOrg !== undefined && nextOrg !== previousOrg) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const organizationId =
        olds?.organizationId ??
        output?.organizationId ??
        (yield* resolveOrgId(env.project));
      const name = output?.name;
      if (name === undefined) return undefined;
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, organizationId);
      const { labels } = parseDescription(existing.displayName);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const organizationId = yield* resolveOrgId(env.project);
        const page = yield* apigee
          .listOrganizationsAnalyticsDatastores({
            parent: orgParent(organizationId),
          })
          .pipe(
            Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
              Effect.succeed({ datastores: [] }),
            ),
          );
        return (page.datastores ?? [])
          .filter((datastore) => hasOwnershipMarker(datastore.displayName))
          .map((datastore) => toAttrs(datastore, env.project, organizationId));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const organizationId =
        news.organizationId ??
        output?.organizationId ??
        (yield* resolveOrgId(env.project));
      const ownership = yield* createInternalLabels(id);
      const generated = yield* toPhysicalId(
        id,
        news.displayName,
        parseDescription(output?.displayName).description,
        MAX_NAME_LENGTH,
      );
      const desiredDisplayName = encodeDescription(ownership, generated, 255);
      const targetType = news.targetType ?? "gcs";
      const datastoreConfig: apigee.GoogleCloudApigeeV1DatastoreConfig = {
        projectId: news.datastoreConfig?.projectId ?? env.project,
        bucketName: news.datastoreConfig?.bucketName,
        path: news.datastoreConfig?.path,
        datasetName: news.datastoreConfig?.datasetName,
        tablePrefix: news.datastoreConfig?.tablePrefix,
      };

      let current =
        output?.name !== undefined ? yield* getByName(output.name) : undefined;

      if (current === undefined) {
        const created = yield* apigee
          .createOrganizationsAnalyticsDatastores({
            parent: orgParent(organizationId),
            body: {
              displayName: desiredDisplayName,
              targetType,
              datastoreConfig,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AnalyticsDatastoreNotResolved({
          name: output?.name ?? orgParent(organizationId),
        });
      }

      const name =
        normalizeName(current.self, organizationId) ??
        output?.name ??
        resourceName(organizationId, lastSegment(current.self ?? ""));

      const needsUpdate =
        (current.displayName ?? "") !== desiredDisplayName ||
        (current.targetType ?? "") !== targetType ||
        !sameJson(current.datastoreConfig ?? {}, datastoreConfig);

      if (needsUpdate) {
        current = yield* apigee.updateOrganizationsAnalyticsDatastores({
          name,
          body: {
            displayName: desiredDisplayName,
            targetType,
            datastoreConfig,
          },
        });
      }

      return toAttrs(current, env.project, organizationId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* apigee
        .deleteOrganizationsAnalyticsDatastores({ name: output.name })
        .pipe(
          Effect.catchTag(
            ["NotFound", "ApigeeResourceNotFound"],
            () => Effect.void,
          ),
        );
    }),
  });
