import * as analyticshub from "@distilled.cloud/gcp/analyticshub_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  AnalyticshubNotResolved,
  deleteRetry,
  displayNameOf,
  encodeDescription,
  hasOwnershipMarker,
  listExchangesInProject,
  listListings,
  listQueryTemplates,
  locationParent,
  missingGet,
  normalizeLocation,
  ownedById,
  parseDescription,
  parseResourceName,
  replaceOnIdentity,
  retryTransient,
  sameBool,
  sameText,
  sharingKind,
  toPhysicalId,
  updateMaskOf,
  ownershipLabels,
} from "./internal.ts";

export type SharingEnvironmentConfig = analyticshub.SharingEnvironmentConfig;
export type DataExchangeDiscoveryType =
  | analyticshub.DataExchangeDiscoveryTypeEnum
  | (string & {});

export type DataExchangeProps = {
  /**
   * Data exchange id (the `{dataExchange}` segment of
   * `projects/{project}/locations/{location}/dataExchanges/{dataExchange}`).
   * If omitted, a unique id is generated. Must contain only letters,
   * numbers, and underscores; max 100 bytes. Immutable — changing it
   * replaces the exchange.
   */
  dataExchangeId?: string;
  /**
   * BigQuery location (`us-central1`, `US`, `EU`, …). Immutable —
   * changing it replaces the exchange.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Human-readable display name. Letters, numbers, underscores, dashes,
   * spaces, and ampersands. Max 63 bytes. Defaults to the exchange id.
   */
  displayName?: string;
  /**
   * Human-readable description (max 2000 bytes). Analytics Hub data
   * exchanges have no labels field, so Alchemy ownership is stored in a
   * `[alchemy …]` prefix and stripped from attributes.
   */
  description?: string;
  /**
   * Documentation describing the data exchange.
   */
  documentation?: string;
  /**
   * Email or URL of the primary point of contact. Max 1000 bytes.
   */
  primaryContact?: string;
  /**
   * Base64-encoded icon. Max 3.0 MiB encoded.
   */
  icon?: string;
  /**
   * When true, query jobs against linked datasets record the subscriber
   * email in the logs.
   * @default false
   */
  logLinkedDatasetQueryUserEmail?: boolean;
  /**
   * Discovery visibility for listings under this exchange
   * (`DISCOVERY_TYPE_PRIVATE`, `DISCOVERY_TYPE_PUBLIC`). Updating this
   * also overwrites `discoveryType` on every listing in the exchange.
   */
  discoveryType?: DataExchangeDiscoveryType;
  /**
   * Sharing environment. Set `dcrExchangeConfig` for a data clean room,
   * or `defaultExchangeConfig` for a standard exchange. Switching kinds
   * replaces the exchange.
   */
  sharingEnvironmentConfig?: SharingEnvironmentConfig;
};

export type DataExchange = Resource<
  "GCP.AnalyticsHub.DataExchange",
  DataExchangeProps,
  {
    /** Full resource name. */
    name: string;
    /** Data exchange id (last path segment). */
    dataExchangeId: string;
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
    /** Base64-encoded icon. */
    icon: string | undefined;
    /** Whether linked-dataset query emails are logged. */
    logLinkedDatasetQueryUserEmail: boolean;
    /** Discovery type. */
    discoveryType: string | undefined;
    /** Sharing environment. */
    sharingEnvironmentConfig: SharingEnvironmentConfig | undefined;
    /** Number of listings in the exchange. */
    listingCount: number | undefined;
  },
  never,
  Providers
>;

/**
 * A BigQuery Analytics Hub data exchange — a container for listings
 * that share datasets or Pub/Sub topics with subscribers.
 *
 * Location and id are immutable. Display name, description,
 * documentation, contact, discovery type, and email logging update in
 * place. Switching between a default exchange and a data clean room
 * replaces the exchange.
 *
 * Data exchanges have no labels. Alchemy stamps
 * `alchemy-stack` / `alchemy-stage` / `alchemy-id` into the description
 * so `list` and `pnpm nuke:gcp` can identify owned exchanges.
 *
 * ### Creating a Data Exchange
 * **Example:** Generated id
 * ```typescript
 * const exchange = yield* GCP.AnalyticsHub.DataExchange("Marketplace", {
 *   displayName: "Marketplace",
 *   description: "shared datasets",
 * });
 * ```
 *
 * **Example:** Named exchange with a contact
 * ```typescript
 * const exchange = yield* GCP.AnalyticsHub.DataExchange("Marketplace", {
 *   dataExchangeId: "marketplace",
 *   location: "us-central1",
 *   displayName: "Marketplace",
 *   primaryContact: "data@example.com",
 * });
 * ```
 *
 * ### Data Clean Rooms
 * **Example:** Create a data clean room exchange
 * ```typescript
 * const dcr = yield* GCP.AnalyticsHub.DataExchange("CleanRoom", {
 *   displayName: "Clean Room",
 *   sharingEnvironmentConfig: { dcrExchangeConfig: {} },
 * });
 * ```
 *
 * @resource
 * @category AnalyticsHub
 */
export const DataExchange = Resource<DataExchange>(
  "GCP.AnalyticsHub.DataExchange",
);

const resourceName = (
  project: string,
  location: string,
  dataExchangeId: string,
) => `${locationParent(project, location)}/dataExchanges/${dataExchangeId}`;

const toAttrs = (exchange: analyticshub.DataExchange, project: string) => {
  const name = exchange.name ?? "";
  const parsed = parseResourceName(name, "dataExchanges");
  const { description } = parseDescription(exchange.description);
  return {
    name,
    dataExchangeId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: exchange.displayName,
    description,
    documentation: exchange.documentation,
    primaryContact: exchange.primaryContact,
    icon: exchange.icon,
    logLinkedDatasetQueryUserEmail:
      exchange.logLinkedDatasetQueryUserEmail === true,
    discoveryType: exchange.discoveryType,
    sharingEnvironmentConfig: exchange.sharingEnvironmentConfig,
    listingCount: exchange.listingCount,
  };
};

const getByName = missingGet;

export const DataExchangeProvider = () =>
  Provider.succeed(DataExchange, {
    nuke: {
      dependsOn: ["GCP.BigQuery.Dataset"],
    },
    stables: ["name", "dataExchangeId", "project", "location"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousKind = sharingKind(
        olds?.sharingEnvironmentConfig ?? output?.sharingEnvironmentConfig,
      );
      const nextKind =
        news.sharingEnvironmentConfig !== undefined
          ? sharingKind(news.sharingEnvironmentConfig)
          : previousKind;
      return replaceOnIdentity({
        previousId: olds?.dataExchangeId ?? output?.dataExchangeId,
        nextId: news.dataExchangeId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra:
          news.sharingEnvironmentConfig !== undefined &&
          nextKind !== previousKind,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const dataExchangeId = yield* toPhysicalId(
        id,
        olds?.dataExchangeId,
        output?.dataExchangeId,
      );
      const name =
        output?.name ?? resourceName(env.project, location, dataExchangeId);
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
        const items = yield* listExchangesInProject(env.project, env.region);
        return items
          .filter((item) => hasOwnershipMarker(item.description))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const parent = locationParent(env.project, location);
      const dataExchangeId = yield* toPhysicalId(
        id,
        news.dataExchangeId,
        output?.dataExchangeId,
      );
      const name =
        output?.name ?? resourceName(env.project, location, dataExchangeId);
      const ownership = yield* ownershipLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);
      const displayName = displayNameOf(news.displayName, dataExchangeId);
      const body: analyticshub.DataExchange = {
        displayName,
        description: desiredDescription,
        documentation: news.documentation,
        primaryContact: news.primaryContact,
        icon: news.icon,
        logLinkedDatasetQueryUserEmail:
          news.logLinkedDatasetQueryUserEmail === true ? true : undefined,
        discoveryType: news.discoveryType,
        sharingEnvironmentConfig: news.sharingEnvironmentConfig,
      };

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* retryTransient(
          analyticshub.createProjectsLocationsDataExchanges({
            parent,
            dataExchangeId,
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
      const iconChanged = !sameText(current.icon, news.icon);
      const emailChanged =
        news.logLinkedDatasetQueryUserEmail !== undefined &&
        !sameBool(
          current.logLinkedDatasetQueryUserEmail,
          news.logLinkedDatasetQueryUserEmail,
        );
      const discoveryChanged =
        news.discoveryType !== undefined &&
        !sameText(current.discoveryType, news.discoveryType);
      const sharingChanged =
        news.sharingEnvironmentConfig !== undefined &&
        sharingKind(current.sharingEnvironmentConfig) !==
          sharingKind(news.sharingEnvironmentConfig);

      if (
        displayChanged ||
        descriptionChanged ||
        documentationChanged ||
        contactChanged ||
        iconChanged ||
        emailChanged ||
        discoveryChanged ||
        sharingChanged
      ) {
        current = yield* retryTransient(
          analyticshub.patchProjectsLocationsDataExchanges({
            name: currentName,
            updateMask: updateMaskOf(
              displayChanged ? "displayName" : undefined,
              descriptionChanged ? "description" : undefined,
              documentationChanged ? "documentation" : undefined,
              contactChanged ? "primaryContact" : undefined,
              iconChanged ? "icon" : undefined,
              emailChanged ? "logLinkedDatasetQueryUserEmail" : undefined,
              discoveryChanged ? "discoveryType" : undefined,
              sharingChanged ? "sharingEnvironmentConfig" : undefined,
            ),
            body: { name: currentName, ...body },
          }),
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const listings = yield* listListings(output.name);
      yield* Effect.forEach(
        listings.filter((listing) => (listing.name ?? "").length > 0),
        (listing) =>
          deleteRetry(
            analyticshub.deleteProjectsLocationsDataExchangesListings({
              name: listing.name!,
              deleteCommercial: true,
            }),
          ),
        { concurrency: 2 },
      );
      yield* listListings(output.name).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (items) => items.length === 0,
          times: 12,
        }),
      );
      const templates = yield* listQueryTemplates(output.name);
      yield* Effect.forEach(
        templates.filter((template) => (template.name ?? "").length > 0),
        (template) =>
          deleteRetry(
            analyticshub.deleteProjectsLocationsDataExchangesQueryTemplates({
              name: template.name!,
            }),
          ),
        { concurrency: 2 },
      );
      yield* deleteRetry(
        analyticshub.deleteProjectsLocationsDataExchanges({
          name: output.name,
        }),
      );
    }),
  });
