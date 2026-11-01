import * as ds from "@distilled.cloud/gcp/datastream_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels, toLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  collectPages,
  fingerprint,
  hasAlchemyLabelMap,
  normalizeLocation,
  parseName,
  privateConnectionOf,
  replaceOnIdentity,
  ResourceNotResolved,
  settleOperation,
  toPhysicalId,
  userLabels,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";
import { listPrivateConnections } from "./PrivateConnection.ts";

export type PrivateConnectionsRouteProps = {
  /**
   * Parent private connection. Full name
   * `projects/{project}/locations/{location}/privateConnections/{privateConnection}`
   * or the connection id (combined with `location`). Immutable —
   * changing it replaces the route.
   */
  privateConnection: string;
  /**
   * Region used when `privateConnection` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Route id (the `{route}` segment of
   * `{privateConnection}/routes/{route}`). If omitted, a unique RFC1035
   * name is generated. Immutable — changing it replaces the route.
   */
  routeId?: string;
  /**
   * User-friendly display name. The API has no patch method — changing
   * display name replaces the route.
   */
  displayName?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   * The API has no patch method — changing labels replaces the route.
   */
  labels?: Record<string, string>;
  /**
   * Destination address for the route (hostname or IP). Immutable —
   * changing it replaces the route.
   */
  destinationAddress: string;
  /**
   * Destination port for the route. Immutable — changing it replaces
   * the route.
   */
  destinationPort?: number;
};

export type PrivateConnectionsRoute = Resource<
  "GCP.Datastream.PrivateConnectionsRoute",
  PrivateConnectionsRouteProps,
  {
    /** Full resource name. */
    name: string;
    /** Route id (last path segment). */
    routeId: string;
    /** Parent private connection resource name. */
    privateConnection: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User-friendly display name. */
    displayName: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Destination address. */
    destinationAddress: string | undefined;
    /** Destination port. */
    destinationPort: number | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Datastream route attached to a private connection. Routes advertise
 * a destination address (and optional port) through the private
 * connection's VPC peering or PSC interface.
 *
 * The API has no patch method. `routeId`, parent private connection,
 * destination address/port, display name, and labels are replacement
 * triggers.
 *
 * ### Creating a Route
 * **Example:** Advertise a database host
 * ```typescript
 * const peering = yield* GCP.Datastream.PrivateConnection("DsPeer", {
 *   vpcPeeringConfig: {
 *     vpc: network.networkName,
 *     subnet: "10.9.0.0/29",
 *   },
 * });
 * const route = yield* GCP.Datastream.PrivateConnectionsRoute("DbHost", {
 *   privateConnection: peering.name,
 *   destinationAddress: "10.0.0.8",
 *   destinationPort: 3306,
 *   labels: { env: "test" },
 * });
 * ```
 *
 * @resource
 * @category Datastream
 */
export const PrivateConnectionsRoute = Resource<PrivateConnectionsRoute>(
  "GCP.Datastream.PrivateConnectionsRoute",
);

const resourceName = (privateConnection: string, routeId: string) =>
  `${privateConnection}/routes/${routeId}`;

const toAttrs = (item: ds.Route, project: string, region: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "routes", region);
  return {
    name,
    routeId: parsed.id,
    privateConnection: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    displayName: item.displayName,
    labels: userLabels(item.labels),
    destinationAddress: item.destinationAddress,
    destinationPort: item.destinationPort,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : ds
        .getProjectsLocationsPrivateConnectionsRoutes({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listRoutes = (parent: string) =>
  collectPages(
    ds.listProjectsLocationsPrivateConnectionsRoutes.pages({
      parent,
      pageSize: 1000,
    }),
    (page) => page.routes,
  ).pipe(Effect.catchTag("NotFound", () => Effect.succeed([] as ds.Route[])));

const listOwned = (project: string, region: string) =>
  Effect.gen(function* () {
    const connections = yield* listPrivateConnections(project, region);
    const pages = yield* Effect.forEach(
      connections.filter((item) => (item.name ?? "").length > 0),
      (item) => listRoutes(item.name!),
      { concurrency: 4 },
    );
    return pages.flat().filter((route) => hasAlchemyLabelMap(route.labels));
  });

export const PrivateConnectionsRouteProvider = () =>
  Provider.succeed(PrivateConnectionsRoute, {
    stables: ["name", "routeId", "privateConnection", "project", "location"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousAddress =
        olds?.destinationAddress ?? output?.destinationAddress;
      const nextAddress = news.destinationAddress ?? previousAddress;
      const previousPort = olds?.destinationPort ?? output?.destinationPort;
      const nextPort = news.destinationPort ?? previousPort;
      const previousDisplay = olds?.displayName ?? output?.displayName;
      const nextDisplay = news.displayName ?? previousDisplay;
      const previousLabels = fingerprint(olds?.labels ?? output?.labels);
      const nextLabels = fingerprint(
        news.labels ?? olds?.labels ?? output?.labels,
      );
      const previousParent =
        olds?.privateConnection ?? output?.privateConnection;
      const nextParent = news.privateConnection ?? previousParent;
      return replaceOnIdentity({
        previousId: olds?.routeId ?? output?.routeId,
        nextId: news.routeId ?? olds?.routeId ?? output?.routeId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        previousParent,
        nextParent,
        extra:
          (olds !== undefined || output !== undefined) &&
          (previousAddress !== nextAddress ||
            previousPort !== nextPort ||
            previousDisplay !== nextDisplay ||
            previousLabels !== nextLabels),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const parentId = olds?.privateConnection ?? output?.privateConnection;
      // Recovering an interrupted create whose parent never resolved: no
      // route can exist without its private connection.
      if (typeof parentId !== "string" || parentId.length === 0) {
        return undefined;
      }
      const parent = privateConnectionOf(parentId, env.project, location);
      const routeId = yield* toPhysicalId(
        id,
        olds?.routeId,
        output?.routeId,
        "route",
      );
      const name = output?.name ?? resourceName(parent, routeId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwned(env.project, env.region);
        return items.map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const parent = privateConnectionOf(
        news.privateConnection,
        env.project,
        location,
      );
      const routeId = yield* toPhysicalId(
        id,
        news.routeId,
        output?.routeId,
        "route",
      );
      const name = resourceName(parent, routeId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const displayName = news.displayName ?? routeId;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* ds
          .createProjectsLocationsPrivateConnectionsRoutes({
            parent,
            routeId,
            body: {
              displayName,
              labels: desiredLabels,
              destinationAddress: news.destinationAddress,
              destinationPort: news.destinationPort,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        yield* settleOperation(created);
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* ds
        .deleteProjectsLocationsPrivateConnectionsRoutes({
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
      yield* settleOperation(operation, { notFoundOk: true });
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
