import * as cnr from "@distilled.cloud/gcp/cloudnumberregistry_v1alpha";
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
  DEFAULT_LOCATION,
  ResourceNotResolved,
  expandName,
  fieldMask,
  listAtLocation,
  listLabeledPages,
  normalizeLocation,
  parentOf,
  parseName,
  replaceOnIdentity,
  resourceName,
  sameRef,
  toPhysicalId,
  userLabels,
  waitForDeleteOperation,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

const COLLECTION = "realms";
const DEFAULT_TRAFFIC: cnr.RealmTrafficTypeEnum = "PRIVATE";
const DEFAULT_MANAGEMENT: cnr.RealmManagementTypeEnum = "USER";
const DEFAULT_IP_VERSION: cnr.RealmIpVersionEnum = "IPV4";

export type RealmDiscoveryMetadata = {
  eventTime: string | undefined;
  createTime: string | undefined;
  state: string | undefined;
  updateTime: string | undefined;
  resourceUri: string | undefined;
  resource: string | undefined;
  sourceId: string | undefined;
  sourceSubId: string | undefined;
};

export type RealmAggregatedData = {
  customRangesCount: number | undefined;
  discoveredRangesCount: number | undefined;
};

export type RealmProps = {
  /**
   * Realm id (the `{realm}` segment of
   * `projects/{project}/locations/{location}/realms/{realm}`). If omitted,
   * a unique RFC1035 name is generated. Immutable — changing it
   * replaces the realm.
   */
  realmId?: string;
  /**
   * Location of the realm. Cloud Number Registry is global — `global`
   * is the only supported value. Immutable — changing it replaces the
   * realm.
   * @default "global"
   */
  location?: string;
  /**
   * Registry book that claims this realm. Accepts a book id or a full
   * resource name. Immutable — changing it replaces the realm.
   */
  registryBook: string;
  /**
   * Traffic type of the realm (`PRIVATE`, `INTERNET`, `LINKLOCAL`,
   * `UNSET`). Immutable — changing it replaces the realm.
   * @default "PRIVATE"
   */
  trafficType?: cnr.RealmTrafficTypeEnum | (string & {});
  /**
   * Who manages the realm (`USER` for custom ranges, `CNR` for
   * discovered resources). Immutable — changing it replaces the realm.
   * @default "USER"
   */
  managementType?: cnr.RealmManagementTypeEnum | (string & {});
  /**
   * IP version (`IPV4` or `IPV6`). Immutable — changing it replaces
   * the realm.
   * @default "IPV4"
   */
  ipVersion?: cnr.RealmIpVersionEnum | (string & {});
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type Realm = Resource<
  "GCP.CloudNumberRegistry.Realm",
  RealmProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/realms/{realm}`. */
    name: string;
    /** Realm id (last path segment). */
    realmId: string;
    /** Project id. */
    project: string;
    /** Location id of the resource. */
    location: string;
    /** Registry book that claims this realm. */
    registryBook: string | undefined;
    /** Traffic type. */
    trafficType: string | undefined;
    /** Management type. */
    managementType: string | undefined;
    /** IP version. */
    ipVersion: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Discovery metadata, when the realm was imported from Compute Engine. */
    discoveryMetadata: RealmDiscoveryMetadata | undefined;
    /** Aggregated counts, populated when the view is AGGREGATE. */
    aggregatedData: RealmAggregatedData | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Number Registry realm — a routing domain of IP ranges that
 * must not overlap (unless one range is the parent of another). Custom
 * ranges can only be added to user-managed realms.
 *
 * `realmId`, `location`, `registryBook`, `trafficType`,
 * `managementType`, and `ipVersion` replace the resource. Labels
 * update in place.
 *
 * ### Creating a Realm
 * **Example:** User-managed IPv4 realm
 * ```typescript
 * const book = yield* GCP.CloudNumberRegistry.RegistryBook("Inventory", {});
 * const realm = yield* GCP.CloudNumberRegistry.Realm("Private", {
 *   registryBook: book.name,
 *   trafficType: "PRIVATE",
 *   managementType: "USER",
 *   ipVersion: "IPV4",
 * });
 * ```
 *
 * ### Updating a Realm
 * **Example:** Labels
 * ```typescript
 * const realm = yield* GCP.CloudNumberRegistry.Realm("Private", {
 *   registryBook: book.name,
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category CloudNumberRegistry
 */
export const Realm = Resource<Realm>("GCP.CloudNumberRegistry.Realm");

const toDiscovery = (
  metadata: cnr.DiscoveryMetadata | undefined,
): RealmDiscoveryMetadata | undefined =>
  metadata === undefined
    ? undefined
    : {
        eventTime: metadata.eventTime,
        createTime: metadata.createTime,
        state: metadata.state,
        updateTime: metadata.updateTime,
        resourceUri: metadata.resourceUri,
        resource: metadata.resource,
        sourceId: metadata.sourceId,
        sourceSubId: metadata.sourceSubId,
      };

const toAttrs = (item: cnr.Realm, project: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, COLLECTION);
  return {
    name,
    realmId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || DEFAULT_LOCATION,
    registryBook: item.registryBook,
    trafficType: item.trafficType,
    managementType: item.managementType,
    ipVersion: item.ipVersion,
    labels: userLabels(item.labels),
    discoveryMetadata: toDiscovery(item.discoveryMetadata),
    aggregatedData: item.aggregatedData
      ? {
          customRangesCount: item.aggregatedData.customRangesCount,
          discoveredRangesCount: item.aggregatedData.discoveredRangesCount,
        }
      : undefined,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : cnr
        .getProjectsLocationsRealms({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string) =>
  listAtLocation(project, (parent) =>
    listLabeledPages(
      cnr.listProjectsLocationsRealms.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.realms,
      (item) => item.labels,
    ),
  );

export const RealmProvider = () =>
  Provider.succeed(Realm, {
    stables: [
      "name",
      "realmId",
      "project",
      "location",
      "registryBook",
      "trafficType",
      "managementType",
      "ipVersion",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousBook = olds?.registryBook ?? output?.registryBook;
      const previousTraffic = olds?.trafficType ?? output?.trafficType;
      const nextTraffic = news.trafficType ?? previousTraffic;
      const previousManagement = olds?.managementType ?? output?.managementType;
      const nextManagement = news.managementType ?? previousManagement;
      const previousVersion = olds?.ipVersion ?? output?.ipVersion;
      const nextVersion = news.ipVersion ?? previousVersion;
      return replaceOnIdentity({
        previousId: olds?.realmId ?? output?.realmId,
        nextId: news.realmId ?? olds?.realmId ?? output?.realmId,
        previousLocation: normalizeLocation(olds?.location ?? output?.location),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
        ),
        extra:
          (previousBook !== undefined &&
            !sameRef(previousBook, news.registryBook)) ||
          (previousTraffic !== undefined &&
            nextTraffic !== undefined &&
            previousTraffic !== nextTraffic) ||
          (previousManagement !== undefined &&
            nextManagement !== undefined &&
            previousManagement !== nextManagement) ||
          (previousVersion !== undefined &&
            nextVersion !== undefined &&
            previousVersion !== nextVersion),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const realmId = yield* toPhysicalId(
        id,
        olds?.realmId,
        output?.realmId,
        "realm",
      );
      const location = normalizeLocation(olds?.location ?? output?.location);
      const name =
        output?.name ??
        resourceName(env.project, location, COLLECTION, realmId);
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
        const items = yield* listOwned(env.project);
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const realmId = yield* toPhysicalId(
        id,
        news.realmId,
        output?.realmId,
        "realm",
      );
      const location = normalizeLocation(news.location ?? output?.location);
      const name = resourceName(env.project, location, COLLECTION, realmId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const registryBook = expandName(
        news.registryBook,
        env.project,
        location,
        "registryBooks",
      );
      const trafficType = news.trafficType ?? DEFAULT_TRAFFIC;
      const managementType = news.managementType ?? DEFAULT_MANAGEMENT;
      const ipVersion = news.ipVersion ?? DEFAULT_IP_VERSION;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* cnr
          .createProjectsLocationsRealms({
            parent: parentOf(env.project, location),
            realmId,
            body: {
              registryBook,
              trafficType,
              managementType,
              ipVersion,
              labels: desiredLabels,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const mask = fieldMask([
        (upsert.length > 0 || removed.length > 0) && "labels",
      ]);

      if (mask.length > 0) {
        const operation = yield* cnr.patchProjectsLocationsRealms({
          name: current.name ?? name,
          updateMask: mask,
          body: {
            name: current.name ?? name,
            labels: desiredLabels,
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
      const operation = yield* cnr
        .deleteProjectsLocationsRealms({
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
        yield* waitForDeleteOperation(operation);
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
