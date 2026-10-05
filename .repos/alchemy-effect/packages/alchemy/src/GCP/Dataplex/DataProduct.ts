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

export type DataProductAccessGroup =
  dataplex.GoogleCloudDataplexV1DataProductAccessGroup;

export type DataProductAccessApprovalConfig =
  dataplex.GoogleCloudDataplexV1DataProductAccessApprovalConfig;

export type DataProductProps = {
  /**
   * Data product id. If omitted, a unique name is generated. Must match
   * `^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$`. Immutable — changing it
   * replaces the product.
   */
  dataProductId?: string;
  /**
   * Region (`us-central1`, …). Immutable — changing it replaces the
   * product.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * User-friendly display name. Required.
   */
  displayName: string;
  /**
   * Description of the data product.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Emails of the data product owners. Required.
   */
  ownerEmails: string[];
  /**
   * Base64-encoded icon (max 3 MiB).
   */
  icon?: string;
  /**
   * Access groups keyed by group id.
   */
  accessGroups?: Record<string, DataProductAccessGroup>;
  /**
   * Access-approval configuration.
   */
  accessApprovalConfig?: DataProductAccessApprovalConfig;
};

export type DataProduct = Resource<
  "GCP.Dataplex.DataProduct",
  DataProductProps,
  {
    /** Full resource name. */
    name: string;
    /** Data product id (last path segment). */
    dataProductId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** Description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Owner emails. */
    ownerEmails: string[];
    /** Icon payload. */
    icon: string | undefined;
    /** Access groups. */
    accessGroups:
      | Record<string, DataProductAccessGroup | undefined>
      | undefined;
    /** Access-approval configuration. */
    accessApprovalConfig: DataProductAccessApprovalConfig | undefined;
    /** Number of attached data assets. */
    assetCount: number | undefined;
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
 * A Dataplex Data Product — a curated collection of data assets packaged
 * for a use case.
 *
 * Location and product id are immutable. Display name, description,
 * labels, owners, icon, access groups, and approval config update in
 * place.
 *
 * ### Creating a Data Product
 * **Example:** Product with an owner
 * ```typescript
 * const product = yield* GCP.Dataplex.DataProduct("Sales", {
 *   displayName: "Sales mart",
 *   ownerEmails: ["owner@example.com"],
 *   labels: { env: "test" },
 * });
 * ```
 *
 * @resource
 * @category Dataplex
 */
export const DataProduct = Resource<DataProduct>("GCP.Dataplex.DataProduct");

const resourceName = (
  project: string,
  location: string,
  dataProductId: string,
) => `projects/${project}/locations/${location}/dataProducts/${dataProductId}`;

const toAttrs = (
  product: dataplex.GoogleCloudDataplexV1DataProduct,
  project: string,
) => {
  const name = product.name ?? "";
  const parsed = parseName(name, "dataProducts");
  return {
    name,
    dataProductId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: product.displayName,
    description: product.description,
    labels: userLabels(product.labels),
    ownerEmails: [...(product.ownerEmails ?? [])],
    icon: product.icon,
    accessGroups: product.accessGroups,
    accessApprovalConfig: product.accessApprovalConfig,
    assetCount: product.assetCount,
    etag: product.etag,
    uid: product.uid,
    createTime: product.createTime,
    updateTime: product.updateTime,
  };
};

const getByName = (name: string) =>
  retryQuota(dataplex.getProjectsLocationsDataProducts({ name })).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const listProducts = (project: string, region: string) => {
  const collect = (parent: string) =>
    collectPages(
      dataplex.listProjectsLocationsDataProducts.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.dataProducts,
    ).pipe(
      Effect.map((items) =>
        items.filter((item) => hasAlchemyLabelMap(item.labels)),
      ),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );
  return listAtLocation(project, region, collect);
};

export const listAlchemyDataProducts = (project: string, region: string) =>
  listProducts(project, region);

export const DataProductProvider = () =>
  Provider.succeed(DataProduct, {
    stables: [
      "name",
      "dataProductId",
      "project",
      "location",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousId: olds?.dataProductId ?? output?.dataProductId,
        nextId:
          news.dataProductId ?? olds?.dataProductId ?? output?.dataProductId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const dataProductId = yield* toPhysicalId(
        id,
        olds?.dataProductId,
        output?.dataProductId,
        "dataproduct",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, dataProductId);
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
        const items = yield* listProducts(env.project, env.region);
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const dataProductId = yield* toPhysicalId(
        id,
        news.dataProductId,
        output?.dataProductId,
        "dataproduct",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, dataProductId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* retryQuota(
          dataplex.createProjectsLocationsDataProducts({
            parent: parentOf(env.project, location),
            dataProductId,
            body: {
              displayName: news.displayName,
              description: news.description,
              labels: desiredLabels,
              ownerEmails: news.ownerEmails,
              icon: news.icon,
              accessGroups: news.accessGroups,
              accessApprovalConfig: news.accessApprovalConfig,
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
        (current.displayName ?? "") !== news.displayName;
      const ownersChanged =
        fingerprint([...(current.ownerEmails ?? [])].sort()) !==
        fingerprint([...(news.ownerEmails ?? [])].sort());
      const iconChanged = (current.icon ?? "") !== (news.icon ?? "");
      const groupsChanged =
        fingerprint(current.accessGroups) !== fingerprint(news.accessGroups);
      const approvalChanged =
        fingerprint(current.accessApprovalConfig) !==
        fingerprint(news.accessApprovalConfig);

      if (
        labelsChanged ||
        descriptionChanged ||
        displayNameChanged ||
        ownersChanged ||
        iconChanged ||
        groupsChanged ||
        approvalChanged
      ) {
        const operation = yield* dataplex.patchProjectsLocationsDataProducts({
          name: current.name ?? name,
          updateMask: [
            labelsChanged ? "labels" : undefined,
            descriptionChanged ? "description" : undefined,
            displayNameChanged ? "displayName" : undefined,
            ownersChanged ? "ownerEmails" : undefined,
            iconChanged ? "icon" : undefined,
            groupsChanged ? "accessGroups" : undefined,
            approvalChanged ? "accessApprovalConfig" : undefined,
          ]
            .filter((field): field is string => field !== undefined)
            .join(","),
          body: {
            name: current.name ?? name,
            etag: current.etag,
            displayName: news.displayName,
            description: news.description,
            labels: desiredLabels,
            ownerEmails: news.ownerEmails,
            icon: news.icon,
            accessGroups: news.accessGroups,
            accessApprovalConfig: news.accessApprovalConfig,
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
        .deleteProjectsLocationsDataProducts({
          name: output.name,
          etag: output.etag,
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
