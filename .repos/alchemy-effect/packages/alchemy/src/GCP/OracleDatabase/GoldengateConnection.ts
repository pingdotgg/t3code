import * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels, toLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  OracleDatabaseNotResolved,
  collectPages,
  hasAlchemyLabelMap,
  listAtLocation,
  normalizeLocation,
  parentOf,
  parseName,
  replaceOnIdentity,
  resourceNameOf,
  retryConflict,
  retryQuota,
  toPhysicalId,
  userLabels,
  waitUntilExists,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";
import { waitForOperation } from "./operations.ts";

const COLLECTION = "goldengateConnections";
const FALLBACK_ID = "ggconn";

export type GoldengateConnectionProps = {
  /**
   * Connection id. If omitted, a unique RFC1035 name is generated.
   * Immutable.
   */
  goldengateConnectionId?: string;
  /**
   * Region. Immutable.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * GCP Oracle zone. Immutable.
   */
  gcpOracleZone?: string;
  /**
   * ODB Network. Immutable.
   */
  odbNetwork?: string;
  /**
   * ODB Subnet. Immutable.
   */
  odbSubnet?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Connection properties. `connectionType` and `displayName` are
   * required on create. Type-specific nested objects (Oracle, Kafka,
   * PostgreSQL, …) are passed through to the API.
   */
  properties?: oracle.GoldengateConnectionProperties;
  /** Connection type. Convenience alias for `properties.connectionType`. */
  connectionType?:
    | oracle.GoldengateConnectionPropertiesConnectionTypeEnum
    | (string & {});
  /** Display name. Convenience alias for `properties.displayName`. */
  displayName?: string;
  /** Description. Convenience alias for `properties.description`. */
  description?: string;
  /** Routing method. Convenience alias for `properties.routingMethod`. */
  routingMethod?:
    | oracle.GoldengateConnectionPropertiesRoutingMethodEnum
    | (string & {});
};

export type GoldengateConnection = Resource<
  "GCP.OracleDatabase.GoldengateConnection",
  GoldengateConnectionProps,
  {
    /** Full resource name. */
    name: string;
    /** Connection id. */
    goldengateConnectionId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** GCP Oracle zone. */
    gcpOracleZone: string | undefined;
    /** ODB Network. */
    odbNetwork: string | undefined;
    /** ODB Subnet. */
    odbSubnet: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Entitlement id. */
    entitlementId: string | undefined;
    /** Connection type. */
    connectionType: string | undefined;
    /** Display name. */
    displayName: string | undefined;
    /** Lifecycle state. */
    lifecycleState: string | undefined;
    /** OCID. */
    ocid: string | undefined;
    /** Ingress IPs. */
    ingressIpAddresses: string[];
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Oracle GoldenGate connection on Google Cloud.
 *
 * Changing `goldengateConnectionId`, `location`, `connectionType`, or
 * ODB identity replaces the connection. There is no patch API in the
 * distilled SDK, so labels are applied at create.
 *
 * ### Creating a GoldenGate connection
 * **Example:** Generic connection
 * ```typescript
 * const conn = yield* GCP.OracleDatabase.GoldengateConnection("Src", {
 *   connectionType: "GENERIC",
 *   displayName: "src",
 *   properties: {
 *     genericConnectionProperties: {
 *       host: "db.example.com",
 *       technologyType: "GENERIC",
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 * @category OracleDatabase
 */
export const GoldengateConnection = Resource<GoldengateConnection>(
  "GCP.OracleDatabase.GoldengateConnection",
);

const mergedProperties = (
  news: GoldengateConnectionProps,
): oracle.GoldengateConnectionProperties => ({
  ...(news.properties ?? {}),
  connectionType: news.connectionType ?? news.properties?.connectionType,
  displayName: news.displayName ?? news.properties?.displayName,
  description: news.description ?? news.properties?.description,
  routingMethod: news.routingMethod ?? news.properties?.routingMethod,
});

const toCreateBody = (
  news: GoldengateConnectionProps,
  desiredLabels: Record<string, string>,
): oracle.GoldengateConnection => {
  const body: oracle.GoldengateConnection = {
    labels: desiredLabels,
    properties: mergedProperties(news),
  };
  if (news.gcpOracleZone !== undefined) body.gcpOracleZone = news.gcpOracleZone;
  if (news.odbNetwork !== undefined) body.odbNetwork = news.odbNetwork;
  if (news.odbSubnet !== undefined) body.odbSubnet = news.odbSubnet;
  return body;
};

const toAttrs = (connection: oracle.GoldengateConnection, project: string) => {
  const name = connection.name ?? "";
  const parsed = parseName(name, COLLECTION);
  return {
    name,
    goldengateConnectionId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    gcpOracleZone: connection.gcpOracleZone,
    odbNetwork: connection.odbNetwork,
    odbSubnet: connection.odbSubnet,
    labels: userLabels(connection.labels),
    entitlementId: connection.entitlementId,
    connectionType: connection.properties?.connectionType,
    displayName: connection.properties?.displayName,
    lifecycleState: connection.properties?.lifecycleState,
    ocid: connection.properties?.ocid,
    ingressIpAddresses: [...(connection.properties?.ingressIpAddresses ?? [])],
    createTime: connection.createTime,
  };
};

const getByName = (name: string) =>
  retryQuota(oracle.getProjectsLocationsGoldengateConnections({ name })).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const listConnections = (project: string, region: string) => {
  const collect = (parent: string) =>
    collectPages(
      oracle.listProjectsLocationsGoldengateConnections.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.goldengateConnections,
    ).pipe(
      Effect.map((items) =>
        items.filter((item) => hasAlchemyLabelMap(item.labels)),
      ),
    );
  return listAtLocation(project, region, collect).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed([])),
  );
};

export const GoldengateConnectionProvider = () =>
  Provider.succeed(GoldengateConnection, {
    stables: [
      "name",
      "goldengateConnectionId",
      "project",
      "location",
      "createTime",
      "ocid",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousType =
        olds?.connectionType ??
        olds?.properties?.connectionType ??
        output?.connectionType ??
        "";
      const nextType =
        news.connectionType ?? news.properties?.connectionType ?? previousType;
      const previousOdb = olds?.odbSubnet ?? output?.odbSubnet ?? "";
      const nextOdb = news.odbSubnet ?? previousOdb;
      return replaceOnIdentity({
        previousId:
          olds?.goldengateConnectionId ?? output?.goldengateConnectionId,
        nextId:
          news.goldengateConnectionId ??
          olds?.goldengateConnectionId ??
          output?.goldengateConnectionId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location ?? env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location ?? env.region,
        ),
        extra: nextType !== previousType || nextOdb !== previousOdb,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const goldengateConnectionId = yield* toPhysicalId(
        id,
        olds?.goldengateConnectionId,
        output?.goldengateConnectionId,
        FALLBACK_ID,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const name =
        output?.name ??
        resourceNameOf(
          env.project,
          location,
          COLLECTION,
          goldengateConnectionId,
        );
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
        const items = yield* listConnections(env.project, env.region);
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const goldengateConnectionId = yield* toPhysicalId(
        id,
        news.goldengateConnectionId,
        output?.goldengateConnectionId,
        FALLBACK_ID,
      );
      const location = normalizeLocation(
        news.location ?? output?.location ?? env.region,
      );
      const name = resourceNameOf(
        env.project,
        location,
        COLLECTION,
        goldengateConnectionId,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* oracle
          .createProjectsLocationsGoldengateConnections({
            parent: parentOf(env.project, location),
            goldengateConnectionId,
            body: toCreateBody(news, desiredLabels),
          })
          .pipe(
            retryQuota,
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new OracleDatabaseNotResolved({ name });
      }

      const ready = yield* waitUntilReady(
        getByName(current.name ?? name),
        current.name ?? name,
        (value) => value.properties?.lifecycleState,
      );

      return toAttrs(ready, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* oracle
        .deleteProjectsLocationsGoldengateConnections({
          name: output.name,
        })
        .pipe(
          retryConflict,
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
