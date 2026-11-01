import * as vmwareengine from "@distilled.cloud/gcp/vmwareengine_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_GLOBAL,
  VmwareengineNotResolved,
  canonicalizeLink,
  changedFields,
  collectPages,
  createInternalLabels,
  encodeOwnership,
  expandName,
  hasAlchemyLabels,
  hasOwnershipMarker,
  listAcrossLocations,
  normalizeLocation,
  parentOf,
  parseName,
  parseOwnership,
  replaceOnIdentity,
  rfc1035,
  toPhysicalId,
  waitForOperation,
  waitUntilGone,
  waitUntilPresent,
  waitUntilReady,
} from "./internal.ts";

const COLLECTION = "privateConnections";
const VEN_COLLECTION = "vmwareEngineNetworks";
const DEFAULT_ROUTING_MODE =
  "GLOBAL" satisfies vmwareengine.PrivateConnectionRoutingModeEnum;

export type PrivateConnectionType =
  | vmwareengine.PrivateConnectionTypeEnum
  | (string & {});

export type PrivateConnectionRoutingMode =
  | vmwareengine.PrivateConnectionRoutingModeEnum
  | (string & {});

export type PrivateConnectionProps = {
  /**
   * Connection id (the `{privateConnection}` segment of
   * `projects/{project}/locations/{location}/privateConnections/{id}`).
   * If omitted, a unique RFC1035 name is generated. Immutable — changing
   * it replaces the connection.
   */
  privateConnectionId?: string;
  /**
   * Region (`us-central1`, …). Immutable — changing it replaces the
   * connection. `US-CENTRAL1` is accepted and normalized.
   * @default the stack's GCP region (`GCP.Region`, else the profile
   *   region, else `us-central1`)
   */
  location?: string;
  /**
   * Connection type (`PRIVATE_SERVICE_ACCESS`, `NETAPP_CLOUD_VOLUMES`,
   * `DELL_POWERSCALE`, `THIRD_PARTY_SERVICE`). Immutable — changing it
   * replaces the connection.
   */
  type: PrivateConnectionType;
  /**
   * VMware Engine network to attach
   * (`projects/{project}/locations/{location}/vmwareEngineNetworks/{id}`).
   * Immutable — changing it replaces the connection.
   */
  vmwareEngineNetwork: string;
  /**
   * Service network to peer
   * (`projects/{project}/global/networks/{network}`). For
   * `PRIVATE_SERVICE_ACCESS` this is the Service Networking VPC. For
   * `THIRD_PARTY_SERVICE` it may be a consumer or producer VPC.
   * Immutable — changing it replaces the connection.
   */
  serviceNetwork: string;
  /**
   * Routing mode. `PRIVATE_SERVICE_ACCESS` accepts `GLOBAL` or
   * `REGIONAL`; other types only support `GLOBAL`.
   * @default "GLOBAL"
   */
  routingMode?: PrivateConnectionRoutingMode;
  /**
   * Human-readable description. Private connections have no labels
   * field, so Alchemy ownership is stored in a `[alchemy …]` prefix and
   * stripped from attributes.
   */
  description?: string;
};

export type PrivateConnection = Resource<
  "GCP.VMwareEngine.PrivateConnection",
  PrivateConnectionProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/privateConnections/{id}`. */
    name: string;
    /** Connection id (last path segment). */
    privateConnectionId: string;
    /** Project id. */
    project: string;
    /** Region id. */
    location: string;
    /** Connection type. */
    type: string;
    /** Attached VMware Engine network. */
    vmwareEngineNetwork: string | undefined;
    /** Canonical VMware Engine network name (project number). */
    vmwareEngineNetworkCanonical: string | undefined;
    /** Peered service network. */
    serviceNetwork: string | undefined;
    /** Routing mode. */
    routingMode: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Server-reported state (`ACTIVE`, `CREATING`, …). */
    state: string | undefined;
    /** VPC peering state (`PEERING_ACTIVE`, `PEERING_INACTIVE`). */
    peeringState: string | undefined;
    /** VPC network peering id. */
    peeringId: string | undefined;
    /** Server-generated uid. */
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
 * A private connection that peers a service VPC with a VMware Engine
 * network so private clouds can reach Google Cloud services, NetApp,
 * Dell PowerScale, or a third-party VPC.
 *
 * Changing id, location, type, `vmwareEngineNetwork`, or
 * `serviceNetwork` replaces the connection. Description and routing
 * mode update in place.
 *
 * ### Creating a Connection
 * **Example:** Third-party VPC
 * ```typescript
 * const connection = yield* GCP.VMwareEngine.PrivateConnection("Peer", {
 *   type: "THIRD_PARTY_SERVICE",
 *   vmwareEngineNetwork: ven.name,
 *   serviceNetwork: "projects/my-project/global/networks/default",
 *   description: "consumer vpc",
 * });
 * ```
 *
 * **Example:** Private Service Access
 * ```typescript
 * const connection = yield* GCP.VMwareEngine.PrivateConnection("Psa", {
 *   location: "us-central1",
 *   type: "PRIVATE_SERVICE_ACCESS",
 *   vmwareEngineNetwork: ven.name,
 *   serviceNetwork:
 *     "projects/my-project/global/networks/servicenetworking",
 *   routingMode: "GLOBAL",
 * });
 * ```
 *
 * ### Updating a Connection
 * Re-declare the same logical id with changed props; the engine keeps the
 * physical resource and updates it in place.
 *
 * **Example:** Description and regional routing
 * ```typescript
 * const connection = yield* GCP.VMwareEngine.PrivateConnection("Psa", {
 *   location: "us-central1",
 *   type: "PRIVATE_SERVICE_ACCESS",
 *   vmwareEngineNetwork: ven.name,
 *   serviceNetwork:
 *     "projects/my-project/global/networks/servicenetworking",
 *   routingMode: "REGIONAL",
 *   description: "psa v2",
 * });
 * ```
 *
 * @resource
 * @category VMwareEngine
 */
export const PrivateConnection = Resource<PrivateConnection>(
  "GCP.VMwareEngine.PrivateConnection",
);

const resourceName = (
  project: string,
  location: string,
  connectionId: string,
) => `${parentOf(project, location)}/${COLLECTION}/${connectionId}`;

const expandVen = (project: string, value: string) =>
  expandName(value, project, DEFAULT_GLOBAL, VEN_COLLECTION);

const expandVpc = (project: string, value: string) => {
  const canonical = canonicalizeLink(value);
  if (canonical.includes("/")) return canonical;
  return `projects/${project}/global/networks/${rfc1035(canonical, "network")}`;
};

const routingOf = (value: string | undefined) =>
  (value ?? DEFAULT_ROUTING_MODE).toUpperCase();

const toAttrs = (
  connection: vmwareengine.PrivateConnection,
  project: string,
  region: string,
) => {
  const name = connection.name ?? "";
  const parsed = parseName(name, COLLECTION, region);
  const ownership = parseOwnership(connection.description);
  return {
    name,
    privateConnectionId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    type: (connection.type ?? "").toUpperCase(),
    vmwareEngineNetwork: connection.vmwareEngineNetwork,
    vmwareEngineNetworkCanonical: connection.vmwareEngineNetworkCanonical,
    serviceNetwork: connection.serviceNetwork,
    routingMode: connection.routingMode,
    description: ownership.text,
    state: connection.state,
    peeringState: connection.peeringState,
    peeringId: connection.peeringId,
    uid: connection.uid,
    createTime: connection.createTime,
    updateTime: connection.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : vmwareengine
        .getProjectsLocationsPrivateConnections({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const PrivateConnectionProvider = () =>
  Provider.succeed(PrivateConnection, {
    stables: [
      "name",
      "privateConnectionId",
      "project",
      "location",
      "type",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousVen = canonicalizeLink(
        olds?.vmwareEngineNetwork ?? output?.vmwareEngineNetwork,
      );
      const nextVen = canonicalizeLink(news.vmwareEngineNetwork);
      const previousService = canonicalizeLink(
        olds?.serviceNetwork ?? output?.serviceNetwork,
      );
      const nextService = canonicalizeLink(news.serviceNetwork);
      const previousType = (olds?.type ?? output?.type ?? "").toUpperCase();
      const nextType = news.type.toUpperCase();
      return replaceOnIdentity({
        previousId: olds?.privateConnectionId ?? output?.privateConnectionId,
        nextId: news.privateConnectionId
          ? rfc1035(news.privateConnectionId, "connection")
          : (olds?.privateConnectionId ?? output?.privateConnectionId),
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra:
          (previousType.length > 0 && previousType !== nextType) ||
          (previousVen.length > 0 && previousVen !== nextVen) ||
          (previousService.length > 0 && previousService !== nextService),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const connectionId = yield* toPhysicalId(
        id,
        olds?.privateConnectionId,
        output?.privateConnectionId,
        "connection",
      );
      const name =
        output?.name ?? resourceName(env.project, location, connectionId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      const { labels } = parseOwnership(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listAcrossLocations(
          env.project,
          env.region,
          (parent) =>
            collectPages(
              vmwareengine.listProjectsLocationsPrivateConnections.pages({
                parent,
                pageSize: 1000,
              }),
              (page) => page.privateConnections,
            ),
        );
        return items
          .filter((item) => hasOwnershipMarker(item.description))
          .map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const connectionId = yield* toPhysicalId(
        id,
        news.privateConnectionId,
        output?.privateConnectionId,
        "connection",
      );
      const name = resourceName(env.project, location, connectionId);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeOwnership(ownership, news.description);
      const type = news.type.toUpperCase();
      const routingMode = routingOf(news.routingMode);
      const vmwareEngineNetwork = expandVen(
        env.project,
        news.vmwareEngineNetwork,
      );
      const serviceNetwork = expandVpc(env.project, news.serviceNetwork);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* vmwareengine
          .createProjectsLocationsPrivateConnections({
            parent: parentOf(env.project, location),
            privateConnectionId: connectionId,
            body: {
              type,
              vmwareEngineNetwork,
              serviceNetwork,
              routingMode,
              description: desiredDescription,
            },
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 5,
              schedule: Schedule.spaced("2 seconds"),
            }),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilPresent(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new VmwareengineNotResolved({ name });
      }

      current = yield* waitUntilReady(
        getByName(current.name ?? name),
        current.name ?? name,
        (item) => item.state,
      );

      const updateMask = changedFields([
        ["description", (current.description ?? "") !== desiredDescription],
        ["routingMode", routingOf(current.routingMode) !== routingMode],
      ]);
      if (updateMask.length > 0) {
        const operation =
          yield* vmwareengine.patchProjectsLocationsPrivateConnections({
            name: current.name ?? name,
            updateMask: updateMask.join(","),
            body: {
              name: current.name ?? name,
              description: desiredDescription,
              routingMode,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilReady(
          getByName(current.name ?? name),
          current.name ?? name,
          (item) => item.state,
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* vmwareengine
        .deleteProjectsLocationsPrivateConnections({ name: output.name })
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
