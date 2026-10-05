import * as spanner from "@distilled.cloud/gcp/spanner_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
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
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  configIdOf,
  configNameOf,
  instanceConfigName,
  parseResourceName,
  retryConcurrentChanges,
  toConfigId,
  waitForOperation,
} from "./operations.ts";

export type ReplicaInfo = {
  /** Replica location (e.g. `us-central1`). */
  location?: string;
  /** Replica type (`READ_WRITE`, `READ_ONLY`, `WITNESS`). */
  type?: spanner.ReplicaInfoTypeEnum | (string & {});
  /** Whether this location is the default leader. */
  defaultLeaderLocation?: boolean;
};

export type InstanceConfigProps = {
  /**
   * Instance config id (the `{config}` segment of
   * `projects/{project}/instanceConfigs/{config}`). User-managed ids must
   * start with `custom-` and match `custom-[-a-z0-9]*[a-z0-9]` (2–64
   * characters). If omitted, a unique `custom-` name is generated.
   * Immutable — changing it replaces the config.
   */
  instanceConfigId?: string;
  /**
   * User-facing display name. Defaults to the instance config id.
   */
  displayName?: string;
  /**
   * Google-managed base config id (`regional-us-central1`) or full name.
   * Immutable — changing it replaces the config.
   * @default `regional-{region}` for the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  baseConfig?: string;
  /**
   * Replica placement. Must include every replica from `baseConfig` plus
   * at least one of its optional replicas. When omitted, Alchemy copies
   * the base replicas and appends the first optional replica.
   * Immutable — changing them replaces the config.
   */
  replicas?: ReplicaInfo[];
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type InstanceConfig = Resource<
  "GCP.Spanner.InstanceConfig",
  InstanceConfigProps,
  {
    /** Full resource name `projects/{project}/instanceConfigs/{config}`. */
    name: string;
    /** Instance config id (last path segment). */
    instanceConfigId: string;
    /** Project id. */
    project: string;
    /** User-facing display name. */
    displayName: string | undefined;
    /** `GOOGLE_MANAGED` or `USER_MANAGED`. */
    configType: string | undefined;
    /** Replica placement. */
    replicas: ReplicaInfo[];
    /** Optional replicas advertised by Google-managed configs. */
    optionalReplicas: ReplicaInfo[];
    /** Full base config name. */
    baseConfig: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Allowed `default_leader` values. */
    leaderOptions: string[];
    /** Whether a create/update is in flight. */
    reconciling: boolean | undefined;
    /** Current state (`CREATING`, `READY`). */
    state: string | undefined;
    /** Whether free instances can be created in this config. */
    freeInstanceAvailability: string | undefined;
    /** Quorum type (`REGION`, `DUAL_REGION`, `MULTI_REGION`). */
    quorumType: string | undefined;
    /** Storage limit in bytes per processing unit. */
    storageLimitPerProcessingUnit: string | undefined;
  },
  never,
  Providers
>;

/**
 * A user-managed Cloud Spanner instance configuration.
 *
 * User-managed configs clone a Google-managed `baseConfig` and add at
 * least one optional read-only replica. Only `displayName` and `labels`
 * update in place; changing `instanceConfigId`, `baseConfig`, or
 * `replicas` replaces the config. Create, update, and delete are
 * long-running. Google-managed configs cannot be created or deleted.
 *
 * ### Creating an Instance Config
 * **Example:** Clone `regional-us-central1` with an optional replica
 * ```typescript
 * const config = yield* GCP.Spanner.InstanceConfig("Custom", {
 *   baseConfig: "regional-us-central1",
 *   displayName: "custom-us-central1",
 *   labels: { env: "test" },
 * });
 * ```
 *
 * **Example:** Explicit id and replica list
 * ```typescript
 * const config = yield* GCP.Spanner.InstanceConfig("Custom", {
 *   instanceConfigId: "custom-us-central1-ro",
 *   baseConfig: "regional-us-central1",
 *   replicas: [
 *     { location: "us-central1", type: "READ_WRITE" },
 *     { location: "us-central1", type: "READ_WRITE" },
 *     { location: "us-central1", type: "READ_WRITE" },
 *     { location: "us-east1", type: "READ_ONLY" },
 *   ],
 * });
 * ```
 *
 * @resource
 * @category Spanner
 */
export const InstanceConfig = Resource<InstanceConfig>(
  "GCP.Spanner.InstanceConfig",
);

export class InstanceConfigNotResolved extends Data.TaggedError(
  "GCP.Spanner.InstanceConfigNotResolved",
)<{
  name: string;
}> {}

export class InstanceConfigNotReady extends Data.TaggedError(
  "GCP.Spanner.InstanceConfigNotReady",
)<{
  name: string;
  state: string;
}> {}

export class InstanceConfigStillExists extends Data.TaggedError(
  "GCP.Spanner.InstanceConfigStillExists",
)<{
  name: string;
}> {}

export class InstanceConfigNoOptionalReplicas extends Data.TaggedError(
  "GCP.Spanner.InstanceConfigNoOptionalReplicas",
)<{
  baseConfig: string;
}> {}

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const replicaOf = (replica: spanner.ReplicaInfo): ReplicaInfo => ({
  location: replica.location,
  type: replica.type,
  defaultLeaderLocation: replica.defaultLeaderLocation,
});

const replicasOf = (
  items: spanner.ReplicaInfoList | undefined,
): ReplicaInfo[] => (items ?? []).map(replicaOf);

const replicaKey = (replicas: ReplicaInfo[] | undefined) =>
  JSON.stringify(
    (replicas ?? [])
      .map((replica) => ({
        location: (replica.location ?? "").toLowerCase(),
        type: (replica.type ?? "").toUpperCase(),
        defaultLeaderLocation: replica.defaultLeaderLocation === true,
      }))
      .sort(
        (left, right) =>
          left.location.localeCompare(right.location) ||
          left.type.localeCompare(right.type),
      ),
  );

const toAttrs = (
  config: spanner.InstanceConfig,
  project: string,
): InstanceConfig["Attributes"] => {
  const name = config.name ?? "";
  const parsed = parseResourceName(name);
  return {
    name,
    instanceConfigId: parsed.instanceConfigId,
    project,
    displayName: config.displayName,
    configType: config.configType,
    replicas: replicasOf(config.replicas),
    optionalReplicas: replicasOf(config.optionalReplicas),
    baseConfig: config.baseConfig,
    labels: userLabels(config.labels),
    leaderOptions: config.leaderOptions ?? [],
    reconciling: config.reconciling,
    state: config.state,
    freeInstanceAvailability: config.freeInstanceAvailability,
    quorumType: config.quorumType,
    storageLimitPerProcessingUnit: config.storageLimitPerProcessingUnit,
  };
};

const getByName = (name: string) =>
  spanner
    .getProjectsInstanceConfigs({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((config) =>
      config
        ? Effect.succeed(config)
        : Effect.fail(new InstanceConfigNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Spanner.InstanceConfigNotResolved",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const isReady = (config: spanner.InstanceConfig) =>
  (config.state ?? "STATE_UNSPECIFIED") === "READY" &&
  config.reconciling !== true;

const waitUntilReady = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (config): config is spanner.InstanceConfig => config !== undefined,
      () => new InstanceConfigNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (config) => isReady(config),
      (config) =>
        new InstanceConfigNotReady({
          name,
          state: config.state ?? "STATE_UNSPECIFIED",
        }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Spanner.InstanceConfigNotReady" ||
        error._tag === "GCP.Spanner.InstanceConfigNotResolved",
      times: 10,
      schedule: Schedule.spaced("8 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((config) =>
      config === undefined
        ? Effect.void
        : Effect.fail(new InstanceConfigStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Spanner.InstanceConfigStillExists",
      times: 10,
      schedule: Schedule.spaced("8 seconds"),
    }),
  );

const desiredReplicas = (
  project: string,
  region: string,
  news: InstanceConfigProps,
): Effect.Effect<
  ReplicaInfo[],
  InstanceConfigNoOptionalReplicas | spanner.GetProjectsInstanceConfigsError,
  spanner.GcpOpContext
> =>
  Effect.gen(function* () {
    if (news.replicas !== undefined && news.replicas.length > 0) {
      return news.replicas;
    }
    const baseName = configNameOf(project, news.baseConfig, region);
    const base = yield* spanner.getProjectsInstanceConfigs({ name: baseName });
    const extra = (base.optionalReplicas ?? [])[0];
    if (extra === undefined) {
      return yield* new InstanceConfigNoOptionalReplicas({
        baseConfig: baseName,
      });
    }
    return [...replicasOf(base.replicas), replicaOf(extra)];
  });

export const InstanceConfigProvider = () =>
  Provider.succeed(InstanceConfig, {
    stables: [
      "name",
      "instanceConfigId",
      "project",
      "baseConfig",
      "configType",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;

      const previousId = olds?.instanceConfigId ?? output?.instanceConfigId;
      const nextId = news.instanceConfigId ?? previousId;
      const previousBase = configIdOf(
        olds?.baseConfig ?? output?.baseConfig,
        env.region,
      );
      const nextBase = configIdOf(
        news.baseConfig ?? output?.baseConfig,
        env.region,
      );
      const replicasChanged =
        news.replicas !== undefined &&
        olds?.replicas !== undefined &&
        replicaKey(news.replicas) !== replicaKey(olds.replicas);

      const idChanged =
        previousId !== undefined &&
        nextId !== undefined &&
        previousId !== nextId;
      const replace = idChanged || previousBase !== nextBase || replicasChanged;
      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          previousBase !== nextBase ||
          replicasChanged ||
          (previousId !== undefined && nextId === previousId),
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const instanceConfigId = yield* toConfigId(
        id,
        olds?.instanceConfigId,
        output?.instanceConfigId,
      );
      const name =
        output?.name ?? instanceConfigName(env.project, instanceConfigId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* spanner.listProjectsInstanceConfigs
          .pages({
            parent: `projects/${env.project}`,
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) =>
              Stream.fromIterable(page.instanceConfigs ?? []),
            ),
            Stream.filter(
              (config) =>
                (config.configType ?? "") === "USER_MANAGED" &&
                Object.keys(config.labels ?? {}).some((key) =>
                  key.startsWith("alchemy-"),
                ),
            ),
            Stream.map((config) => toAttrs(config, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () => Effect.succeed([])),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const instanceConfigId = yield* toConfigId(
        id,
        news.instanceConfigId,
        output?.instanceConfigId,
      );
      const name = instanceConfigName(env.project, instanceConfigId);
      const displayName = news.displayName?.trim() || instanceConfigId;
      const baseConfig = configNameOf(env.project, news.baseConfig, env.region);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const replicas = yield* desiredReplicas(env.project, env.region, news);
        const created = yield* spanner
          .createProjectsInstanceConfigs({
            parent: `projects/${env.project}`,
            body: {
              instanceConfigId,
              instanceConfig: {
                name,
                displayName,
                baseConfig,
                replicas,
                labels: desiredLabels,
              },
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created, { alreadyExistsOk: true });
        }
        current = yield* waitUntilExists(name);
      }

      if (!isReady(current)) {
        current = yield* waitUntilReady(name);
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const displayNameChanged = (current.displayName ?? "") !== displayName;

      if (labelsChanged || displayNameChanged) {
        const fieldMask = [
          labelsChanged ? "labels" : undefined,
          displayNameChanged ? "display_name" : undefined,
        ].filter((field): field is string => field !== undefined);
        const patched = yield* retryConcurrentChanges(
          spanner.patchProjectsInstanceConfigs({
            name,
            body: {
              instanceConfig: {
                name,
                displayName,
                labels: desiredLabels,
              },
              updateMask: fieldMask.join(","),
            },
          }),
        );
        yield* waitForOperation(patched);
        current = yield* waitUntilReady(name);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* spanner.deleteProjectsInstanceConfigs({ name: output.name }).pipe(
        Effect.catchTag("NotFound", () => Effect.void),
        Effect.retry({
          while: (error) => error._tag === "Conflict",
          times: 8,
          schedule: Schedule.spaced("5 seconds"),
        }),
      );
      yield* waitUntilGone(output.name);
    }),
  });
