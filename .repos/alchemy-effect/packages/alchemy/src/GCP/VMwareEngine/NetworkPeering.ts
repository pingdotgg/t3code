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

const COLLECTION = "networkPeerings";
const VEN_COLLECTION = "vmwareEngineNetworks";

export type NetworkPeeringPeerNetworkType =
  | vmwareengine.NetworkPeeringPeerNetworkTypeEnum
  | (string & {});

export type NetworkPeeringProps = {
  /**
   * Network peering id (the `{networkPeering}` segment of
   * `projects/{project}/locations/global/networkPeerings/{networkPeering}`).
   * If omitted, a unique RFC1035 name is generated. Immutable.
   */
  networkPeeringId?: string;
  /**
   * Location. Network peering is a global resource.
   * @default "global"
   */
  location?: string;
  /**
   * Relative resource name of the network to peer with. VPC networks use
   * `projects/{project}/global/networks/{network}`; VMware Engine
   * networks use
   * `projects/{project}/locations/global/vmwareEngineNetworks/{id}`.
   * Immutable.
   */
  peerNetwork: string;
  /**
   * Type of the peer network (`STANDARD`, `VMWARE_ENGINE_NETWORK`, …).
   * Immutable.
   */
  peerNetworkType: NetworkPeeringPeerNetworkType;
  /**
   * VMware Engine network to peer
   * (`projects/{project}/locations/{location}/vmwareEngineNetworks/{id}`
   * or the network id). Immutable.
   */
  vmwareEngineNetwork: string;
  /**
   * Export custom routes to the peer. Default true.
   */
  exportCustomRoutes?: boolean;
  /**
   * Import custom routes from the peer. Default true.
   */
  importCustomRoutes?: boolean;
  /**
   * Export custom routes that contain public IP ranges. Default true.
   */
  exportCustomRoutesWithPublicIp?: boolean;
  /**
   * Import custom routes that contain public IP ranges. Default true.
   */
  importCustomRoutesWithPublicIp?: boolean;
  /**
   * Automatically exchange subnet routes. Currently always true.
   */
  exchangeSubnetRoutes?: boolean;
  /**
   * Peer MTU in bytes. `0` uses the API default of 1500.
   */
  peerMtu?: number;
  /**
   * Human-readable description. Network peerings have no labels field, so
   * Alchemy stamps ownership into a `[alchemy …]` prefix and strips it
   * from attributes. Description is the only in-place update.
   */
  description?: string;
};

export type NetworkPeering = Resource<
  "GCP.VMwareEngine.NetworkPeering",
  NetworkPeeringProps,
  {
    /** Full resource name. */
    name: string;
    /** Network peering id (last path segment). */
    networkPeeringId: string;
    /** Project id. */
    project: string;
    /** Location id. Always `"global"`. */
    location: string;
    /** Peer network resource name. */
    peerNetwork: string | undefined;
    /** Peer network type. */
    peerNetworkType: string | undefined;
    /** VMware Engine network resource name. */
    vmwareEngineNetwork: string | undefined;
    /** Whether custom routes are exported. */
    exportCustomRoutes: boolean;
    /** Whether custom routes are imported. */
    importCustomRoutes: boolean;
    /** Whether public-IP custom routes are exported. */
    exportCustomRoutesWithPublicIp: boolean;
    /** Whether public-IP custom routes are imported. */
    importCustomRoutesWithPublicIp: boolean;
    /** Whether subnet routes are exchanged. */
    exchangeSubnetRoutes: boolean;
    /** Configured peer MTU. */
    peerMtu: number | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Server-reported state. */
    state: string | undefined;
    /** Extra state details. */
    stateDetails: string | undefined;
    /** System-generated unique identifier. */
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
 * A peering between a VMware Engine network and a VPC or another VMware
 * Engine network. NetworkPeering is a global resource.
 *
 * Network peerings have no labels field, so Alchemy stamps ownership into
 * the description for `list` / nuke. Identity, peer network, peer type,
 * and VMware Engine network are immutable. Description updates in place.
 *
 * ### Creating a NetworkPeering
 * **Example:** Peer a VMware Engine network with the default VPC
 * ```typescript
 * const peering = yield* GCP.VMwareEngine.NetworkPeering("ToVpc", {
 *   vmwareEngineNetwork: ven.name,
 *   peerNetwork: "projects/my-project/global/networks/default",
 *   peerNetworkType: "STANDARD",
 *   description: "gcve to vpc",
 * });
 * ```
 *
 * @resource
 * @category VMwareEngine
 */
export const NetworkPeering = Resource<NetworkPeering>(
  "GCP.VMwareEngine.NetworkPeering",
);

const resourceName = (project: string, networkPeeringId: string) =>
  `${parentOf(project, DEFAULT_GLOBAL)}/${COLLECTION}/${networkPeeringId}`;

const expandVen = (project: string, value: string) =>
  expandName(value, project, DEFAULT_GLOBAL, VEN_COLLECTION);

const boolOrDefault = (value: boolean | undefined, fallback: boolean) =>
  value ?? fallback;

const toAttrs = (item: vmwareengine.NetworkPeering, project: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, COLLECTION, DEFAULT_GLOBAL);
  const ownership = parseOwnership(item.description);
  return {
    name,
    networkPeeringId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || DEFAULT_GLOBAL,
    peerNetwork: item.peerNetwork,
    peerNetworkType: item.peerNetworkType,
    vmwareEngineNetwork: item.vmwareEngineNetwork,
    exportCustomRoutes: item.exportCustomRoutes !== false,
    importCustomRoutes: item.importCustomRoutes !== false,
    exportCustomRoutesWithPublicIp:
      item.exportCustomRoutesWithPublicIp !== false,
    importCustomRoutesWithPublicIp:
      item.importCustomRoutesWithPublicIp !== false,
    exchangeSubnetRoutes: item.exchangeSubnetRoutes !== false,
    peerMtu: item.peerMtu,
    description: ownership.text,
    state: item.state,
    stateDetails: item.stateDetails,
    uid: item.uid,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  vmwareengine
    .getProjectsLocationsNetworkPeerings({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const NetworkPeeringProvider = () =>
  Provider.succeed(NetworkPeering, {
    stables: [
      "name",
      "networkPeeringId",
      "project",
      "location",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousPeer = canonicalizeLink(
        olds?.peerNetwork ?? output?.peerNetwork,
      );
      const nextPeer = canonicalizeLink(news.peerNetwork);
      const previousVen = canonicalizeLink(
        olds?.vmwareEngineNetwork ?? output?.vmwareEngineNetwork,
      );
      const nextVen = canonicalizeLink(news.vmwareEngineNetwork);
      const previousType =
        olds?.peerNetworkType ?? output?.peerNetworkType ?? "";
      return replaceOnIdentity({
        previousId: olds?.networkPeeringId ?? output?.networkPeeringId,
        nextId: news.networkPeeringId
          ? rfc1035(news.networkPeeringId, "networkpeering")
          : (olds?.networkPeeringId ?? output?.networkPeeringId),
        previousLocation: DEFAULT_GLOBAL,
        nextLocation: normalizeLocation(news.location, DEFAULT_GLOBAL),
        extra:
          (previousPeer.length > 0 && previousPeer !== nextPeer) ||
          (previousVen.length > 0 && previousVen !== nextVen) ||
          (previousType.length > 0 && previousType !== news.peerNetworkType),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const networkPeeringId = yield* toPhysicalId(
        id,
        olds?.networkPeeringId,
        output?.networkPeeringId,
        "networkpeering",
      );
      const name = output?.name ?? resourceName(env.project, networkPeeringId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseOwnership(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* collectPages(
          vmwareengine.listProjectsLocationsNetworkPeerings.pages({
            parent: parentOf(env.project, DEFAULT_GLOBAL),
            pageSize: 1000,
          }),
          (page) => page.networkPeerings,
        );
        return items
          .filter((item) => hasOwnershipMarker(item.description))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const networkPeeringId = yield* toPhysicalId(
        id,
        news.networkPeeringId,
        output?.networkPeeringId,
        "networkpeering",
      );
      const name = resourceName(env.project, networkPeeringId);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeOwnership(ownership, news.description);
      const vmwareEngineNetwork = expandVen(
        env.project,
        news.vmwareEngineNetwork,
      );
      const exportCustomRoutes = boolOrDefault(news.exportCustomRoutes, true);
      const importCustomRoutes = boolOrDefault(news.importCustomRoutes, true);
      const exportCustomRoutesWithPublicIp = boolOrDefault(
        news.exportCustomRoutesWithPublicIp,
        true,
      );
      const importCustomRoutesWithPublicIp = boolOrDefault(
        news.importCustomRoutesWithPublicIp,
        true,
      );
      const exchangeSubnetRoutes = boolOrDefault(
        news.exchangeSubnetRoutes,
        true,
      );

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* vmwareengine
          .createProjectsLocationsNetworkPeerings({
            parent: parentOf(env.project, DEFAULT_GLOBAL),
            networkPeeringId,
            body: {
              peerNetwork: news.peerNetwork,
              peerNetworkType: news.peerNetworkType,
              vmwareEngineNetwork,
              exportCustomRoutes,
              importCustomRoutes,
              exportCustomRoutesWithPublicIp,
              importCustomRoutesWithPublicIp,
              exchangeSubnetRoutes,
              peerMtu: news.peerMtu,
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

      const descriptionChanged =
        (current.description ?? "") !== desiredDescription;
      const updateMask = changedFields([["description", descriptionChanged]]);

      if (updateMask.length > 0) {
        const operation =
          yield* vmwareengine.patchProjectsLocationsNetworkPeerings({
            name: current.name ?? name,
            updateMask: updateMask.join(","),
            body: {
              name: current.name ?? name,
              description: desiredDescription,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilReady(
          getByName(current.name ?? name),
          current.name ?? name,
          (item) => item.state,
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* vmwareengine
        .deleteProjectsLocationsNetworkPeerings({ name: output.name })
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
