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
  expandName,
  hasOwnershipMarker,
  listAcrossLocations,
  locationFromName,
  normalizeLocation,
  parseName,
  replaceOnIdentity,
  rfc1035,
  toPhysicalId,
  waitForOperation,
  waitUntilGone,
  waitUntilPresent,
} from "./internal.ts";

const COLLECTION = "loggingServers";
const PARENT_COLLECTION = "privateClouds";
const DEFAULT_PORT = 514;
const DEFAULT_PROTOCOL = "UDP";
const DEFAULT_SOURCE_TYPE = "ESXI";

export type LoggingServerProtocol =
  | vmwareengine.LoggingServerProtocolEnum
  | (string & {});

export type LoggingServerSourceType =
  | vmwareengine.LoggingServerSourceTypeEnum
  | (string & {});

export type PrivateCloudsLoggingServerProps = {
  /**
   * Parent PrivateCloud resource name
   * (`projects/{project}/locations/{location}/privateClouds/{privateCloud}`)
   * or the cloud id. Immutable — changing it replaces the logging server.
   */
  privateCloud: string;
  /**
   * Logging server id (the `{loggingServer}` segment of
   * `.../privateClouds/{privateCloud}/loggingServers/{loggingServer}`).
   * If omitted, a unique RFC1035 name is generated. Immutable.
   */
  loggingServerId?: string;
  /**
   * Location of the parent private cloud. Inferred from `privateCloud`
   * when that value is a full resource name. Immutable.
   * @default "us-central1-a"
   */
  location?: string;
  /**
   * FQDN or IP address of the logging server.
   */
  hostname: string;
  /**
   * Port the logging server listens on.
   * @default 514
   */
  port?: number;
  /**
   * Protocol used to send logs (`UDP`, `TCP`, `TLS`, `SSL`, `RELP`).
   * @default "UDP"
   */
  protocol?: LoggingServerProtocol;
  /**
   * Component that produces logs (`ESXI` or `VCSA`).
   * @default "ESXI"
   */
  sourceType?: LoggingServerSourceType;
};

export type PrivateCloudsLoggingServer = Resource<
  "GCP.VMwareEngine.PrivateCloudsLoggingServer",
  PrivateCloudsLoggingServerProps,
  {
    /** Full resource name. */
    name: string;
    /** Logging server id (last path segment). */
    loggingServerId: string;
    /** Parent PrivateCloud resource name. */
    privateCloud: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** FQDN or IP address. */
    hostname: string | undefined;
    /** Listen port. */
    port: number | undefined;
    /** Log transport protocol. */
    protocol: string | undefined;
    /** Log source type. */
    sourceType: string | undefined;
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
 * A syslog destination that receives vCenter or ESXi logs from a VMware
 * Engine private cloud.
 *
 * Logging servers have no labels or description field, so Alchemy treats
 * servers whose parent private cloud carries the `[alchemy …]` ownership
 * marker as owned for `list` / nuke. Changing the parent cloud, server
 * id, or location replaces the server. Hostname, port, protocol, and
 * source type update in place.
 *
 * ### Creating a PrivateCloudsLoggingServer
 * **Example:** Forward ESXi logs over UDP
 * ```typescript
 * const syslog = yield* GCP.VMwareEngine.PrivateCloudsLoggingServer(
 *   "Esxi",
 *   {
 *     privateCloud: cloud.name,
 *     hostname: "logs.example.com",
 *     port: 514,
 *     protocol: "UDP",
 *     sourceType: "ESXI",
 *   },
 * );
 * ```
 *
 * @resource
 * @category VMwareEngine
 */
export const PrivateCloudsLoggingServer = Resource<PrivateCloudsLoggingServer>(
  "GCP.VMwareEngine.PrivateCloudsLoggingServer",
);

const parentCloudName = (
  project: string,
  location: string,
  privateCloud: string,
) => expandName(privateCloud, project, location, PARENT_COLLECTION);

const resourceNameOf = (parent: string, loggingServerId: string) =>
  `${parent}/${COLLECTION}/${loggingServerId}`;

const toAttrs = (item: vmwareengine.LoggingServer, project: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, COLLECTION, DEFAULT_ZONE);
  return {
    name,
    loggingServerId: parsed.id,
    privateCloud: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    hostname: item.hostname,
    port: item.port,
    protocol: item.protocol,
    sourceType: item.sourceType,
    uid: item.uid,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  vmwareengine
    .getProjectsLocationsPrivateCloudsLoggingServers({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const getParentCloud = (name: string) =>
  vmwareengine
    .getProjectsLocationsPrivateClouds({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const PrivateCloudsLoggingServerProvider = () =>
  Provider.succeed(PrivateCloudsLoggingServer, {
    stables: [
      "name",
      "loggingServerId",
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
        previousId: olds?.loggingServerId ?? output?.loggingServerId,
        nextId: news.loggingServerId
          ? rfc1035(news.loggingServerId, "loggingserver")
          : (olds?.loggingServerId ?? output?.loggingServerId),
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
      const loggingServerId = yield* toPhysicalId(
        id,
        olds?.loggingServerId,
        output?.loggingServerId,
        "loggingserver",
      );
      const name = output?.name ?? resourceNameOf(parent, loggingServerId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      if (output?.name === (existing.name ?? name)) return attrs;
      const parentCloud = yield* getParentCloud(attrs.privateCloud);
      return hasOwnershipMarker(parentCloud?.description)
        ? attrs
        : Unowned(attrs);
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
        const ownedClouds = clouds.filter((cloud) =>
          hasOwnershipMarker(cloud.description),
        );
        const nested = yield* Effect.forEach(
          ownedClouds.filter((cloud) => (cloud.name ?? "").length > 0),
          (cloud) =>
            collectPages(
              vmwareengine.listProjectsLocationsPrivateCloudsLoggingServers.pages(
                {
                  parent: cloud.name ?? "",
                  pageSize: 1000,
                },
              ),
              (page) => page.loggingServers,
            ),
          { concurrency: 4 },
        );
        return nested.flat().map((item) => toAttrs(item, env.project));
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
      const loggingServerId = yield* toPhysicalId(
        id,
        news.loggingServerId,
        output?.loggingServerId,
        "loggingserver",
      );
      const name = resourceNameOf(parent, loggingServerId);
      yield* createInternalLabels(id);
      const port = news.port ?? DEFAULT_PORT;
      const protocol = news.protocol ?? DEFAULT_PROTOCOL;
      const sourceType = news.sourceType ?? DEFAULT_SOURCE_TYPE;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* vmwareengine
          .createProjectsLocationsPrivateCloudsLoggingServers({
            parent,
            loggingServerId,
            body: {
              hostname: news.hostname,
              port,
              protocol,
              sourceType,
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

      const hostnameChanged = (current.hostname ?? "") !== news.hostname;
      const portChanged = (current.port ?? 0) !== port;
      const protocolChanged = (current.protocol ?? "") !== protocol;
      const sourceChanged = (current.sourceType ?? "") !== sourceType;
      const updateMask = changedFields([
        ["hostname", hostnameChanged],
        ["port", portChanged],
        ["protocol", protocolChanged],
        ["sourceType", sourceChanged],
      ]);

      if (updateMask.length > 0) {
        const operation =
          yield* vmwareengine.patchProjectsLocationsPrivateCloudsLoggingServers(
            {
              name: current.name ?? name,
              updateMask: updateMask.join(","),
              body: {
                name: current.name ?? name,
                hostname: news.hostname,
                port,
                protocol,
                sourceType,
              },
            },
          );
        yield* waitForOperation(operation);
        current = yield* waitUntilPresent(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* vmwareengine
        .deleteProjectsLocationsPrivateCloudsLoggingServers({
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
