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
  sameJson,
  toPhysicalId,
  waitForOperation,
  waitUntilGone,
  waitUntilPresent,
  waitUntilReady,
} from "./internal.ts";

const COLLECTION = "datastores";

export type GoogleFileService = {
  /** NetApp Volume resource name. */
  netappVolume?: string;
  /** Filestore instance resource name. */
  filestoreInstance?: string;
};

export type ThirdPartyFileService = {
  /** NFS server IP addresses or DNS names. */
  servers?: string[];
  /** VPC used for NFS access. */
  network?: string;
  /** Mount folder name. */
  fileShare?: string;
};

export type NfsDatastore = {
  /** Google-managed file service (NetApp or Filestore). */
  googleFileService?: GoogleFileService;
  /** GCVE-managed file service. */
  googleVmwareFileService?: Record<string, never>;
  /** Third-party NFS file service. */
  thirdPartyFileService?: ThirdPartyFileService;
};

export type DatastoreProps = {
  /**
   * Datastore id (the `{datastore}` segment of
   * `projects/{project}/locations/{location}/datastores/{datastore}`).
   * If omitted, a unique RFC1035 name is generated. Immutable — changing
   * it replaces the datastore.
   */
  datastoreId?: string;
  /**
   * Region (`us-central1`, `us-east1`, …). Immutable — changing it
   * replaces the datastore. `US-CENTRAL1` is accepted and normalized.
   * @default the stack's GCP region (`GCP.Region`, else the profile
   *   region, else `us-central1`)
   */
  location?: string;
  /**
   * NFS backend. Required. Choose Google Filestore/NetApp, a GCVE file
   * service, or a third-party NFS server.
   */
  nfsDatastore: NfsDatastore;
  /**
   * Human-readable description. Datastores have no labels field, so
   * Alchemy stamps ownership into a `[alchemy …]` prefix and strips it
   * from attributes.
   */
  description?: string;
};

export type Datastore = Resource<
  "GCP.VMwareEngine.Datastore",
  DatastoreProps,
  {
    /** Full resource name. */
    name: string;
    /** Datastore id (last path segment). */
    datastoreId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** NFS backend currently configured. */
    nfsDatastore: NfsDatastore | undefined;
    /** Clusters the datastore is attached to. */
    clusters: string[];
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Server-reported state. */
    state: string | undefined;
    /** Server etag. */
    etag: string | undefined;
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
 * A Google Cloud VMware Engine NFS datastore.
 *
 * Datastores have no labels field, so Alchemy stamps ownership into the
 * description for `list` / nuke. Changing `datastoreId`, `location`, or
 * the NFS backend identity replaces the datastore. Description updates
 * in place.
 *
 * ### Creating a Datastore
 * **Example:** Filestore-backed NFS datastore
 * ```typescript
 * const datastore = yield* GCP.VMwareEngine.Datastore("Nfs", {
 *   nfsDatastore: {
 *     googleFileService: {
 *       filestoreInstance:
 *         "projects/my-project/locations/us-central1-a/instances/share",
 *     },
 *   },
 *   description: "app nfs datastore",
 * });
 * ```
 *
 * **Example:** Third-party NFS
 * ```typescript
 * const datastore = yield* GCP.VMwareEngine.Datastore("VendorNfs", {
 *   nfsDatastore: {
 *     thirdPartyFileService: {
 *       servers: ["10.1.2.3"],
 *       network: "projects/my-project/global/networks/default",
 *       fileShare: "vol1",
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 * @category VMwareEngine
 */
export const Datastore = Resource<Datastore>("GCP.VMwareEngine.Datastore");

const resourceName = (project: string, location: string, datastoreId: string) =>
  `${parentOf(project, location)}/${COLLECTION}/${datastoreId}`;

const nfsOf = (
  value: vmwareengine.NfsDatastore | NfsDatastore | undefined,
): NfsDatastore | undefined => {
  if (value === undefined) return undefined;
  return {
    googleFileService:
      value.googleFileService === undefined
        ? undefined
        : {
            netappVolume: value.googleFileService.netappVolume,
            filestoreInstance: value.googleFileService.filestoreInstance,
          },
    googleVmwareFileService:
      value.googleVmwareFileService === undefined ? undefined : {},
    thirdPartyFileService:
      value.thirdPartyFileService === undefined
        ? undefined
        : {
            servers: value.thirdPartyFileService.servers,
            network: value.thirdPartyFileService.network,
            fileShare: value.thirdPartyFileService.fileShare,
          },
  };
};

const toAttrs = (
  item: vmwareengine.Datastore,
  project: string,
  region: string,
) => {
  const name = item.name ?? "";
  const parsed = parseName(name, COLLECTION, region);
  const ownership = parseOwnership(item.description);
  return {
    name,
    datastoreId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    nfsDatastore: nfsOf(item.nfsDatastore),
    clusters: item.clusters ?? [],
    description: ownership.text,
    state: item.state,
    etag: item.etag,
    uid: item.uid,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  vmwareengine
    .getProjectsLocationsDatastores({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const DatastoreProvider = () =>
  Provider.succeed(Datastore, {
    stables: [
      "name",
      "datastoreId",
      "project",
      "location",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousId: olds?.datastoreId ?? output?.datastoreId,
        nextId: news.datastoreId
          ? rfc1035(news.datastoreId, "datastore")
          : (olds?.datastoreId ?? output?.datastoreId),
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra: !sameJson(news.nfsDatastore, olds?.nfsDatastore),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const datastoreId = yield* toPhysicalId(
        id,
        olds?.datastoreId,
        output?.datastoreId,
        "datastore",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, datastoreId);
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
              vmwareengine.listProjectsLocationsDatastores.pages({
                parent,
                pageSize: 1000,
              }),
              (page) => page.datastores,
            ),
        );
        return items
          .filter((item) => hasOwnershipMarker(item.description))
          .map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const datastoreId = yield* toPhysicalId(
        id,
        news.datastoreId,
        output?.datastoreId,
        "datastore",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, datastoreId);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeOwnership(ownership, news.description);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* vmwareengine
          .createProjectsLocationsDatastores({
            parent: parentOf(env.project, location),
            datastoreId,
            body: {
              nfsDatastore: news.nfsDatastore,
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
      const nfsChanged = !sameJson(
        nfsOf(current.nfsDatastore),
        nfsOf(news.nfsDatastore),
      );
      const updateMask = changedFields([
        ["description", descriptionChanged],
        ["nfsDatastore", nfsChanged],
      ]);

      if (updateMask.length > 0) {
        const operation = yield* vmwareengine.patchProjectsLocationsDatastores({
          name: current.name ?? name,
          updateMask: updateMask.join(","),
          body: {
            name: current.name ?? name,
            description: desiredDescription,
            nfsDatastore: news.nfsDatastore,
            etag: current.etag,
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
        .deleteProjectsLocationsDatastores({
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
