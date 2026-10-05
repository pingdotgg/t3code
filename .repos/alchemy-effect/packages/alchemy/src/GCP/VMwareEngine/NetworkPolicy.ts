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
} from "./internal.ts";

const COLLECTION = "networkPolicies";
const VEN_COLLECTION = "vmwareEngineNetworks";
const DEFAULT_EDGE_CIDR = "192.168.100.0/26";

export type NetworkService = {
  /** Whether the service is enabled. */
  enabled?: boolean;
  /** Output-only service state. */
  state?: string;
};

export type NetworkPolicyProps = {
  /**
   * Network policy id (the `{networkPolicy}` segment of
   * `projects/{project}/locations/{location}/networkPolicies/{networkPolicy}`).
   * If omitted, a unique RFC1035 name is generated. Immutable.
   */
  networkPolicyId?: string;
  /**
   * Region. Immutable — changing it replaces the policy.
   * @default the stack's GCP region (`GCP.Region`, else the profile
   *   region, else `us-central1`)
   */
  location?: string;
  /**
   * IP range in CIDR notation used for internet and external IP access.
   * Must be an RFC 1918 `/26`.
   * @default "192.168.100.0/26"
   */
  edgeServicesCidr?: string;
  /**
   * VMware Engine network this policy governs
   * (`projects/{project}/locations/{location}/vmwareEngineNetworks/{id}`
   * or the network id). Immutable.
   */
  vmwareEngineNetwork?: string;
  /**
   * Internet access for VMware workloads.
   */
  internetAccess?: NetworkService;
  /**
   * External IP assignment. Can only be enabled when internet access is
   * also enabled.
   */
  externalIp?: NetworkService;
  /**
   * Human-readable description. Network policies have no labels field, so
   * Alchemy stamps ownership into a `[alchemy …]` prefix and strips it
   * from attributes.
   */
  description?: string;
};

export type NetworkPolicy = Resource<
  "GCP.VMwareEngine.NetworkPolicy",
  NetworkPolicyProps,
  {
    /** Full resource name. */
    name: string;
    /** Network policy id (last path segment). */
    networkPolicyId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Edge services CIDR. */
    edgeServicesCidr: string | undefined;
    /** Attached VMware Engine network. */
    vmwareEngineNetwork: string | undefined;
    /** Canonical VMware Engine network name. */
    vmwareEngineNetworkCanonical: string | undefined;
    /** Internet access service. */
    internetAccess: NetworkService | undefined;
    /** External IP service. */
    externalIp: NetworkService | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
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
 * A regional VMware Engine network policy that controls internet and
 * external IP access for private clouds on a VMware Engine network.
 *
 * Network policies have no labels field, so Alchemy stamps ownership into
 * the description for `list` / nuke. Changing `networkPolicyId`,
 * `location`, or `vmwareEngineNetwork` replaces the policy. CIDR,
 * internet access, external IP, and description update in place.
 *
 * ### Creating a NetworkPolicy
 * **Example:** Disable internet and external IP
 * ```typescript
 * const policy = yield* GCP.VMwareEngine.NetworkPolicy("Edge", {
 *   vmwareEngineNetwork: ven.name,
 *   edgeServicesCidr: "192.168.100.0/26",
 *   internetAccess: { enabled: false },
 *   externalIp: { enabled: false },
 *   description: "edge policy",
 * });
 * ```
 *
 * @resource
 * @category VMwareEngine
 */
export const NetworkPolicy = Resource<NetworkPolicy>(
  "GCP.VMwareEngine.NetworkPolicy",
);

const resourceName = (
  project: string,
  location: string,
  networkPolicyId: string,
) => `${parentOf(project, location)}/${COLLECTION}/${networkPolicyId}`;

const serviceOf = (
  value: vmwareengine.NetworkService | NetworkService | undefined,
): NetworkService | undefined => {
  if (value === undefined) return undefined;
  return {
    enabled: value.enabled === true,
    state: value.state,
  };
};

const toAttrs = (
  item: vmwareengine.NetworkPolicy,
  project: string,
  region: string,
) => {
  const name = item.name ?? "";
  const parsed = parseName(name, COLLECTION, region);
  const ownership = parseOwnership(item.description);
  return {
    name,
    networkPolicyId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    edgeServicesCidr: item.edgeServicesCidr,
    vmwareEngineNetwork: item.vmwareEngineNetwork,
    vmwareEngineNetworkCanonical: item.vmwareEngineNetworkCanonical,
    internetAccess: serviceOf(item.internetAccess),
    externalIp: serviceOf(item.externalIp),
    description: ownership.text,
    uid: item.uid,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  vmwareengine
    .getProjectsLocationsNetworkPolicies({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const NetworkPolicyProvider = () =>
  Provider.succeed(NetworkPolicy, {
    stables: [
      "name",
      "networkPolicyId",
      "project",
      "location",
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
      return replaceOnIdentity({
        previousId: olds?.networkPolicyId ?? output?.networkPolicyId,
        nextId: news.networkPolicyId
          ? rfc1035(news.networkPolicyId, "networkpolicy")
          : (olds?.networkPolicyId ?? output?.networkPolicyId),
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra:
          previousVen.length > 0 &&
          nextVen.length > 0 &&
          previousVen !== nextVen,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const networkPolicyId = yield* toPhysicalId(
        id,
        olds?.networkPolicyId,
        output?.networkPolicyId,
        "networkpolicy",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, networkPolicyId);
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
              vmwareengine.listProjectsLocationsNetworkPolicies.pages({
                parent,
                pageSize: 1000,
              }),
              (page) => page.networkPolicies,
            ),
        );
        return items
          .filter((item) => hasOwnershipMarker(item.description))
          .map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const networkPolicyId = yield* toPhysicalId(
        id,
        news.networkPolicyId,
        output?.networkPolicyId,
        "networkpolicy",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, networkPolicyId);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeOwnership(ownership, news.description);
      const edgeServicesCidr = news.edgeServicesCidr ?? DEFAULT_EDGE_CIDR;
      const vmwareEngineNetwork = news.vmwareEngineNetwork
        ? expandName(
            news.vmwareEngineNetwork,
            env.project,
            DEFAULT_GLOBAL,
            VEN_COLLECTION,
          )
        : undefined;
      const internetEnabled = news.internetAccess?.enabled === true;
      const externalIpEnabled = news.externalIp?.enabled === true;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* vmwareengine
          .createProjectsLocationsNetworkPolicies({
            parent: parentOf(env.project, location),
            networkPolicyId,
            body: {
              edgeServicesCidr,
              vmwareEngineNetwork,
              internetAccess: { enabled: internetEnabled },
              externalIp: { enabled: externalIpEnabled },
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

      const descriptionChanged =
        (current.description ?? "") !== desiredDescription;
      const cidrChanged = (current.edgeServicesCidr ?? "") !== edgeServicesCidr;
      const internetChanged =
        (current.internetAccess?.enabled === true) !== internetEnabled;
      const externalIpChanged =
        (current.externalIp?.enabled === true) !== externalIpEnabled;
      const updateMask = changedFields([
        ["description", descriptionChanged],
        ["edgeServicesCidr", cidrChanged],
        ["internetAccess.enabled", internetChanged],
        ["externalIp.enabled", externalIpChanged],
      ]);

      if (updateMask.length > 0) {
        const operation =
          yield* vmwareengine.patchProjectsLocationsNetworkPolicies({
            name: current.name ?? name,
            updateMask: updateMask.join(","),
            body: {
              name: current.name ?? name,
              description: desiredDescription,
              edgeServicesCidr,
              internetAccess: { enabled: internetEnabled },
              externalIp: { enabled: externalIpEnabled },
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilPresent(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* vmwareengine
        .deleteProjectsLocationsNetworkPolicies({ name: output.name })
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
