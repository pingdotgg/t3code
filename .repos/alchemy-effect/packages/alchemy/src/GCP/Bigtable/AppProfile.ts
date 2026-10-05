import * as bigtable from "@distilled.cloud/gcp/bigtableadmin_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  instanceNameOf,
  listAlchemyInstances,
  MAX_APP_PROFILE_ID_LENGTH,
  parentOwned,
  parseResourceName,
  toPhysicalId,
  waitForOperation,
  collectPages,
} from "./operations.ts";

export type SingleClusterRouting = {
  /** Cluster id to route all requests to. */
  clusterId: string;
  /**
   * Allow `CheckAndMutateRow` and `ReadModifyWriteRow` on this profile.
   * @default false
   */
  allowTransactionalWrites?: boolean;
};

export type MultiClusterRouting = {
  /**
   * Cluster ids to route to. Empty means every cluster in the instance.
   */
  clusterIds?: string[];
};

export type StandardIsolation = {
  /** Request priority (`PRIORITY_LOW`, `PRIORITY_MEDIUM`, `PRIORITY_HIGH`). */
  priority?: bigtable.StandardIsolationPriorityEnum | (string & {});
};

export type AppProfileProps = {
  /**
   * Parent instance. Full name `projects/{project}/instances/{instance}`
   * or the instance id. Immutable — changing it replaces the app profile.
   */
  instance: string;
  /**
   * App profile id (the `{appProfile}` segment of
   * `.../instances/{instance}/appProfiles/{appProfile}`). If omitted, a
   * unique name is generated from the stack, stage, and logical id. Must
   * be 1-50 characters. Immutable — changing it replaces the app profile.
   */
  appProfileId?: string;
  /**
   * Long-form description of the use case.
   */
  description?: string;
  /**
   * Route all traffic to one cluster. Mutually exclusive with
   * `multiClusterRouting`.
   */
  singleClusterRouting?: SingleClusterRouting;
  /**
   * Route to the nearest eligible cluster. Default when neither routing
   * policy is set.
   */
  multiClusterRouting?: MultiClusterRouting;
  /**
   * Standard isolation (request priority).
   */
  standardIsolation?: StandardIsolation;
  /**
   * Ignore safety checks on create, update, and delete.
   * @default true
   */
  ignoreWarnings?: boolean;
};

export type AppProfile = Resource<
  "GCP.Bigtable.AppProfile",
  AppProfileProps,
  {
    /** Full resource name `projects/{project}/instances/{instance}/appProfiles/{appProfile}`. */
    name: string;
    /** App profile id (last path segment). */
    appProfileId: string;
    /** Parent instance resource name. */
    instance: string;
    /** Instance id. */
    instanceId: string;
    /** Project id. */
    project: string;
    /** Description. */
    description: string | undefined;
    /** Single-cluster routing, if set. */
    singleClusterRouting: SingleClusterRouting | undefined;
    /** Multi-cluster routing, if set. */
    multiClusterRouting: MultiClusterRouting | undefined;
    /** Standard isolation, if set. */
    standardIsolation: StandardIsolation | undefined;
    /** Server etag. */
    etag: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Bigtable app profile — how client traffic is routed across
 * clusters in an instance.
 *
 * The parent instance must already exist. Every instance has a built-in
 * `default` profile; this resource creates additional profiles.
 * Changing `appProfileId` or `instance` replaces the profile.
 * Description, routing, and isolation update in place.
 *
 * App profiles have no labels field. Alchemy treats a profile as owned
 * when its parent instance carries Alchemy labels, so `list` /
 * `pnpm nuke:gcp` can find it. The built-in `default` profile is never
 * listed.
 *
 * ### Creating an App Profile
 * **Example:** Multi-cluster routing
 * ```typescript
 * const instance = yield* GCP.Bigtable.Instance("Data", {});
 * const profile = yield* GCP.Bigtable.AppProfile("Analytics", {
 *   instance: instance.name,
 *   description: "analytics reads",
 *   multiClusterRouting: {},
 * });
 * ```
 *
 * **Example:** Single-cluster routing
 * ```typescript
 * const profile = yield* GCP.Bigtable.AppProfile("Writes", {
 *   instance: instance.name,
 *   singleClusterRouting: {
 *     clusterId: "cluster",
 *     allowTransactionalWrites: true,
 *   },
 * });
 * ```
 *
 * @resource
 * @category Bigtable
 */
export const AppProfile = Resource<AppProfile>("GCP.Bigtable.AppProfile");

export class AppProfileNotResolved extends Data.TaggedError(
  "GCP.Bigtable.AppProfileNotResolved",
)<{
  name: string;
}> {}

const DEFAULT_APP_PROFILE_ID = "default";

const toId = (
  id: string,
  appProfileId: string | undefined,
  existing?: string,
) => toPhysicalId(id, appProfileId, existing, MAX_APP_PROFILE_ID_LENGTH);

const routingOf = (profile: bigtable.AppProfile | AppProfileProps) => {
  const single =
    "singleClusterRouting" in profile
      ? profile.singleClusterRouting
      : undefined;
  const multi =
    "multiClusterRoutingUseAny" in profile
      ? profile.multiClusterRoutingUseAny
      : "multiClusterRouting" in profile
        ? profile.multiClusterRouting
        : undefined;
  return { single, multi };
};

const routingKey = (profile: bigtable.AppProfile | AppProfileProps) => {
  const { single, multi } = routingOf(profile);
  if (single) {
    return JSON.stringify({
      kind: "single",
      clusterId: single.clusterId,
      tx: single.allowTransactionalWrites === true,
    });
  }
  return JSON.stringify({
    kind: "multi",
    clusterIds: [...(multi?.clusterIds ?? [])].sort(),
  });
};

const isolationKey = (
  isolation: StandardIsolation | bigtable.StandardIsolation | undefined,
) => JSON.stringify({ priority: (isolation?.priority ?? "").toUpperCase() });

const toAttrs = (profile: bigtable.AppProfile, project: string) => {
  const name = profile.name ?? "";
  const parsed = parseResourceName(name);
  const single = profile.singleClusterRouting
    ? {
        clusterId: profile.singleClusterRouting.clusterId ?? "",
        allowTransactionalWrites:
          profile.singleClusterRouting.allowTransactionalWrites === true,
      }
    : undefined;
  const multi = profile.multiClusterRoutingUseAny
    ? { clusterIds: profile.multiClusterRoutingUseAny.clusterIds }
    : undefined;
  return {
    name,
    appProfileId: parsed.appProfileId,
    instance: parsed.instance,
    instanceId: parsed.instanceId,
    project: parsed.project || project,
    description: profile.description,
    singleClusterRouting: single,
    multiClusterRouting: multi,
    standardIsolation: profile.standardIsolation
      ? { priority: profile.standardIsolation.priority }
      : undefined,
    etag: profile.etag,
  };
};

const getByName = (name: string) =>
  bigtable
    .getProjectsInstancesAppProfiles({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const toBody = (news: AppProfileProps): bigtable.AppProfile => {
  const body: bigtable.AppProfile = {
    description: news.description,
    standardIsolation: news.standardIsolation,
  };
  if (news.singleClusterRouting !== undefined) {
    body.singleClusterRouting = news.singleClusterRouting;
  } else {
    body.multiClusterRoutingUseAny = {
      clusterIds: news.multiClusterRouting?.clusterIds,
    };
  }
  return body;
};

export const AppProfileProvider = () =>
  Provider.succeed(AppProfile, {
    stables: ["name", "appProfileId", "instance", "instanceId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.appProfileId ?? output?.appProfileId;
      const nextId = news.appProfileId ?? previousId;
      const previousInstance = olds?.instance ?? output?.instance;
      const previousInstanceId = previousInstance
        ? parseResourceName(
            previousInstance.includes("/instances/")
              ? previousInstance
              : `projects/_/instances/${previousInstance}`,
          ).instanceId
        : output?.instanceId;
      const nextInstanceId = parseResourceName(
        news.instance.includes("/instances/")
          ? news.instance
          : `projects/_/instances/${news.instance}`,
      ).instanceId;
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          previousId !== nextId) ||
        (previousInstanceId !== undefined &&
          previousInstanceId !== nextInstanceId)
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const appProfileId = yield* toId(
        id,
        olds?.appProfileId,
        output?.appProfileId,
      );
      const instanceRef = olds?.instance ?? output?.instance;
      const name =
        output?.name ??
        (instanceRef
          ? `${instanceNameOf(env.project, instanceRef)}/appProfiles/${appProfileId}`
          : undefined);
      if (name === undefined) return undefined;
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* parentOwned(attrs.instance)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const owned = new Set(
          (yield* listAlchemyInstances(env.project)).map(
            (instance) => instance.name ?? "",
          ),
        );
        const appProfiles = yield* collectPages(
          bigtable.listProjectsInstancesAppProfiles.pages({
            parent: `projects/${env.project}/instances/-`,
            pageSize: 1000,
          }),
          (page) => page.appProfiles,
        );
        return appProfiles
          .filter((profile) => {
            const parsed = parseResourceName(profile.name ?? "");
            return (
              parsed.appProfileId !== DEFAULT_APP_PROFILE_ID &&
              owned.has(parsed.instance)
            );
          })
          .map((profile) => toAttrs(profile, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const appProfileId = yield* toId(
        id,
        news.appProfileId,
        output?.appProfileId,
      );
      const parent = instanceNameOf(env.project, news.instance);
      const name = `${parent}/appProfiles/${appProfileId}`;
      const ignoreWarnings = news.ignoreWarnings ?? true;
      const desired = toBody(news);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* bigtable
          .createProjectsInstancesAppProfiles({
            parent,
            appProfileId,
            ignoreWarnings,
            body: desired,
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AppProfileNotResolved({ name });
      }

      const descriptionChanged =
        (news.description ?? "") !== (current.description ?? "");
      const routingChanged = routingKey(news) !== routingKey(current);
      const isolationChanged =
        news.standardIsolation !== undefined &&
        isolationKey(news.standardIsolation) !==
          isolationKey(current.standardIsolation);

      if (descriptionChanged || routingChanged || isolationChanged) {
        const mask = [
          descriptionChanged ? "description" : undefined,
          routingChanged
            ? news.singleClusterRouting !== undefined
              ? "single_cluster_routing"
              : "multi_cluster_routing_use_any"
            : undefined,
          isolationChanged ? "standard_isolation" : undefined,
        ].filter((field): field is string => field !== undefined);
        const patched = yield* bigtable
          .patchProjectsInstancesAppProfiles({
            name,
            updateMask: mask.join(","),
            ignoreWarnings,
            body: { ...desired, etag: current.etag },
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 8,
              schedule: Schedule.spaced("1 second"),
            }),
          );
        yield* waitForOperation(patched);
        current = yield* getByName(name);
        if (current === undefined) {
          return yield* new AppProfileNotResolved({ name });
        }
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output, olds }) {
      const ignoreWarnings = olds?.ignoreWarnings ?? true;
      yield* bigtable
        .deleteProjectsInstancesAppProfiles({
          name: output.name,
          ignoreWarnings,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
