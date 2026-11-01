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
  DEFAULT_ZONE,
  VmwareengineNotResolved,
  changedFields,
  collectPages,
  createInternalLabels,
  encodeOwnership,
  expandName,
  hasAlchemyLabels,
  hasOwnershipMarker,
  listAcrossLocations,
  locationFromName,
  normalizeLocation,
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

const COLLECTION = "externalAddresses";
const PARENT_COLLECTION = "privateClouds";

export type PrivateCloudsExternalAddressProps = {
  /**
   * Parent PrivateCloud resource name
   * (`projects/{project}/locations/{location}/privateClouds/{privateCloud}`)
   * or the cloud id. Immutable — changing it replaces the address.
   */
  privateCloud: string;
  /**
   * External address id (the `{externalAddress}` segment of
   * `.../privateClouds/{privateCloud}/externalAddresses/{externalAddress}`).
   * If omitted, a unique RFC1035 name is generated. Immutable.
   */
  externalAddressId?: string;
  /**
   * Location of the parent private cloud. Inferred from `privateCloud`
   * when that value is a full resource name. Immutable.
   * @default "us-central1-a"
   */
  location?: string;
  /**
   * Internal IP address of the workload VM this mapping points at.
   */
  internalIp: string;
  /**
   * Human-readable description. External addresses have no labels field,
   * so Alchemy stamps ownership into a `[alchemy …]` prefix and strips
   * it from attributes.
   */
  description?: string;
};

export type PrivateCloudsExternalAddress = Resource<
  "GCP.VMwareEngine.PrivateCloudsExternalAddress",
  PrivateCloudsExternalAddressProps,
  {
    /** Full resource name. */
    name: string;
    /** External address id (last path segment). */
    externalAddressId: string;
    /** Parent PrivateCloud resource name. */
    privateCloud: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Internal IP of the workload VM. */
    internalIp: string | undefined;
    /** Allocated external IP. */
    externalIp: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Server-reported state. */
    state: string | undefined;
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
 * An allocated external IP address mapped to a workload VM inside a
 * VMware Engine private cloud. The corresponding network policy must have
 * `externalIp` enabled.
 *
 * External addresses have no labels field, so Alchemy stamps ownership
 * into the description for `list` / nuke. Changing the parent cloud,
 * address id, or location replaces the address. Internal IP and
 * description update in place.
 *
 * ### Creating a PrivateCloudsExternalAddress
 * **Example:** Map a workload VM
 * ```typescript
 * const address = yield* GCP.VMwareEngine.PrivateCloudsExternalAddress(
 *   "Web",
 *   {
 *     privateCloud: cloud.name,
 *     internalIp: "192.168.1.10",
 *     description: "web vip",
 *   },
 * );
 * ```
 *
 * @resource
 * @category VMwareEngine
 */
export const PrivateCloudsExternalAddress =
  Resource<PrivateCloudsExternalAddress>(
    "GCP.VMwareEngine.PrivateCloudsExternalAddress",
  );

const parentCloudName = (
  project: string,
  location: string,
  privateCloud: string,
) => expandName(privateCloud, project, location, PARENT_COLLECTION);

const resourceNameOf = (parent: string, externalAddressId: string) =>
  `${parent}/${COLLECTION}/${externalAddressId}`;

const toAttrs = (item: vmwareengine.ExternalAddress, project: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, COLLECTION, DEFAULT_ZONE);
  const ownership = parseOwnership(item.description);
  return {
    name,
    externalAddressId: parsed.id,
    privateCloud: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    internalIp: item.internalIp,
    externalIp: item.externalIp,
    description: ownership.text,
    state: item.state,
    uid: item.uid,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  vmwareengine
    .getProjectsLocationsPrivateCloudsExternalAddresses({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const PrivateCloudsExternalAddressProvider = () =>
  Provider.succeed(PrivateCloudsExternalAddress, {
    stables: [
      "name",
      "externalAddressId",
      "privateCloud",
      "project",
      "location",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_ZONE,
      );
      return replaceOnIdentity({
        previousId: olds?.externalAddressId ?? output?.externalAddressId,
        nextId: news.externalAddressId
          ? rfc1035(news.externalAddressId, "address")
          : (olds?.externalAddressId ?? output?.externalAddressId),
        previousLocation,
        nextLocation: normalizeLocation(
          news.location ??
            locationFromName(news.privateCloud, previousLocation),
          DEFAULT_ZONE,
        ),
        previousParent: olds?.privateCloud ?? output?.privateCloud,
        nextParent: news.privateCloud,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ??
          output?.location ??
          (olds?.privateCloud
            ? locationFromName(olds.privateCloud, DEFAULT_ZONE)
            : undefined),
        DEFAULT_ZONE,
      );
      const parent = parentCloudName(
        env.project,
        location,
        olds?.privateCloud ?? output?.privateCloud ?? "",
      );
      const externalAddressId = yield* toPhysicalId(
        id,
        olds?.externalAddressId,
        output?.externalAddressId,
        "address",
      );
      const name = output?.name ?? resourceNameOf(parent, externalAddressId);
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
          (cloud) =>
            collectPages(
              vmwareengine.listProjectsLocationsPrivateCloudsExternalAddresses.pages(
                {
                  parent: cloud.name ?? "",
                  pageSize: 1000,
                },
              ),
              (page) => page.externalAddresses,
            ),
          { concurrency: 4 },
        );
        return nested
          .flat()
          .filter((item) => hasOwnershipMarker(item.description))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ??
          output?.location ??
          locationFromName(news.privateCloud, DEFAULT_ZONE),
        DEFAULT_ZONE,
      );
      const parent = parentCloudName(env.project, location, news.privateCloud);
      const externalAddressId = yield* toPhysicalId(
        id,
        news.externalAddressId,
        output?.externalAddressId,
        "address",
      );
      const name = resourceNameOf(parent, externalAddressId);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeOwnership(ownership, news.description);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* vmwareengine
          .createProjectsLocationsPrivateCloudsExternalAddresses({
            parent,
            externalAddressId,
            body: {
              internalIp: news.internalIp,
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
      const ipChanged = (current.internalIp ?? "") !== news.internalIp;
      const updateMask = changedFields([
        ["description", descriptionChanged],
        ["internalIp", ipChanged],
      ]);

      if (updateMask.length > 0) {
        const operation =
          yield* vmwareengine.patchProjectsLocationsPrivateCloudsExternalAddresses(
            {
              name: current.name ?? name,
              updateMask: updateMask.join(","),
              body: {
                name: current.name ?? name,
                description: desiredDescription,
                internalIp: news.internalIp,
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
        .deleteProjectsLocationsPrivateCloudsExternalAddresses({
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
