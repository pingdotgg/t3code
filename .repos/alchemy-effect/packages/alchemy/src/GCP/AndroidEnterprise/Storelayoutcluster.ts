import * as androidenterprise from "@distilled.cloud/gcp/androidenterprise_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  findOwnedCluster,
  getCluster,
  hasOwnershipMarker,
  jsonEqual,
  listOwnedClusters,
  ownedByAlchemy,
  ownershipTextFromNames,
  publicNames,
  sameStringList,
  sameText,
  defaultNames,
  toDisplayName,
} from "./internal.ts";

export type StorelayoutclusterProps = {
  /**
   * Play EMM enterprise id. Immutable — changing it replaces the cluster.
   */
  enterpriseId: string;
  /**
   * Parent store page id. Immutable — changing it replaces the cluster.
   */
  pageId: string;
  /**
   * Server-assigned cluster id. Immutable — changing it replaces the
   * cluster.
   */
  clusterId?: string;
  /**
   * Localized cluster names, shown to device users as given.
   */
  name?: androidenterprise.LocalizedText[];
  /**
   * Product ids displayed in the cluster, in order. Duplicates are not
   * allowed.
   */
  productId?: string[];
  /**
   * US-ASCII ordering key among elements on the parent page. Max 256
   * characters.
   */
  orderInPage?: string;
};

export type Storelayoutcluster = Resource<
  "GCP.AndroidEnterprise.Storelayoutcluster",
  StorelayoutclusterProps,
  {
    /** Server-assigned cluster id. */
    clusterId: string;
    /** Parent store page id. */
    pageId: string;
    /** Play EMM enterprise id. */
    enterpriseId: string;
    /** Project id used when the cluster was reconciled. */
    project: string;
    /** Localized names with the Alchemy ownership prefix stripped. */
    name: androidenterprise.LocalizedText[] | undefined;
    /** Product ids in display order. */
    productId: string[] | undefined;
    /** Ordering key on the parent page. */
    orderInPage: string | undefined;
  },
  never,
  Providers
>;

/**
 * A managed Google Play store cluster (`storelayoutclusters`).
 *
 * Store clusters have no labels field and their names are shown to device
 * users, so Alchemy tracks a cluster by its recorded id only (`list` finds
 * clusters from older releases that carried a name marker). `enterpriseId`, `pageId`,
 * and `clusterId` are identity — changing any replaces the cluster.
 * Names, products, and order update in place.
 *
 * ### Creating a Store Cluster
 * **Example:** Generated name
 * ```typescript
 * const cluster = yield* GCP.AndroidEnterprise.Storelayoutcluster("Apps", {
 *   enterpriseId: page.enterpriseId,
 *   pageId: page.pageId,
 * });
 * ```
 *
 * **Example:** Explicit name and products
 * ```typescript
 * const cluster = yield* GCP.AndroidEnterprise.Storelayoutcluster("Apps", {
 *   enterpriseId: page.enterpriseId,
 *   pageId: page.pageId,
 *   name: [{ locale: "en-US", text: "Work apps" }],
 *   productId: ["app:com.google.android.gm"],
 * });
 * ```
 *
 * ### Updating a Store Cluster
 * Re-declare the same logical id with changed props; the engine keeps the
 * physical resource and updates it in place.
 *
 * **Example:** Rename
 * ```typescript
 * const cluster = yield* GCP.AndroidEnterprise.Storelayoutcluster("Apps", {
 *   enterpriseId: page.enterpriseId,
 *   pageId: page.pageId,
 *   name: [{ locale: "en-US", text: "Featured apps" }],
 * });
 * ```
 *
 * @resource
 * @category AndroidEnterprise
 */
export const Storelayoutcluster = Resource<Storelayoutcluster>(
  "GCP.AndroidEnterprise.Storelayoutcluster",
);

export class StorelayoutclusterNotResolved extends Data.TaggedError(
  "GCP.AndroidEnterprise.StorelayoutclusterNotResolved",
)<{
  enterpriseId: string;
  pageId: string;
  clusterId: string;
}> {}

const toAttrs = (
  cluster: androidenterprise.StoreCluster,
  enterpriseId: string,
  pageId: string,
  project: string,
) => ({
  clusterId: cluster.id ?? "",
  pageId,
  enterpriseId,
  project,
  name: publicNames(cluster.name),
  productId: cluster.productId,
  orderInPage: cluster.orderInPage,
});

const desiredBody = (input: {
  clusterId?: string;
  name: androidenterprise.LocalizedText[];
  news: StorelayoutclusterProps;
  current?: androidenterprise.StoreCluster;
}): androidenterprise.StoreCluster => ({
  id: input.clusterId,
  name: input.name,
  productId: input.news.productId ?? input.current?.productId,
  orderInPage: input.news.orderInPage ?? input.current?.orderInPage,
});

const needsSync = (
  current: androidenterprise.StoreCluster,
  desired: androidenterprise.StoreCluster,
) =>
  !jsonEqual(current.name, desired.name) ||
  (desired.productId !== undefined &&
    !sameStringList(current.productId, desired.productId)) ||
  (desired.orderInPage !== undefined &&
    !sameText(current.orderInPage, desired.orderInPage));

export const StorelayoutclusterProvider = () =>
  Provider.succeed(Storelayoutcluster, {
    stables: ["clusterId", "pageId", "enterpriseId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousEnterprise = olds?.enterpriseId ?? output?.enterpriseId;
      if (
        previousEnterprise !== undefined &&
        news.enterpriseId !== previousEnterprise
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousPage = olds?.pageId ?? output?.pageId;
      if (previousPage !== undefined && news.pageId !== previousPage) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.clusterId ?? output?.clusterId;
      if (
        previousId !== undefined &&
        news.clusterId !== undefined &&
        news.clusterId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const enterpriseId = olds?.enterpriseId ?? output?.enterpriseId ?? "";
      const pageId = olds?.pageId ?? output?.pageId ?? "";
      const clusterId = olds?.clusterId ?? output?.clusterId ?? "";
      let existing = yield* getCluster(enterpriseId, pageId, clusterId);
      let observedPageId = pageId;
      if (existing === undefined && enterpriseId.length > 0) {
        const found = yield* findOwnedCluster(
          id,
          enterpriseId,
          pageId || undefined,
        );
        existing = found?.cluster;
        observedPageId = found?.pageId ?? pageId;
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(
        existing,
        enterpriseId,
        observedPageId,
        env.project,
      );
      // Only a recorded id (or a legacy ownership marker) proves ownership;
      // names and titles are user-visible and carry no marker.
      return output !== undefined ||
        (yield* ownedByAlchemy(id, ownershipTextFromNames(existing.name)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const clusters = yield* listOwnedClusters();
        return clusters
          .filter(({ cluster }) =>
            hasOwnershipMarker(ownershipTextFromNames(cluster.name)),
          )
          .map(({ cluster, enterpriseId, pageId }) =>
            toAttrs(cluster, enterpriseId, pageId, env.project),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const enterpriseId = news.enterpriseId;
      const pageId = news.pageId;
      const displayName = yield* toDisplayName(
        id,
        news.name?.[0]?.text,
        output?.name?.[0]?.text,
      );
      const name = defaultNames(news.name, displayName);

      let current = yield* getCluster(
        enterpriseId,
        pageId,
        news.clusterId ?? output?.clusterId ?? "",
      );
      if (current === undefined) {
        const found = yield* findOwnedCluster(id, enterpriseId, pageId);
        current = found?.cluster;
      }

      if (current === undefined) {
        const created = yield* androidenterprise
          .insertStorelayoutclusters({
            enterpriseId,
            pageId,
            body: desiredBody({ name, news }),
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findOwnedCluster(id, enterpriseId, pageId).pipe(
                Effect.map((found) => found?.cluster),
              ),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new StorelayoutclusterNotResolved({
          enterpriseId,
          pageId,
          clusterId: news.clusterId ?? output?.clusterId ?? displayName,
        });
      }

      const clusterId = current.id ?? news.clusterId ?? output?.clusterId ?? "";
      const desired = desiredBody({
        clusterId,
        name,
        news,
        current,
      });
      if (needsSync(current, desired)) {
        current = yield* androidenterprise.updateStorelayoutclusters({
          enterpriseId,
          pageId,
          clusterId,
          body: desired,
        });
      }

      return toAttrs(current, enterpriseId, pageId, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.enterpriseId || !output.pageId || !output.clusterId) return;
      yield* androidenterprise
        .deleteStorelayoutclusters({
          enterpriseId: output.enterpriseId,
          pageId: output.pageId,
          clusterId: output.clusterId,
        })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.catchTag("BadRequest", () => Effect.void),
          Effect.catchTag("Conflict", () => Effect.void),
        );
    }),
  });
