import * as analyticshub from "@distilled.cloud/gcp/analyticshub_v1";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  AnalyticshubNotResolved,
  displayNameOf,
  encodeDescription,
  expandParent,
  deleteRetry,
  hasOwnershipMarker,
  listChildResources,
  listExchangesInProject,
  listListings,
  namedOf,
  normalizeLocation,
  ownedById,
  ownershipLabels,
  parseDescription,
  parseResourceName,
  replaceOnIdentity,
  retryTransient,
  sameBool,
  sameJson,
  sameText,
  toPhysicalId,
  updateMaskOf,
} from "./internal.ts";

export type ListingDataProvider = analyticshub.DataProvider;
export type ListingPublisher = analyticshub.Publisher;
export type ListingRestrictedExportConfig = analyticshub.RestrictedExportConfig;
export type ListingStoredProcedureConfig = analyticshub.StoredProcedureConfig;
export type ListingBigQueryDatasetSource = analyticshub.BigQueryDatasetSource;
export type ListingPubSubTopicSource = analyticshub.PubSubTopicSource;
export type ListingDiscoveryType =
  | analyticshub.ListingDiscoveryTypeEnum
  | (string & {});
export type ListingCategory =
  | analyticshub.ListingCategoriesItemEnum
  | (string & {});

export type DataExchangesListingProps = {
  /**
   * Parent data exchange. Full name
   * `projects/{project}/locations/{location}/dataExchanges/{dataExchange}`
   * or the exchange id (combined with `location`). Immutable — changing
   * it replaces the listing.
   */
  dataExchange: string;
  /**
   * Listing id (the `{listing}` segment of
   * `.../dataExchanges/{dataExchange}/listings/{listing}`). If omitted, a
   * unique id is generated. Letters, numbers, and underscores; max 100
   * bytes. Immutable — changing it replaces the listing.
   */
  listingId?: string;
  /**
   * Location used when `dataExchange` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Human-readable display name. Max 63 bytes. Defaults to the listing
   * id.
   */
  displayName?: string;
  /**
   * Short description (max 2000 bytes). Listings have no labels field,
   * so Alchemy ownership is stored in a `[alchemy …]` prefix and
   * stripped from attributes.
   */
  description?: string;
  /**
   * Documentation describing the listing.
   */
  documentation?: string;
  /**
   * Email or URL of the primary point of contact. Max 1000 bytes.
   */
  primaryContact?: string;
  /**
   * Email or URL subscribers can use to request access. Max 1000 bytes.
   */
  requestAccess?: string;
  /**
   * Base64-encoded icon. Max 3.0 MiB encoded.
   */
  icon?: string;
  /**
   * Shared BigQuery dataset. Provide `dataset` as
   * `projects/{project}/datasets/{dataset}` or a dataset id. The dataset
   * location must match the exchange. Immutable — changing the dataset
   * replaces the listing.
   */
  bigqueryDataset?: ListingBigQueryDatasetSource;
  /**
   * Shared Pub/Sub topic. Provide `topic` as
   * `projects/{project}/topics/{topic}`. Immutable — changing the topic
   * replaces the listing.
   */
  pubsubTopic?: ListingPubSubTopicSource;
  /**
   * Details of the data provider who owns the source data.
   */
  dataProvider?: ListingDataProvider;
  /**
   * Details of the publisher who owns the listing.
   */
  publisher?: ListingPublisher;
  /**
   * Categories (up to five).
   */
  categories?: ListingCategory[];
  /**
   * Discovery visibility (`DISCOVERY_TYPE_PRIVATE`,
   * `DISCOVERY_TYPE_PUBLIC`).
   */
  discoveryType?: ListingDiscoveryType;
  /**
   * Restricted export configuration propagated to linked datasets.
   */
  restrictedExportConfig?: ListingRestrictedExportConfig;
  /**
   * Stored-procedure sharing configuration for linked datasets.
   */
  storedProcedureConfig?: ListingStoredProcedureConfig;
  /**
   * When true, query jobs against linked datasets record the subscriber
   * email in the logs.
   * @default false
   */
  logLinkedDatasetQueryUserEmail?: boolean;
  /**
   * When true, the listing exposes metadata only and cannot be
   * subscribed to. Immutable on some exchanges.
   * @default false
   */
  allowOnlyMetadataSharing?: boolean;
  /**
   * When true, deleting a commercial listing is allowed. Commercial
   * listings refuse delete unless this is set.
   * @default false
   */
  deleteCommercial?: boolean;
};

export type DataExchangesListing = Resource<
  "GCP.AnalyticsHub.DataExchangesListing",
  DataExchangesListingProps,
  {
    /** Full resource name. */
    name: string;
    /** Listing id (last path segment). */
    listingId: string;
    /** Parent data exchange resource name. */
    dataExchange: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** User description (Alchemy ownership marker stripped). */
    description: string | undefined;
    /** Documentation. */
    documentation: string | undefined;
    /** Primary contact. */
    primaryContact: string | undefined;
    /** Request-access URL or email. */
    requestAccess: string | undefined;
    /** Base64-encoded icon. */
    icon: string | undefined;
    /** Shared BigQuery dataset source. */
    bigqueryDataset: ListingBigQueryDatasetSource | undefined;
    /** Shared Pub/Sub topic source. */
    pubsubTopic: ListingPubSubTopicSource | undefined;
    /** Data provider. */
    dataProvider: ListingDataProvider | undefined;
    /** Publisher. */
    publisher: ListingPublisher | undefined;
    /** Categories. */
    categories: ListingCategory[] | undefined;
    /** Discovery type. */
    discoveryType: string | undefined;
    /** Restricted export configuration. */
    restrictedExportConfig: ListingRestrictedExportConfig | undefined;
    /** Stored-procedure configuration. */
    storedProcedureConfig: ListingStoredProcedureConfig | undefined;
    /** Whether linked-dataset query emails are logged. */
    logLinkedDatasetQueryUserEmail: boolean;
    /** Whether the listing is metadata-only. */
    allowOnlyMetadataSharing: boolean;
    /** Shared asset type (`BIGQUERY_DATASET`, `PUBSUB_TOPIC`). */
    resourceType: string | undefined;
    /** Listing lifecycle state. */
    state: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Analytics Hub listing published into a data exchange. Subscribers
 * get a linked BigQuery dataset or a Pub/Sub subscription pointing at
 * the shared source.
 *
 * Parent exchange, location, listing id, and the source dataset/topic
 * are immutable. Display name, description, documentation, contacts,
 * categories, and export settings update in place.
 *
 * Listings have no labels. Alchemy stamps ownership into the
 * description so `list` / `pnpm nuke:gcp` can find them.
 *
 * ### Creating a Listing
 * **Example:** Share a BigQuery dataset
 * ```typescript
 * const dataset = yield* GCP.BigQuery.Dataset("Source", {
 *   location: "us-central1",
 *   forceDestroy: true,
 * });
 * const exchange = yield* GCP.AnalyticsHub.DataExchange("Marketplace", {
 *   displayName: "Marketplace",
 * });
 * const listing = yield* GCP.AnalyticsHub.DataExchangesListing("Orders", {
 *   dataExchange: exchange.name,
 *   displayName: "Orders",
 *   bigqueryDataset: { dataset: dataset.name },
 * });
 * ```
 *
 * **Example:** Share a Pub/Sub topic
 * ```typescript
 * const listing = yield* GCP.AnalyticsHub.DataExchangesListing("Events", {
 *   dataExchange: exchange.name,
 *   displayName: "Events",
 *   pubsubTopic: { topic: topic.name },
 * });
 * ```
 *
 * @resource
 * @category AnalyticsHub
 */
export const DataExchangesListing = Resource<DataExchangesListing>(
  "GCP.AnalyticsHub.DataExchangesListing",
);

const parentExchange = (
  dataExchange: string,
  project: string,
  location: string,
) => expandParent(dataExchange, project, location, "dataExchanges");

const resourceName = (dataExchange: string, listingId: string) =>
  `${dataExchange}/listings/${listingId}`;

const datasetName = (value: string | undefined, project: string) => {
  if (value === undefined || value.length === 0) return undefined;
  if (value.includes("/")) return value.replace(/\/+$/, "");
  return `projects/${project}/datasets/${value}`;
};

const topicName = (value: string | undefined, project: string) => {
  if (value === undefined || value.length === 0) return undefined;
  if (value.includes("/")) return value.replace(/\/+$/, "");
  return `projects/${project}/topics/${value}`;
};

const desiredBigQuery = (
  source: ListingBigQueryDatasetSource | undefined,
  project: string,
): ListingBigQueryDatasetSource | undefined => {
  if (source === undefined) return undefined;
  return {
    ...source,
    dataset: datasetName(source.dataset, project),
  };
};

const desiredPubSub = (
  source: ListingPubSubTopicSource | undefined,
  project: string,
): ListingPubSubTopicSource | undefined => {
  if (source === undefined) return undefined;
  return {
    ...source,
    topic: topicName(source.topic, project),
  };
};

const sourceIdentity = (
  bigqueryDataset: ListingBigQueryDatasetSource | undefined,
  pubsubTopic: ListingPubSubTopicSource | undefined,
) => `${bigqueryDataset?.dataset ?? ""}|${pubsubTopic?.topic ?? ""}`;

const toAttrs = (listing: analyticshub.Listing, project: string) => {
  const name = listing.name ?? "";
  const parsed = parseResourceName(name, "listings");
  const { description } = parseDescription(listing.description);
  return {
    name,
    listingId: parsed.id,
    dataExchange: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    displayName: listing.displayName,
    description,
    documentation: listing.documentation,
    primaryContact: listing.primaryContact,
    requestAccess: listing.requestAccess,
    icon: listing.icon,
    bigqueryDataset: listing.bigqueryDataset,
    pubsubTopic: listing.pubsubTopic,
    dataProvider: listing.dataProvider,
    publisher: listing.publisher,
    categories: listing.categories,
    discoveryType: listing.discoveryType,
    restrictedExportConfig: listing.restrictedExportConfig,
    storedProcedureConfig: listing.storedProcedureConfig,
    logLinkedDatasetQueryUserEmail:
      listing.logLinkedDatasetQueryUserEmail === true,
    allowOnlyMetadataSharing: listing.allowOnlyMetadataSharing === true,
    resourceType: listing.resourceType,
    state: listing.state,
  };
};

const getByName = (name: string) =>
  Effect.gen(function* () {
    if (name.length === 0) return undefined;
    const parsed = parseResourceName(name, "listings");
    const items = yield* listListings(parsed.parent);
    return items.find((item) => (item.name ?? "") === name);
  });

export const DataExchangesListingProvider = () =>
  Provider.succeed(DataExchangesListing, {
    nuke: {
      dependsOn: ["GCP.AnalyticsHub.DataExchange", "GCP.BigQuery.Dataset"],
    },
    stables: ["name", "listingId", "dataExchange", "project", "location"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      const nextSource = sourceIdentity(
        desiredBigQuery(news.bigqueryDataset, env.project),
        desiredPubSub(news.pubsubTopic, env.project),
      );
      const previousSource = sourceIdentity(
        olds?.bigqueryDataset ?? output?.bigqueryDataset,
        olds?.pubsubTopic ?? output?.pubsubTopic,
      );
      return replaceOnIdentity({
        previousId: olds?.listingId ?? output?.listingId,
        nextId: news.listingId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: location,
        previousParent: olds?.dataExchange ?? output?.dataExchange,
        nextParent: parentExchange(news.dataExchange, env.project, location),
        extra:
          previousSource.length > 1 &&
          nextSource.length > 1 &&
          previousSource !== nextSource,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const listingId = yield* toPhysicalId(
        id,
        olds?.listingId,
        output?.listingId,
      );
      const dataExchange =
        olds?.dataExchange !== undefined
          ? parentExchange(olds.dataExchange, env.project, location)
          : (output?.dataExchange ?? "");
      const name =
        output?.name ??
        (dataExchange ? resourceName(dataExchange, listingId) : "");
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedById(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const exchanges = yield* listExchangesInProject(
          env.project,
          env.region,
        );
        const listings = yield* listChildResources(
          namedOf(exchanges),
          listListings,
        );
        return listings
          .filter((item) => hasOwnershipMarker(item.description))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const dataExchange = parentExchange(
        news.dataExchange,
        env.project,
        location,
      );
      const listingId = yield* toPhysicalId(
        id,
        news.listingId,
        output?.listingId,
      );
      const name = output?.name ?? resourceName(dataExchange, listingId);
      const ownership = yield* ownershipLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);
      const displayName = displayNameOf(news.displayName, listingId);
      const bigqueryDataset = desiredBigQuery(
        news.bigqueryDataset,
        env.project,
      );
      const pubsubTopic = desiredPubSub(news.pubsubTopic, env.project);
      const body: analyticshub.Listing = {
        displayName,
        description: desiredDescription,
      };
      if (news.documentation !== undefined) {
        body.documentation = news.documentation;
      }
      if (news.primaryContact !== undefined) {
        body.primaryContact = news.primaryContact;
      }
      if (news.requestAccess !== undefined) {
        body.requestAccess = news.requestAccess;
      }
      if (news.icon !== undefined) {
        body.icon = news.icon;
      }
      if (bigqueryDataset !== undefined) {
        body.bigqueryDataset = bigqueryDataset;
      }
      if (pubsubTopic !== undefined) {
        body.pubsubTopic = pubsubTopic;
      }
      if (news.dataProvider !== undefined) {
        body.dataProvider = news.dataProvider;
      }
      if (news.publisher !== undefined) {
        body.publisher = news.publisher;
      }
      if (news.categories !== undefined) {
        body.categories = news.categories;
      }
      if (news.discoveryType !== undefined) {
        body.discoveryType = news.discoveryType;
      }
      if (news.restrictedExportConfig !== undefined) {
        body.restrictedExportConfig = news.restrictedExportConfig;
      }
      if (news.storedProcedureConfig !== undefined) {
        body.storedProcedureConfig = news.storedProcedureConfig;
      }
      if (news.logLinkedDatasetQueryUserEmail === true) {
        body.logLinkedDatasetQueryUserEmail = true;
      }
      if (news.allowOnlyMetadataSharing === true) {
        body.allowOnlyMetadataSharing = true;
      }

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* retryTransient(
          analyticshub.createProjectsLocationsDataExchangesListings({
            parent: dataExchange,
            listingId,
            body,
          }),
        ).pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AnalyticshubNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const displayChanged = !sameText(current.displayName, displayName);
      const descriptionChanged = !sameText(
        current.description,
        desiredDescription,
      );
      const documentationChanged = !sameText(
        current.documentation,
        news.documentation,
      );
      const contactChanged = !sameText(
        current.primaryContact,
        news.primaryContact,
      );
      const requestChanged = !sameText(
        current.requestAccess,
        news.requestAccess,
      );
      const iconChanged = !sameText(current.icon, news.icon);
      const dataProviderChanged =
        news.dataProvider !== undefined &&
        !sameJson(current.dataProvider, news.dataProvider);
      const publisherChanged =
        news.publisher !== undefined &&
        !sameJson(current.publisher, news.publisher);
      const categoriesChanged =
        news.categories !== undefined &&
        !sameJson(current.categories, news.categories);
      const discoveryChanged =
        news.discoveryType !== undefined &&
        !sameText(current.discoveryType, news.discoveryType);
      const restrictedChanged =
        news.restrictedExportConfig !== undefined &&
        !sameJson(
          {
            enabled: current.restrictedExportConfig?.enabled,
            restrictQueryResult:
              current.restrictedExportConfig?.restrictQueryResult,
          },
          {
            enabled: news.restrictedExportConfig.enabled,
            restrictQueryResult:
              news.restrictedExportConfig.restrictQueryResult,
          },
        );
      const storedChanged =
        news.storedProcedureConfig !== undefined &&
        !sameBool(
          current.storedProcedureConfig?.enabled,
          news.storedProcedureConfig.enabled,
        );
      const emailChanged =
        news.logLinkedDatasetQueryUserEmail !== undefined &&
        !sameBool(
          current.logLinkedDatasetQueryUserEmail,
          news.logLinkedDatasetQueryUserEmail,
        );
      const metadataChanged =
        news.allowOnlyMetadataSharing !== undefined &&
        !sameBool(
          current.allowOnlyMetadataSharing,
          news.allowOnlyMetadataSharing,
        );
      const selectedChanged =
        bigqueryDataset?.selectedResources !== undefined &&
        !sameJson(
          current.bigqueryDataset?.selectedResources,
          bigqueryDataset.selectedResources,
        );
      const replicaChanged =
        bigqueryDataset?.replicaLocations !== undefined &&
        !sameJson(
          current.bigqueryDataset?.replicaLocations,
          bigqueryDataset.replicaLocations,
        );
      const restrictedPolicyChanged =
        bigqueryDataset?.restrictedExportPolicy !== undefined &&
        !sameJson(
          current.bigqueryDataset?.restrictedExportPolicy,
          bigqueryDataset.restrictedExportPolicy,
        );
      const affinityChanged =
        pubsubTopic?.dataAffinityRegions !== undefined &&
        !sameJson(
          current.pubsubTopic?.dataAffinityRegions,
          pubsubTopic.dataAffinityRegions,
        );

      if (
        displayChanged ||
        descriptionChanged ||
        documentationChanged ||
        contactChanged ||
        requestChanged ||
        iconChanged ||
        dataProviderChanged ||
        publisherChanged ||
        categoriesChanged ||
        discoveryChanged ||
        restrictedChanged ||
        storedChanged ||
        emailChanged ||
        metadataChanged ||
        selectedChanged ||
        replicaChanged ||
        restrictedPolicyChanged ||
        affinityChanged
      ) {
        current = yield* retryTransient(
          analyticshub.patchProjectsLocationsDataExchangesListings({
            name: currentName,
            updateMask: updateMaskOf(
              displayChanged ? "displayName" : undefined,
              descriptionChanged ? "description" : undefined,
              documentationChanged ? "documentation" : undefined,
              contactChanged ? "primaryContact" : undefined,
              requestChanged ? "requestAccess" : undefined,
              iconChanged ? "icon" : undefined,
              dataProviderChanged ? "dataProvider" : undefined,
              publisherChanged ? "publisher" : undefined,
              categoriesChanged ? "categories" : undefined,
              discoveryChanged ? "discoveryType" : undefined,
              restrictedChanged ? "restrictedExportConfig" : undefined,
              storedChanged ? "storedProcedureConfig" : undefined,
              emailChanged ? "logLinkedDatasetQueryUserEmail" : undefined,
              metadataChanged ? "allowOnlyMetadataSharing" : undefined,
              selectedChanged ? "bigqueryDataset.selectedResources" : undefined,
              replicaChanged ? "bigqueryDataset.replicaLocations" : undefined,
              restrictedPolicyChanged
                ? "bigqueryDataset.restrictedExportPolicy"
                : undefined,
              affinityChanged ? "pubsubTopic.dataAffinityRegions" : undefined,
            ),
            body: { name: currentName, ...body },
          }),
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* deleteRetry(
        analyticshub.deleteProjectsLocationsDataExchangesListings({
          name: output.name,
          deleteCommercial: true,
        }),
      );
    }),
  });
