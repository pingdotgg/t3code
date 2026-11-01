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

export type DataScanDataSource = dataplex.GoogleCloudDataplexV1DataSource;
export type DataScanExecutionSpec =
  dataplex.GoogleCloudDataplexV1DataScanExecutionSpec;
export type DataScanExecutionIdentity =
  dataplex.GoogleCloudDataplexV1ExecutionIdentity;
export type DataQualitySpec = dataplex.GoogleCloudDataplexV1DataQualitySpec;
export type DataProfileSpec = dataplex.GoogleCloudDataplexV1DataProfileSpec;
export type DataDiscoverySpec = dataplex.GoogleCloudDataplexV1DataDiscoverySpec;
export type DataDocumentationSpec =
  dataplex.GoogleCloudDataplexV1DataDocumentationSpec;
export type UnstructuredDataProfileSpec =
  dataplex.GoogleCloudDataplexV1UnstructuredDataProfileSpec;

export type DataScanProps = {
  /**
   * DataScan id. If omitted, a unique name is generated. Must contain
   * only lowercase letters, numbers and hyphens, start with a letter,
   * end with a letter or number, and be 1-63 characters. Immutable —
   * changing it replaces the scan.
   */
  dataScanId?: string;
  /**
   * Region (`us-central1`, …). Immutable — changing it replaces the
   * scan.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Description (1-1024 characters).
   */
  description?: string;
  /**
   * User-friendly display name (1-256 characters).
   */
  displayName?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Immutable data source (Dataplex entity or BigQuery / GCS resource).
   * Changing it replaces the scan.
   */
  data: DataScanDataSource;
  /**
   * Execution settings. Defaults to on-demand.
   */
  executionSpec?: DataScanExecutionSpec;
  /**
   * Immutable identity used to run the scan. Changing it replaces the
   * scan.
   */
  executionIdentity?: DataScanExecutionIdentity;
  /**
   * Data quality scan settings. Mutually exclusive with the other spec
   * fields.
   */
  dataQualitySpec?: DataQualitySpec;
  /**
   * Data profile scan settings.
   */
  dataProfileSpec?: DataProfileSpec;
  /**
   * Data discovery scan settings.
   */
  dataDiscoverySpec?: DataDiscoverySpec;
  /**
   * Data documentation scan settings.
   */
  dataDocumentationSpec?: DataDocumentationSpec;
  /**
   * Unstructured data profile scan settings.
   */
  unstructuredDataProfileSpec?: UnstructuredDataProfileSpec;
};

export type DataScan = Resource<
  "GCP.Dataplex.DataScan",
  DataScanProps,
  {
    /** Full resource name. */
    name: string;
    /** DataScan id (last path segment). */
    dataScanId: string;
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
    /** Current state. */
    state: string | undefined;
    /** Data source. */
    data: DataScanDataSource | undefined;
    /** Execution spec. */
    executionSpec: DataScanExecutionSpec | undefined;
    /** Scan type. */
    type: string | undefined;
    /** Data quality spec, if any. */
    dataQualitySpec: DataQualitySpec | undefined;
    /** Data profile spec, if any. */
    dataProfileSpec: DataProfileSpec | undefined;
    /** Data discovery spec, if any. */
    dataDiscoverySpec: DataDiscoverySpec | undefined;
    /** Data documentation spec, if any. */
    dataDocumentationSpec: DataDocumentationSpec | undefined;
    /** Unstructured data profile spec, if any. */
    unstructuredDataProfileSpec: UnstructuredDataProfileSpec | undefined;
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
 * A Dataplex DataScan that profiles, quality-checks, discovers, or
 * documents a BigQuery table, dataset, or Cloud Storage bucket.
 *
 * Location, scan id, data source, and execution identity are immutable.
 * Description, display name, labels, execution spec, and scan specs
 * update in place.
 *
 * ### Creating a DataScan
 * **Example:** On-demand profile scan of a BigQuery table
 * ```typescript
 * const scan = yield* GCP.Dataplex.DataScan("OrdersProfile", {
 *   displayName: "orders profile",
 *   labels: { env: "test" },
 *   data: {
 *     resource:
 *       "//bigquery.googleapis.com/projects/my-project/datasets/sales/tables/orders",
 *   },
 *   dataProfileSpec: {},
 * });
 * ```
 *
 * @resource
 * @category Dataplex
 */
export const DataScan = Resource<DataScan>("GCP.Dataplex.DataScan");

const resourceName = (project: string, location: string, dataScanId: string) =>
  `projects/${project}/locations/${location}/dataScans/${dataScanId}`;

const toAttrs = (
  scan: dataplex.GoogleCloudDataplexV1DataScan,
  project: string,
) => {
  const name = scan.name ?? "";
  const parsed = parseName(name, "dataScans");
  return {
    name,
    dataScanId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    description: scan.description,
    displayName: scan.displayName,
    labels: userLabels(scan.labels),
    state: scan.state,
    data: scan.data,
    executionSpec: scan.executionSpec,
    type: scan.type,
    dataQualitySpec: scan.dataQualitySpec,
    dataProfileSpec: scan.dataProfileSpec,
    dataDiscoverySpec: scan.dataDiscoverySpec,
    dataDocumentationSpec: scan.dataDocumentationSpec,
    unstructuredDataProfileSpec: scan.unstructuredDataProfileSpec,
    uid: scan.uid,
    createTime: scan.createTime,
    updateTime: scan.updateTime,
  };
};

const getByName = (name: string) =>
  retryQuota(
    dataplex.getProjectsLocationsDataScans({ name, view: "FULL" }),
  ).pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listScans = (project: string, region: string) => {
  const collect = (parent: string) =>
    collectPages(
      dataplex.listProjectsLocationsDataScans.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.dataScans,
    ).pipe(
      Effect.map((items) =>
        items.filter((item) => hasAlchemyLabelMap(item.labels)),
      ),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );
  return listAtLocation(project, region, collect);
};

const dataSourceOf = (data: DataScanDataSource | undefined) => ({
  entity: data?.entity ?? "",
  resource: data?.resource ?? "",
});

export const DataScanProvider = () =>
  Provider.succeed(DataScan, {
    stables: ["name", "dataScanId", "project", "location", "uid", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousId: olds?.dataScanId ?? output?.dataScanId,
        nextId: news.dataScanId ?? olds?.dataScanId ?? output?.dataScanId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra:
          fingerprint(dataSourceOf(news.data)) !==
            fingerprint(dataSourceOf(olds?.data ?? output?.data)) ||
          fingerprint(news.executionIdentity ?? olds?.executionIdentity) !==
            fingerprint(olds?.executionIdentity),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const dataScanId = yield* toPhysicalId(
        id,
        olds?.dataScanId,
        output?.dataScanId,
        "datascan",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, dataScanId);
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
        const items = yield* listScans(env.project, env.region);
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const dataScanId = yield* toPhysicalId(
        id,
        news.dataScanId,
        output?.dataScanId,
        "datascan",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, dataScanId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* retryQuota(
          dataplex.createProjectsLocationsDataScans({
            parent: parentOf(env.project, location),
            dataScanId,
            body: {
              description: news.description,
              displayName: news.displayName,
              labels: desiredLabels,
              data: news.data,
              executionSpec: news.executionSpec,
              executionIdentity: news.executionIdentity,
              dataQualitySpec: news.dataQualitySpec,
              dataProfileSpec: news.dataProfileSpec,
              dataDiscoverySpec: news.dataDiscoverySpec,
              dataDocumentationSpec: news.dataDocumentationSpec,
              unstructuredDataProfileSpec: news.unstructuredDataProfileSpec,
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
      const executionChanged =
        fingerprint(current.executionSpec) !== fingerprint(news.executionSpec);
      const qualityChanged =
        fingerprint(current.dataQualitySpec) !==
        fingerprint(news.dataQualitySpec);
      const profileChanged =
        fingerprint(current.dataProfileSpec) !==
        fingerprint(news.dataProfileSpec);
      const discoveryChanged =
        fingerprint(current.dataDiscoverySpec) !==
        fingerprint(news.dataDiscoverySpec);
      const documentationChanged =
        fingerprint(current.dataDocumentationSpec) !==
        fingerprint(news.dataDocumentationSpec);
      const unstructuredChanged =
        fingerprint(current.unstructuredDataProfileSpec) !==
        fingerprint(news.unstructuredDataProfileSpec);

      if (
        labelsChanged ||
        descriptionChanged ||
        displayNameChanged ||
        executionChanged ||
        qualityChanged ||
        profileChanged ||
        discoveryChanged ||
        documentationChanged ||
        unstructuredChanged
      ) {
        const operation = yield* retryQuota(
          dataplex.patchProjectsLocationsDataScans({
            name: current.name ?? name,
            updateMask: [
              labelsChanged ? "labels" : undefined,
              descriptionChanged ? "description" : undefined,
              displayNameChanged ? "displayName" : undefined,
              executionChanged ? "executionSpec" : undefined,
              qualityChanged ? "dataQualitySpec" : undefined,
              profileChanged ? "dataProfileSpec" : undefined,
              discoveryChanged ? "dataDiscoverySpec" : undefined,
              documentationChanged ? "dataDocumentationSpec" : undefined,
              unstructuredChanged ? "unstructuredDataProfileSpec" : undefined,
            ]
              .filter((field): field is string => field !== undefined)
              .join(","),
            body: {
              name: current.name ?? name,
              description: news.description,
              displayName: news.displayName,
              labels: desiredLabels,
              executionSpec: news.executionSpec,
              dataQualitySpec: news.dataQualitySpec,
              dataProfileSpec: news.dataProfileSpec,
              dataDiscoverySpec: news.dataDiscoverySpec,
              dataDocumentationSpec: news.dataDocumentationSpec,
              unstructuredDataProfileSpec: news.unstructuredDataProfileSpec,
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
        dataplex.deleteProjectsLocationsDataScans({
          name: output.name,
          force: true,
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
