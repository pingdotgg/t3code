import * as netapp from "@distilled.cloud/gcp/netapp_v1";
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
  fieldMask,
  listAtLocation,
  listLabeledPages,
  normalizeLocation,
  parentOf,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  sameStringList,
  toPhysicalId,
  userLabels,
  waitForDeleteOperation,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";

const DEFAULT_TYPE: netapp.HostGroupTypeEnum = "ISCSI_INITIATOR";
const DEFAULT_OS: netapp.HostGroupOsTypeEnum = "LINUX";

export type HostGroupProps = {
  /**
   * Host group id (the `{hostGroup}` segment of
   * `projects/{project}/locations/{location}/hostGroups/{hostGroup}`).
   * If omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Immutable — changing it replaces the group.
   */
  hostGroupId?: string;
  /**
   * Region (`us-central1`, `us-east1`, …). Immutable — changing it
   * replaces the group. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * IQN (iSCSI) or NQN (NVMe) host identifiers in the group.
   */
  hosts: string[];
  /**
   * Host group type. Immutable — changing it replaces the group.
   * @default "ISCSI_INITIATOR"
   */
  type?: netapp.HostGroupTypeEnum | (string & {});
  /**
   * OS type shared by every host. Immutable — changing it replaces the
   * group.
   * @default "LINUX"
   */
  osType?: netapp.HostGroupOsTypeEnum | (string & {});
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type HostGroup = Resource<
  "GCP.NetApp.HostGroup",
  HostGroupProps,
  {
    /** Full resource name. */
    name: string;
    /** Host group id (last path segment). */
    hostGroupId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Host identifiers. */
    hosts: string[];
    /** Host group type. */
    type: string | undefined;
    /** OS type. */
    osType: string | undefined;
    /** Human-readable description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-reported state. */
    state: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud NetApp Volumes host group — a set of iSCSI initiators that can
 * mount a block volume.
 *
 * Changing `hostGroupId`, `location`, `type`, or `osType` replaces the
 * group. Hosts, description, and labels update in place.
 *
 * ### Creating a Host Group
 * **Example:** Generated name
 * ```typescript
 * const group = yield* GCP.NetApp.HostGroup("Initiators", {
 *   hosts: ["iqn.1993-08.org.debian:01:db"],
 * });
 * ```
 *
 * **Example:** Explicit id and OS
 * ```typescript
 * const group = yield* GCP.NetApp.HostGroup("Initiators", {
 *   hostGroupId: "db-hosts",
 *   hosts: ["iqn.1993-08.org.debian:01:db"],
 *   osType: "LINUX",
 *   description: "database initiators",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Host Group
 * **Example:** Hosts and labels
 * ```typescript
 * const group = yield* GCP.NetApp.HostGroup("Initiators", {
 *   hosts: [
 *     "iqn.1993-08.org.debian:01:db",
 *     "iqn.1993-08.org.debian:01:db2",
 *   ],
 *   labels: { env: "prod", team: "storage" },
 * });
 * ```
 *
 * @resource
 * @category NetApp
 */
export const HostGroup = Resource<HostGroup>("GCP.NetApp.HostGroup");

const resourceName = (project: string, location: string, hostGroupId: string) =>
  `projects/${project}/locations/${location}/hostGroups/${hostGroupId}`;

const toAttrs = (item: netapp.HostGroup, project: string, region: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "hostGroups", region);
  return {
    name,
    hostGroupId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    hosts: item.hosts ?? [],
    type: item.type,
    osType: item.osType,
    description: item.description,
    labels: userLabels(item.labels),
    state: item.state,
    createTime: item.createTime,
  };
};

const getByName = (name: string) =>
  netapp
    .getProjectsLocationsHostGroups({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string) =>
  listAtLocation(project, (parent) =>
    listLabeledPages(
      netapp.listProjectsLocationsHostGroups.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.hostGroups,
      (item) => item.labels,
    ),
  );

export const HostGroupProvider = () =>
  Provider.succeed(HostGroup, {
    stables: ["name", "hostGroupId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousType = olds?.type ?? output?.type;
      const previousOs = olds?.osType ?? output?.osType;
      const nextType = news.type ?? DEFAULT_TYPE;
      const nextOs = news.osType ?? DEFAULT_OS;
      return replaceOnIdentity({
        previousId: olds?.hostGroupId ?? output?.hostGroupId,
        nextId: news.hostGroupId ?? olds?.hostGroupId ?? output?.hostGroupId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra:
          (previousType !== undefined && nextType !== previousType) ||
          (previousOs !== undefined && nextOs !== previousOs),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const hostGroupId = yield* toPhysicalId(
        id,
        olds?.hostGroupId,
        output?.hostGroupId,
        "hostgroup",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, hostGroupId);
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
        const items = yield* listOwned(env.project);
        return items.map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const hostGroupId = yield* toPhysicalId(
        id,
        news.hostGroupId,
        output?.hostGroupId,
        "hostgroup",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, hostGroupId);
      const type = news.type ?? DEFAULT_TYPE;
      const osType = news.osType ?? DEFAULT_OS;
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* netapp
          .createProjectsLocationsHostGroups({
            parent: parentOf(env.project, location),
            hostGroupId,
            body: {
              hosts: news.hosts,
              type,
              osType,
              description: news.description,
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

      current = yield* waitUntilReady(
        getByName(current.name ?? name),
        current.name ?? name,
        (item) => item.state,
      );

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const mask = fieldMask([
        (upsert.length > 0 || removed.length > 0) && "labels",
        (current.description ?? "") !== (news.description ?? "") &&
          "description",
        !sameStringList(current.hosts, news.hosts) && "hosts",
      ]);

      if (mask.length > 0) {
        const operation = yield* netapp.patchProjectsLocationsHostGroups({
          name: current.name ?? name,
          updateMask: mask,
          body: {
            name: current.name ?? name,
            labels: desiredLabels,
            description: news.description,
            hosts: news.hosts,
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
      const operation = yield* netapp
        .deleteProjectsLocationsHostGroups({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForDeleteOperation(operation);
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
