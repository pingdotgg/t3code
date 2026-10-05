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
  DEFAULT_ZONE,
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

const COLLECTION = "managementDnsZoneBindings";
const CLOUD_COLLECTION = "privateClouds";
const VEN_COLLECTION = "vmwareEngineNetworks";

export type PrivateCloudsManagementDnsZoneBindingProps = {
  /**
   * Parent private cloud. Full name
   * `projects/{project}/locations/{location}/privateClouds/{privateCloud}`.
   * Immutable — changing it replaces the binding.
   */
  privateCloud: string;
  /**
   * Binding id (the `{managementDnsZoneBinding}` segment). If omitted, a
   * unique RFC1035 name is generated. Immutable — changing it replaces
   * the binding.
   */
  managementDnsZoneBindingId?: string;
  /**
   * Consumer VPC to bind
   * (`projects/{project}/global/networks/{network}`). Mutually exclusive
   * with `vmwareEngineNetwork`. Immutable — changing it replaces the
   * binding.
   */
  vpcNetwork?: string;
  /**
   * VMware Engine network to bind
   * (`projects/{project}/locations/global/vmwareEngineNetworks/{id}`).
   * Mutually exclusive with `vpcNetwork`. Immutable — changing it
   * replaces the binding.
   */
  vmwareEngineNetwork?: string;
  /**
   * Human-readable description. Bindings have no labels field, so
   * Alchemy ownership is stored in a `[alchemy …]` prefix and stripped
   * from attributes.
   */
  description?: string;
};

export type PrivateCloudsManagementDnsZoneBinding = Resource<
  "GCP.VMwareEngine.PrivateCloudsManagementDnsZoneBinding",
  PrivateCloudsManagementDnsZoneBindingProps,
  {
    /** Full resource name `.../privateClouds/{cloud}/managementDnsZoneBindings/{id}`. */
    name: string;
    /** Binding id (last path segment). */
    managementDnsZoneBindingId: string;
    /** Parent private cloud resource name. */
    privateCloud: string;
    /** Project id. */
    project: string;
    /** Location id (typically a zone such as `us-central1-a`). */
    location: string;
    /** Bound consumer VPC, if any. */
    vpcNetwork: string | undefined;
    /** Bound VMware Engine network, if any. */
    vmwareEngineNetwork: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Server-reported state (`ACTIVE`, `CREATING`, …). */
    state: string | undefined;
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
 * A binding between a consumer VPC (or VMware Engine network) and a
 * private cloud's management DNS zone.
 *
 * The management DNS zone holds FQDNs for ESXi hosts and management
 * appliances (vCenter, NSX Manager). Changing the parent private cloud,
 * binding id, or bound network replaces the binding. Description
 * updates in place.
 *
 * ### Creating a Binding
 * **Example:** Bind a consumer VPC
 * ```typescript
 * const binding = yield* GCP.VMwareEngine.PrivateCloudsManagementDnsZoneBinding(
 *   "VpcDns",
 *   {
 *     privateCloud: cloud.name,
 *     vpcNetwork: "projects/my-project/global/networks/default",
 *     description: "consumer vpc",
 *   },
 * );
 * ```
 *
 * **Example:** Bind a VMware Engine network
 * ```typescript
 * const binding = yield* GCP.VMwareEngine.PrivateCloudsManagementDnsZoneBinding(
 *   "VenDns",
 *   {
 *     privateCloud: cloud.name,
 *     vmwareEngineNetwork: ven.name,
 *     description: "standard ven",
 *   },
 * );
 * ```
 *
 * ### Updating a Binding
 * Re-declare the same logical id with changed props; the engine keeps the
 * physical resource and updates it in place.
 *
 * **Example:** Description
 * ```typescript
 * const binding = yield* GCP.VMwareEngine.PrivateCloudsManagementDnsZoneBinding(
 *   "VpcDns",
 *   {
 *     privateCloud: cloud.name,
 *     vpcNetwork: "projects/my-project/global/networks/default",
 *     description: "consumer vpc v2",
 *   },
 * );
 * ```
 *
 * @resource
 * @category VMwareEngine
 */
export const PrivateCloudsManagementDnsZoneBinding =
  Resource<PrivateCloudsManagementDnsZoneBinding>(
    "GCP.VMwareEngine.PrivateCloudsManagementDnsZoneBinding",
  );

const expandCloud = (project: string, value: string) =>
  expandName(value, project, DEFAULT_ZONE, CLOUD_COLLECTION);

const expandVen = (project: string, value: string) =>
  expandName(value, project, DEFAULT_GLOBAL, VEN_COLLECTION);

const expandVpc = (project: string, value: string) => {
  const canonical = canonicalizeLink(value);
  if (canonical.includes("/")) return canonical;
  return `projects/${project}/global/networks/${rfc1035(canonical, "network")}`;
};

const resourceName = (privateCloud: string, bindingId: string) =>
  `${canonicalizeLink(privateCloud)}/${COLLECTION}/${bindingId}`;

const toAttrs = (
  binding: vmwareengine.ManagementDnsZoneBinding,
  project: string,
) => {
  const name = binding.name ?? "";
  const parsed = parseName(name, COLLECTION, DEFAULT_ZONE);
  const ownership = parseOwnership(binding.description);
  return {
    name,
    managementDnsZoneBindingId: parsed.id,
    privateCloud: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    vpcNetwork: binding.vpcNetwork,
    vmwareEngineNetwork: binding.vmwareEngineNetwork,
    description: ownership.text,
    state: binding.state,
    uid: binding.uid,
    createTime: binding.createTime,
    updateTime: binding.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : vmwareengine
        .getProjectsLocationsPrivateCloudsManagementDnsZoneBindings({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listBindingsAt = (parent: string) =>
  collectPages(
    vmwareengine.listProjectsLocationsPrivateCloudsManagementDnsZoneBindings.pages(
      {
        parent,
        pageSize: 1000,
      },
    ),
    (page) => page.managementDnsZoneBindings,
  );

export const PrivateCloudsManagementDnsZoneBindingProvider = () =>
  Provider.succeed(PrivateCloudsManagementDnsZoneBinding, {
    stables: [
      "name",
      "managementDnsZoneBindingId",
      "privateCloud",
      "project",
      "location",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousVpc = canonicalizeLink(
        olds?.vpcNetwork ?? output?.vpcNetwork,
      );
      const nextVpc = canonicalizeLink(news.vpcNetwork);
      const previousVen = canonicalizeLink(
        olds?.vmwareEngineNetwork ?? output?.vmwareEngineNetwork,
      );
      const nextVen = canonicalizeLink(news.vmwareEngineNetwork);
      const switchedToVen = nextVen.length > 0 && previousVpc.length > 0;
      const switchedToVpc = nextVpc.length > 0 && previousVen.length > 0;
      return replaceOnIdentity({
        previousId:
          olds?.managementDnsZoneBindingId ??
          output?.managementDnsZoneBindingId,
        nextId: news.managementDnsZoneBindingId
          ? rfc1035(news.managementDnsZoneBindingId, "binding")
          : (olds?.managementDnsZoneBindingId ??
            output?.managementDnsZoneBindingId),
        previousLocation: "",
        nextLocation: "",
        previousParent: olds?.privateCloud ?? output?.privateCloud,
        nextParent: news.privateCloud,
        extra:
          switchedToVen ||
          switchedToVpc ||
          (previousVpc.length > 0 &&
            nextVpc.length > 0 &&
            previousVpc !== nextVpc) ||
          (previousVen.length > 0 &&
            nextVen.length > 0 &&
            previousVen !== nextVen),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const privateCloud = expandCloud(
        env.project,
        olds?.privateCloud ?? output?.privateCloud ?? "",
      );
      const bindingId = yield* toPhysicalId(
        id,
        olds?.managementDnsZoneBindingId,
        output?.managementDnsZoneBindingId,
        "binding",
      );
      const name =
        output?.name ??
        (privateCloud.length > 0 ? resourceName(privateCloud, bindingId) : "");
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseOwnership(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const clouds = yield* listAcrossLocations(
          env.project,
          env.region,
          (parent) =>
            collectPages(
              vmwareengine.listProjectsLocationsPrivateClouds.pages({
                parent,
                pageSize: 1000,
              }),
              (page) => page.privateClouds,
            ),
        );
        const nested = yield* Effect.forEach(
          clouds.filter((cloud) => (cloud.name ?? "").length > 0),
          (cloud) => listBindingsAt(cloud.name!),
          { concurrency: 4 },
        );
        return nested
          .flat()
          .filter((item) => hasOwnershipMarker(item.description))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const privateCloud = expandCloud(env.project, news.privateCloud);
      const bindingId = yield* toPhysicalId(
        id,
        news.managementDnsZoneBindingId,
        output?.managementDnsZoneBindingId,
        "binding",
      );
      const name = resourceName(privateCloud, bindingId);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeOwnership(ownership, news.description);
      const vpcNetwork =
        news.vpcNetwork === undefined
          ? undefined
          : expandVpc(env.project, news.vpcNetwork);
      const vmwareEngineNetwork =
        news.vmwareEngineNetwork === undefined
          ? undefined
          : expandVen(env.project, news.vmwareEngineNetwork);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* vmwareengine
          .createProjectsLocationsPrivateCloudsManagementDnsZoneBindings({
            parent: privateCloud,
            managementDnsZoneBindingId: bindingId,
            body: {
              description: desiredDescription,
              vpcNetwork,
              vmwareEngineNetwork,
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
          yield* vmwareengine.patchProjectsLocationsPrivateCloudsManagementDnsZoneBindings(
            {
              name: current.name ?? name,
              updateMask: updateMask.join(","),
              body: {
                name: current.name ?? name,
                description: desiredDescription,
              },
            },
          );
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
        .deleteProjectsLocationsPrivateCloudsManagementDnsZoneBindings({
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
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
