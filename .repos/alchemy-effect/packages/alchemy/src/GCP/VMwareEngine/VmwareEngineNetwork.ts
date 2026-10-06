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
  changedFields,
  collectPages,
  createInternalLabels,
  encodeOwnership,
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

const COLLECTION = "vmwareEngineNetworks";
const DEFAULT_TYPE =
  "STANDARD" satisfies vmwareengine.VmwareEngineNetworkTypeEnum;

export type VmwareEngineNetworkType =
  | vmwareengine.VmwareEngineNetworkTypeEnum
  | (string & {});

export type VmwareEngineNetworkVpc = {
  /** VPC network type (`INTRANET`, `INTERNET`, `GOOGLE_CLOUD`). */
  type: string | undefined;
  /** Service VPC resource name. */
  network: string | undefined;
};

export type VmwareEngineNetworkProps = {
  /**
   * Network id (the `{vmwareEngineNetwork}` segment of
   * `projects/{project}/locations/{location}/vmwareEngineNetworks/{id}`).
   * If omitted, a unique RFC1035 name is generated. For `LEGACY`
   * networks the API requires `{region}-default`. Immutable — changing
   * it replaces the network.
   */
  vmwareEngineNetworkId?: string;
  /**
   * Location. `STANDARD` networks are global (`global`). `LEGACY`
   * networks are regional (`us-central1`). Immutable — changing it
   * replaces the network. `US-CENTRAL1` is accepted and normalized.
   * @default "global" (`STANDARD`) or the stack's GCP region (`LEGACY`)
   */
  location?: string;
  /**
   * Network type. `STANDARD` is global; `LEGACY` is the per-region
   * singleton `{region}-default`. Immutable — changing it replaces the
   * network.
   * @default "STANDARD"
   */
  type?: VmwareEngineNetworkType;
  /**
   * Human-readable description. VMware Engine networks have no labels
   * field, so Alchemy ownership is stored in a `[alchemy …]` prefix and
   * stripped from attributes.
   */
  description?: string;
};

export type VmwareEngineNetwork = Resource<
  "GCP.VMwareEngine.VmwareEngineNetwork",
  VmwareEngineNetworkProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/vmwareEngineNetworks/{id}`. */
    name: string;
    /** Network id (last path segment). */
    vmwareEngineNetworkId: string;
    /** Project id. */
    project: string;
    /** Location id (`global` or a region). */
    location: string;
    /** Network type (`STANDARD`, `LEGACY`). */
    type: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Server-reported state (`ACTIVE`, `CREATING`, …). */
    state: string | undefined;
    /** Server-generated uid. */
    uid: string | undefined;
    /** Server etag for update/delete. */
    etag: string | undefined;
    /** Attached service VPC networks. */
    vpcNetworks: VmwareEngineNetworkVpc[];
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A VMware Engine network that private clouds attach to for intranet,
 * internet, and Google Cloud connectivity.
 *
 * `STANDARD` networks live at `locations/global`. `LEGACY` networks are
 * regional singletons named `{region}-default`. Changing id, location,
 * or type replaces the network. Description updates in place.
 *
 * ### Creating a Network
 * **Example:** Generated STANDARD network
 * ```typescript
 * const network = yield* GCP.VMwareEngine.VmwareEngineNetwork("Ven", {
 *   type: "STANDARD",
 *   description: "app network",
 * });
 * ```
 *
 * **Example:** Named STANDARD network
 * ```typescript
 * const network = yield* GCP.VMwareEngine.VmwareEngineNetwork("Ven", {
 *   vmwareEngineNetworkId: "app-ven",
 *   location: "global",
 *   type: "STANDARD",
 *   description: "prod network",
 * });
 * ```
 *
 * ### Legacy regional network
 * **Example:** `{region}-default` LEGACY network
 * ```typescript
 * const network = yield* GCP.VMwareEngine.VmwareEngineNetwork("Legacy", {
 *   location: "us-central1",
 *   type: "LEGACY",
 *   description: "legacy default",
 * });
 * ```
 *
 * ### Updating a Network
 * Re-declare the same logical id with changed props; the engine keeps the
 * physical resource and updates it in place.
 *
 * **Example:** Description
 * ```typescript
 * const network = yield* GCP.VMwareEngine.VmwareEngineNetwork("Ven", {
 *   location: "global",
 *   type: "STANDARD",
 *   description: "prod network v2",
 * });
 * ```
 *
 * @resource
 * @category VMwareEngine
 */
export const VmwareEngineNetwork = Resource<VmwareEngineNetwork>(
  "GCP.VMwareEngine.VmwareEngineNetwork",
);

const resourceName = (project: string, location: string, networkId: string) =>
  `${parentOf(project, location)}/${COLLECTION}/${networkId}`;

const typeOf = (value: string | undefined) =>
  (value ?? DEFAULT_TYPE).toUpperCase();

const fallbackLocation = (type: string, region: string) =>
  type === "LEGACY" ? region : DEFAULT_GLOBAL;

const toId = (
  id: string,
  networkId: string | undefined,
  existing: string | undefined,
  type: string,
  location: string,
) => {
  if (networkId !== undefined) {
    return Effect.succeed(rfc1035(networkId, "network"));
  }
  if (type === "LEGACY") {
    return Effect.succeed(existing ?? `${location}-default`);
  }
  return toPhysicalId(id, undefined, existing, "network");
};

const toVpcs = (
  networks: vmwareengine.VpcNetworkList | undefined,
): VmwareEngineNetworkVpc[] =>
  (networks ?? []).map((network) => ({
    type: network.type,
    network: network.network,
  }));

const toAttrs = (
  network: vmwareengine.VmwareEngineNetwork,
  project: string,
) => {
  const name = network.name ?? "";
  const parsed = parseName(name, COLLECTION, DEFAULT_GLOBAL);
  const ownership = parseOwnership(network.description);
  return {
    name,
    vmwareEngineNetworkId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    type: typeOf(network.type),
    description: ownership.text,
    state: network.state,
    uid: network.uid,
    etag: network.etag,
    vpcNetworks: toVpcs(network.vpcNetworks),
    createTime: network.createTime,
    updateTime: network.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : vmwareengine
        .getProjectsLocationsVmwareEngineNetworks({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const VmwareEngineNetworkProvider = () =>
  Provider.succeed(VmwareEngineNetwork, {
    stables: [
      "name",
      "vmwareEngineNetworkId",
      "project",
      "location",
      "type",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousType = typeOf(olds?.type ?? output?.type);
      const nextType = typeOf(news.type ?? olds?.type ?? output?.type);
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        fallbackLocation(previousType, env.region),
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        fallbackLocation(nextType, env.region),
      );
      const previousId =
        olds?.vmwareEngineNetworkId ?? output?.vmwareEngineNetworkId;
      const nextId = news.vmwareEngineNetworkId
        ? rfc1035(news.vmwareEngineNetworkId, "network")
        : nextType === "LEGACY"
          ? `${nextLocation}-default`
          : previousId;
      return replaceOnIdentity({
        previousId,
        nextId,
        previousLocation,
        nextLocation,
        extra: previousType !== nextType,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const type = typeOf(olds?.type ?? output?.type);
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        fallbackLocation(type, env.region),
      );
      const networkId = yield* toId(
        id,
        olds?.vmwareEngineNetworkId,
        output?.vmwareEngineNetworkId,
        type,
        location,
      );
      const name =
        output?.name ?? resourceName(env.project, location, networkId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
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
              vmwareengine.listProjectsLocationsVmwareEngineNetworks.pages({
                parent,
                pageSize: 1000,
              }),
              (page) => page.vmwareEngineNetworks,
            ),
        );
        return items
          .filter((item) => hasOwnershipMarker(item.description))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const type = typeOf(news.type ?? output?.type);
      const location = normalizeLocation(
        news.location ?? output?.location,
        fallbackLocation(type, env.region),
      );
      const networkId = yield* toId(
        id,
        news.vmwareEngineNetworkId,
        output?.vmwareEngineNetworkId,
        type,
        location,
      );
      const name = resourceName(env.project, location, networkId);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeOwnership(ownership, news.description);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* vmwareengine
          .createProjectsLocationsVmwareEngineNetworks({
            parent: parentOf(env.project, location),
            vmwareEngineNetworkId: networkId,
            body: {
              type,
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
      ]);
      if (updateMask.length > 0) {
        const operation =
          yield* vmwareengine.patchProjectsLocationsVmwareEngineNetworks({
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
        .deleteProjectsLocationsVmwareEngineNetworks({
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
