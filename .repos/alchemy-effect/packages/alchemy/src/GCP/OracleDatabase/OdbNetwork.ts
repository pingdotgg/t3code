import * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels, toLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_NETWORK,
  hasAlchemyLabelMap,
  lastSegment,
  listAtLocation,
  networkName,
  normalizeLocation,
  parentOf,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";

export type OdbNetworkProps = {
  /**
   * ODB Network id (the `{odb_network}` segment of
   * `projects/{project}/locations/{location}/odbNetworks/{odb_network}`).
   * If omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Immutable — changing it replaces the network.
   */
  odbNetworkId?: string;
  /**
   * Region (`us-central1`, `us-east4`, …). Immutable — changing it
   * replaces the network. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * VPC network used for Oracle Database@Google Cloud connectivity.
   * Accepts a name (`default`) or
   * `projects/{project}/global/networks/{network}`. Immutable —
   * changing it replaces the network.
   * @default "default"
   */
  network?: string;
  /**
   * GCP Oracle zone (e.g. `us-east4-b-r2`). If omitted, the service
   * picks a zone. Immutable — changing it replaces the network.
   */
  gcpOracleZone?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type OdbNetwork = Resource<
  "GCP.OracleDatabase.OdbNetwork",
  OdbNetworkProps,
  {
    /** Full resource name. */
    name: string;
    /** ODB Network id (last path segment). */
    odbNetworkId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** VPC network resource name. */
    network: string | undefined;
    /** GCP Oracle zone. */
    gcpOracleZone: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-reported state. */
    state: string | undefined;
    /** Marketplace entitlement id. */
    entitlementId: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Oracle Database@Google Cloud ODB Network — the private network that
 * connects a VPC to Oracle Database resources in a region.
 *
 * Changing `odbNetworkId`, `location`, `network`, or `gcpOracleZone`
 * replaces the network. Labels are set at create; the API has no update.
 * Requires an Oracle Database@Google Cloud marketplace entitlement.
 *
 * ### Creating an ODB Network
 * **Example:** Generated name on the default VPC
 * ```typescript
 * const net = yield* GCP.OracleDatabase.OdbNetwork("OracleNet", {});
 * ```
 *
 * **Example:** Explicit id, labels, and network
 * ```typescript
 * const net = yield* GCP.OracleDatabase.OdbNetwork("OracleNet", {
 *   odbNetworkId: "app-odb",
 *   location: "us-central1",
 *   network: "default",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category OracleDatabase
 */
export const OdbNetwork = Resource<OdbNetwork>("GCP.OracleDatabase.OdbNetwork");

const resourceName = (
  project: string,
  location: string,
  odbNetworkId: string,
) => `projects/${project}/locations/${location}/odbNetworks/${odbNetworkId}`;

const toAttrs = (network: oracle.OdbNetwork, project: string) => {
  const name = network.name ?? "";
  const parsed = parseName(name, "odbNetworks");
  return {
    name,
    odbNetworkId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    network: network.network,
    gcpOracleZone: network.gcpOracleZone,
    labels: userLabels(network.labels),
    state: network.state,
    entitlementId: network.entitlementId,
    createTime: network.createTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : oracle
        .getProjectsLocationsOdbNetworks({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, region: string) =>
  listAtLocation(project, region, (parent) =>
    oracle.listProjectsLocationsOdbNetworks
      .pages({ parent, pageSize: 1000 })
      .pipe(
        Stream.flatMap((page) => Stream.fromIterable(page.odbNetworks ?? [])),
        Stream.filter((item) => hasAlchemyLabelMap(item.labels)),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
        Effect.catchTag("NotFound", () => Effect.succeed([])),
      ),
  );

export const OdbNetworkProvider = () =>
  Provider.succeed(OdbNetwork, {
    stables: [
      "name",
      "odbNetworkId",
      "project",
      "location",
      "network",
      "gcpOracleZone",
      "entitlementId",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousNetwork = lastSegment(
        olds?.network ?? output?.network ?? DEFAULT_NETWORK,
      );
      const nextNetwork = lastSegment(
        news.network ?? olds?.network ?? output?.network ?? DEFAULT_NETWORK,
      );
      const previousZone = olds?.gcpOracleZone ?? output?.gcpOracleZone ?? "";
      const nextZone = news.gcpOracleZone ?? previousZone;
      return replaceOnIdentity({
        previousId: olds?.odbNetworkId ?? output?.odbNetworkId,
        nextId: news.odbNetworkId ?? olds?.odbNetworkId ?? output?.odbNetworkId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location ?? env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location ?? env.region,
        ),
        extra: previousNetwork !== nextNetwork || previousZone !== nextZone,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const odbNetworkId = yield* toPhysicalId(
        id,
        olds?.odbNetworkId,
        output?.odbNetworkId,
        "odbnetwork",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, odbNetworkId);
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
        const items = yield* listOwned(env.project, env.region);
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const odbNetworkId = yield* toPhysicalId(
        id,
        news.odbNetworkId,
        output?.odbNetworkId,
        "odbnetwork",
      );
      const location = normalizeLocation(
        news.location ?? output?.location ?? env.region,
      );
      const name = resourceName(env.project, location, odbNetworkId);
      const network = networkName(env.project, news.network);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* oracle
          .createProjectsLocationsOdbNetworks({
            parent: parentOf(env.project, location),
            odbNetworkId,
            body: {
              network,
              gcpOracleZone: news.gcpOracleZone,
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

      const ready = yield* waitUntilReady(
        getByName(current.name ?? name),
        current.name ?? name,
        (item) => item.state,
      );

      return toAttrs(ready, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* oracle
        .deleteProjectsLocationsOdbNetworks({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("5 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
