import * as baremetalsolution from "@distilled.cloud/gcp/baremetalsolution_v2";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_SIZE_GIB,
  DEFAULT_STORAGE_TYPE,
  differs,
  fieldMask,
  gibOf,
  isDeletingState,
  listAtLocation,
  listLabeledPages,
  networkOf,
  normalizeLocation,
  parentOf,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  sameText,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";

export type AllowedClientProps = {
  /**
   * Bare Metal Solution network the access point sits on. Full name
   * `projects/{project}/locations/{location}/networks/{network}` or the
   * network id (combined with the share location).
   */
  network: string;
  /**
   * Subnet of IP addresses permitted to mount the share (CIDR).
   */
  allowedClientsCidr: string;
  /**
   * Mount permissions for the client.
   * @default "READ_WRITE"
   */
  mountPermissions?:
    | baremetalsolution.AllowedClientMountPermissionsEnum
    | (string & {});
  /**
   * Allow creation of devices (`allow_dev`).
   */
  allowDev?: boolean;
  /**
   * Allow the setuid flag.
   */
  allowSuid?: boolean;
  /**
   * Disable NFS root squashing for this client.
   */
  noRootSquash?: boolean;
};

export type NfsShareProps = {
  /**
   * NFS share id (the `{nfsshare}` segment of
   * `projects/{project}/locations/{location}/nfsShares/{nfsshare}`).
   * If omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Immutable — changing it replaces the share.
   */
  nfsShareId?: string;
  /**
   * Region (`us-central1`, `us-east1`, …). Immutable — changing it
   * replaces the share. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Requested size of the underlying volume, in GiB. Minimum is 100.
   * @default 100
   */
  requestedSizeGib?: number | string;
  /**
   * Storage type of the underlying volume. Immutable — changing it
   * replaces the share.
   * @default "SSD"
   */
  storageType?: baremetalsolution.NfsShareStorageTypeEnum | (string & {});
  /**
   * Independent infrastructure pod. The share can only attach to networks
   * and instances in the same pod. Immutable — changing it replaces the
   * share.
   */
  pod?: string;
  /**
   * Access points allowed to mount the share. At least one client is
   * required to create a share.
   */
  allowedClients: AllowedClientProps[];
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type AllowedClient = {
  /** Network the access point sits on. */
  network: string | undefined;
  /** Client CIDR. */
  allowedClientsCidr: string | undefined;
  /** Mount permissions. */
  mountPermissions: string | undefined;
  /** Whether device creation is allowed. */
  allowDev: boolean | undefined;
  /** Whether the setuid flag is allowed. */
  allowSuid: boolean | undefined;
  /** Whether root squashing is disabled. */
  noRootSquash: boolean | undefined;
  /** Share IP assigned on this network. */
  shareIp: string | undefined;
  /** NFS path (`shareIp:/instanceId`). */
  nfsPath: string | undefined;
};

export type NfsShare = Resource<
  "GCP.BareMetalSolution.NfsShare",
  NfsShareProps,
  {
    /** Full resource name. */
    name: string;
    /** NFS share id (last path segment). */
    nfsShareId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Requested size in GiB. */
    requestedSizeGib: string | undefined;
    /** Storage type of the underlying volume. */
    storageType: string | undefined;
    /** Infrastructure pod. */
    pod: string | undefined;
    /** Allowed access points. */
    allowedClients: AllowedClient[];
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Backend-generated identifier. */
    id: string | undefined;
    /** Underlying volume created for the share. */
    volume: string | undefined;
    /** Server-reported state. */
    state: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Bare Metal Solution NFS share — file storage attached to BMS
 * networks in the same region and pod.
 *
 * Changing `nfsShareId`, `location`, `storageType`, or `pod` replaces the
 * share. Labels and allowed clients update in place.
 *
 * Creating a share requires a Bare Metal Solution environment (physical
 * hardware and a client network). Accounts without BMS entitlement are
 * rejected by the API (`ServiceDisabled` when the API is off).
 *
 * ### Creating an NFS Share
 * **Example:** Generated name
 * ```typescript
 * const share = yield* GCP.BareMetalSolution.NfsShare("Share", {
 *   allowedClients: [
 *     {
 *       network: "client-net",
 *       allowedClientsCidr: "10.0.0.0/24",
 *       mountPermissions: "READ_WRITE",
 *       noRootSquash: true,
 *     },
 *   ],
 * });
 * ```
 *
 * **Example:** Explicit id, size, and labels
 * ```typescript
 * const share = yield* GCP.BareMetalSolution.NfsShare("Share", {
 *   nfsShareId: "app-nfs",
 *   requestedSizeGib: 256,
 *   storageType: "SSD",
 *   allowedClients: [
 *     {
 *       network: network.name,
 *       allowedClientsCidr: "10.200.0.0/28",
 *       mountPermissions: "READ_WRITE",
 *       allowDev: true,
 *       noRootSquash: true,
 *     },
 *   ],
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating an NFS Share
 * **Example:** Labels and allowed clients
 * ```typescript
 * const share = yield* GCP.BareMetalSolution.NfsShare("Share", {
 *   allowedClients: [
 *     {
 *       network: network.name,
 *       allowedClientsCidr: "10.200.0.0/28",
 *       mountPermissions: "READ_ONLY",
 *     },
 *   ],
 *   labels: { env: "prod", team: "storage" },
 * });
 * ```
 *
 * @resource
 * @category BareMetalSolution
 */
export const NfsShare = Resource<NfsShare>("GCP.BareMetalSolution.NfsShare");

const resourceName = (project: string, location: string, nfsShareId: string) =>
  `${parentOf(project, location)}/nfsShares/${nfsShareId}`;

const toAllowedClient = (
  client: baremetalsolution.AllowedClient,
): AllowedClient => ({
  network: client.network,
  allowedClientsCidr: client.allowedClientsCidr,
  mountPermissions: client.mountPermissions,
  allowDev: client.allowDev,
  allowSuid: client.allowSuid,
  noRootSquash: client.noRootSquash,
  shareIp: client.shareIp,
  nfsPath: client.nfsPath,
});

const desiredClient = (
  client: AllowedClientProps,
  project: string,
  location: string,
): baremetalsolution.AllowedClient => ({
  network: networkOf(client.network, project, location),
  allowedClientsCidr: client.allowedClientsCidr,
  mountPermissions: client.mountPermissions,
  allowDev: client.allowDev,
  allowSuid: client.allowSuid,
  noRootSquash: client.noRootSquash,
});

const toAttrs = (
  item: baremetalsolution.NfsShare,
  project: string,
  region: string,
) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "nfsShares", region);
  return {
    name,
    nfsShareId: parsed.id || item.nfsShareId || item.id || "",
    project: parsed.project || project,
    location: parsed.location,
    requestedSizeGib: item.requestedSizeGib,
    storageType: item.storageType,
    pod: item.pod,
    allowedClients: (item.allowedClients ?? []).map(toAllowedClient),
    labels: userLabels(item.labels),
    id: item.id ?? item.nfsShareId,
    volume: item.volume,
    state: item.state,
  };
};

const getByName = (name: string) =>
  Effect.gen(function* () {
    if (name.length === 0 || name.includes("//")) {
      return undefined;
    }
    return yield* baremetalsolution
      .getProjectsLocationsNfsShares({ name })
      .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
  });

const listOwned = (project: string, region: string) =>
  listAtLocation(project, region, (parent) =>
    listLabeledPages(
      baremetalsolution.listProjectsLocationsNfsShares.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.nfsShares,
      (item) => item.labels,
    ),
  );

export const NfsShareProvider = () =>
  Provider.succeed(NfsShare, {
    stables: ["name", "nfsShareId", "project", "location", "id", "volume"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousType = olds?.storageType ?? output?.storageType;
      const nextType = news.storageType ?? previousType;
      const previousPod = olds?.pod ?? output?.pod;
      const nextPod = news.pod ?? previousPod;
      return replaceOnIdentity({
        previousId: olds?.nfsShareId ?? output?.nfsShareId,
        nextId: news.nfsShareId ?? olds?.nfsShareId ?? output?.nfsShareId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra:
          (previousType !== undefined &&
            nextType !== undefined &&
            previousType !== nextType) ||
          (previousPod !== undefined &&
            nextPod !== undefined &&
            previousPod !== nextPod),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const nfsShareId = yield* toPhysicalId(
        id,
        olds?.nfsShareId,
        output?.nfsShareId,
        "nfsshare",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, nfsShareId);
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
      const nfsShareId = yield* toPhysicalId(
        id,
        news.nfsShareId,
        output?.nfsShareId,
        "nfsshare",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, nfsShareId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const size = gibOf(news.requestedSizeGib) ?? DEFAULT_SIZE_GIB;
      const storageType = news.storageType ?? DEFAULT_STORAGE_TYPE;
      const desiredClients = news.allowedClients.map((client) =>
        desiredClient(client, env.project, location),
      );

      let current = yield* getByName(output?.name ?? name);

      if (current !== undefined && isDeletingState(current.state)) {
        yield* waitUntilGone(
          getByName(current.name ?? name),
          current.name ?? name,
        );
        current = undefined;
      }

      if (current === undefined) {
        const created = yield* baremetalsolution
          .createProjectsLocationsNfsShares({
            parent: parentOf(env.project, location),
            body: {
              name,
              requestedSizeGib: size,
              storageType,
              pod: news.pod,
              allowedClients: desiredClients,
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

      const observedLabels = tagRecord(ready.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const clientsChanged = differs(
        (ready.allowedClients ?? []).map((client) => ({
          network: client.network,
          allowedClientsCidr: client.allowedClientsCidr,
          mountPermissions: client.mountPermissions,
          allowDev: client.allowDev,
          allowSuid: client.allowSuid,
          noRootSquash: client.noRootSquash,
        })),
        desiredClients,
      );
      const sizeChanged = !sameText(ready.requestedSizeGib, size);
      const mask = fieldMask([
        labelsChanged && "labels",
        clientsChanged && "allowedClients",
        sizeChanged && "requestedSizeGib",
      ]);

      if (mask.length > 0) {
        const operation =
          yield* baremetalsolution.patchProjectsLocationsNfsShares({
            name: ready.name ?? name,
            updateMask: mask,
            body: {
              name: ready.name ?? name,
              labels: desiredLabels,
              allowedClients: desiredClients,
              requestedSizeGib: size,
            },
          });
        yield* waitForOperation(operation);
        const patched = yield* waitUntilReady(
          getByName(ready.name ?? name),
          ready.name ?? name,
          (item) => item.state,
        );
        return toAttrs(patched, env.project, env.region);
      }

      return toAttrs(ready, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name || output.name.includes("//")) return;
      const operation = yield* baremetalsolution
        .deleteProjectsLocationsNfsShares({ name: output.name })
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
