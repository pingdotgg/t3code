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
  lastSegment,
  parseName,
  replaceOnIdentity,
  retryQuota,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";
import { listAlchemyDataProducts } from "./DataProduct.ts";

export type DataAssetAccessGroupConfig =
  dataplex.GoogleCloudDataplexV1DataAssetAccessGroupConfig;

export type DataProductsDataAssetProps = {
  /**
   * Parent Data Product resource name
   * (`projects/{project}/locations/{location}/dataProducts/{dataProduct}`).
   * Immutable — changing it replaces the asset.
   */
  parent: string;
  /**
   * Data asset id. If omitted, a unique name is generated. Must match
   * `^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$`. Immutable — changing it
   * replaces the asset.
   */
  dataAssetId?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Immutable IAM full resource name of the cloud resource. Only BigQuery
   * tables and datasets are currently supported. Changing it replaces
   * the asset.
   */
  resource: string;
  /**
   * Access-group IAM role grants keyed by DataProduct access group id.
   */
  accessGroupConfigs?: Record<string, DataAssetAccessGroupConfig>;
};

export type DataProductsDataAsset = Resource<
  "GCP.Dataplex.DataProductsDataAsset",
  DataProductsDataAssetProps,
  {
    /** Full resource name. */
    name: string;
    /** Data asset id (last path segment). */
    dataAssetId: string;
    /** Parent Data Product resource name. */
    parent: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Bound cloud resource. */
    resource: string;
    /** Access-group configs. */
    accessGroupConfigs:
      | Record<string, DataAssetAccessGroupConfig | undefined>
      | undefined;
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
 * A Dataplex Data Asset packaged inside a Data Product.
 *
 * Parent, asset id, and `resource` are immutable. Labels and access-group
 * configs update in place.
 *
 * ### Creating a Data Asset
 * **Example:** Package a BigQuery table
 * ```typescript
 * const asset = yield* GCP.Dataplex.DataProductsDataAsset("Orders", {
 *   parent: product.name,
 *   resource:
 *     "//bigquery.googleapis.com/projects/my-project/datasets/sales/tables/orders",
 *   labels: { env: "test" },
 * });
 * ```
 *
 * @resource
 * @category Dataplex
 */
export const DataProductsDataAsset = Resource<DataProductsDataAsset>(
  "GCP.Dataplex.DataProductsDataAsset",
);

const resourceNameOf = (parent: string, dataAssetId: string) =>
  `${parent}/dataAssets/${dataAssetId}`;

const toAttrs = (
  asset: dataplex.GoogleCloudDataplexV1DataAsset,
  project: string,
) => {
  const name = asset.name ?? "";
  const parsed = parseName(name, "dataAssets");
  return {
    name,
    dataAssetId: parsed.id,
    parent: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    labels: userLabels(asset.labels),
    resource: asset.resource ?? "",
    accessGroupConfigs: asset.accessGroupConfigs,
    etag: asset.etag,
    uid: asset.uid,
    createTime: asset.createTime,
    updateTime: asset.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : retryQuota(
        dataplex.getProjectsLocationsDataProductsDataAssets({ name }),
      ).pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAtParent = (parent: string) =>
  collectPages(
    dataplex.listProjectsLocationsDataProductsDataAssets.pages({
      parent,
      pageSize: 1000,
    }),
    (page) => page.dataAssets,
  ).pipe(
    Effect.map((items) =>
      items.filter((item) => hasAlchemyLabelMap(item.labels)),
    ),
    Effect.catchTag("NotFound", () => Effect.succeed([])),
  );

export const DataProductsDataAssetProvider = () =>
  Provider.succeed(DataProductsDataAsset, {
    stables: [
      "name",
      "dataAssetId",
      "parent",
      "project",
      "location",
      "resource",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return replaceOnIdentity({
        previousId: olds?.dataAssetId ?? output?.dataAssetId,
        nextId: news.dataAssetId ?? olds?.dataAssetId ?? output?.dataAssetId,
        previousLocation: lastSegment(olds?.parent ?? output?.parent ?? ""),
        nextLocation: lastSegment(news.parent),
        previousParent: olds?.parent ?? output?.parent,
        nextParent: news.parent,
        extra:
          (olds?.resource ?? output?.resource) !== undefined &&
          news.resource !== (olds?.resource ?? output?.resource),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const dataAssetId = yield* toPhysicalId(
        id,
        olds?.dataAssetId,
        output?.dataAssetId,
        "dataasset",
      );
      const name =
        output?.name ??
        (olds?.parent ? resourceNameOf(olds.parent, dataAssetId) : "");
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
        const products = yield* listAlchemyDataProducts(
          env.project,
          env.region,
        );
        const pages = yield* Effect.forEach(
          products,
          (product) =>
            product.name
              ? listAtParent(product.name)
              : Effect.succeed([] as dataplex.GoogleCloudDataplexV1DataAsset[]),
          { concurrency: 4 },
        );
        return pages.flat().map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const dataAssetId = yield* toPhysicalId(
        id,
        news.dataAssetId,
        output?.dataAssetId,
        "dataasset",
      );
      const name = resourceNameOf(news.parent, dataAssetId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* retryQuota(
          dataplex.createProjectsLocationsDataProductsDataAssets({
            parent: news.parent,
            dataAssetId,
            body: {
              labels: desiredLabels,
              resource: news.resource,
              accessGroupConfigs: news.accessGroupConfigs,
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
      const configsChanged =
        fingerprint(current.accessGroupConfigs) !==
        fingerprint(news.accessGroupConfigs);

      if (labelsChanged || configsChanged) {
        const operation =
          yield* dataplex.patchProjectsLocationsDataProductsDataAssets({
            name: current.name ?? name,
            updateMask: [
              labelsChanged ? "labels" : undefined,
              configsChanged ? "accessGroupConfigs" : undefined,
            ]
              .filter((field): field is string => field !== undefined)
              .join(","),
            body: {
              name: current.name ?? name,
              etag: current.etag,
              labels: desiredLabels,
              accessGroupConfigs: news.accessGroupConfigs,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* dataplex
        // No etag: the recorded one goes stale as the server settles an
        // update ("Provided etag is out of date"), and delete is unconditional.
        .deleteProjectsLocationsDataProductsDataAssets({
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
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
