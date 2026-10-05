import * as spanner from "@distilled.cloud/gcp/spanner_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { ALCHEMY_LABEL_PREFIX } from "../Labels.ts";
import { waitForOperation as waitForGcpOperation } from "../Operation.ts";

/** Default instance config: the regional config of the stack's GCP region. */
export const defaultConfigId = (region: string) => `regional-${region}`;
export const DEFAULT_PROCESSING_UNITS = 100;
export const DEFAULT_PARTITION_PROCESSING_UNITS = 1000;
export const MAX_INSTANCE_ID_LENGTH = 64;
export const MAX_INSTANCE_CONFIG_ID_LENGTH = 64;
export const MAX_BACKUP_ID_LENGTH = 60;
export const MAX_BACKUP_SCHEDULE_ID_LENGTH = 60;
export const MAX_PARTITION_ID_LENGTH = 64;
export const MAX_DISPLAY_NAME_LENGTH = 30;
export const MIN_DISPLAY_NAME_LENGTH = 4;
export const CUSTOM_CONFIG_PREFIX = "custom-";

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const parseResourceName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const after = (segment: string) => {
    const at = parts.lastIndexOf(segment);
    return at >= 0 && parts[at + 1] ? parts[at + 1]! : "";
  };
  const project = after("projects");
  const instanceId = after("instances");
  const databaseId = after("databases");
  return {
    project,
    instanceId,
    databaseId,
    backupId: after("backups"),
    backupScheduleId: after("backupSchedules"),
    instancePartitionId: after("instancePartitions"),
    instanceConfigId: after("instanceConfigs"),
    instance:
      project && instanceId
        ? `projects/${project}/instances/${instanceId}`
        : "",
    database:
      project && instanceId && databaseId
        ? `projects/${project}/instances/${instanceId}/databases/${databaseId}`
        : "",
  };
};

export const instanceIdOf = (value: string) =>
  value.includes("/instances/")
    ? parseResourceName(value).instanceId
    : lastSegment(value);

export const databaseIdOf = (value: string) =>
  value.includes("/databases/")
    ? parseResourceName(value).databaseId
    : lastSegment(value);

export const configIdOf = (config: string | undefined, region: string) =>
  lastSegment(config ?? defaultConfigId(region)).toLowerCase();

export const instanceName = (project: string, instanceId: string) =>
  `projects/${project}/instances/${instanceId}`;

export const instanceNameOf = (project: string, instance: string) =>
  instance.includes("/instances/")
    ? instanceName(
        parseResourceName(instance).project || project,
        parseResourceName(instance).instanceId,
      )
    : instanceName(project, lastSegment(instance));

export const databaseName = (
  project: string,
  instanceId: string,
  databaseId: string,
) => `${instanceName(project, instanceId)}/databases/${databaseId}`;

export const databaseNameOf = (
  project: string,
  instance: string,
  database: string,
) => {
  if (database.includes("/databases/")) {
    const parsed = parseResourceName(database);
    return databaseName(
      parsed.project || project,
      parsed.instanceId || instanceIdOf(instance),
      parsed.databaseId,
    );
  }
  return databaseName(project, instanceIdOf(instance), lastSegment(database));
};

export const backupName = (
  project: string,
  instanceId: string,
  backupId: string,
) => `${instanceName(project, instanceId)}/backups/${backupId}`;

export const backupScheduleName = (
  project: string,
  instanceId: string,
  databaseId: string,
  scheduleId: string,
) =>
  `${databaseName(project, instanceId, databaseId)}/backupSchedules/${scheduleId}`;

export const instanceConfigName = (project: string, configId: string) =>
  `projects/${project}/instanceConfigs/${configId}`;

export const configNameOf = (
  project: string,
  config: string | undefined,
  region: string,
) => {
  const raw = (config ?? defaultConfigId(region)).trim();
  if (raw.includes("/")) return raw;
  return instanceConfigName(project, raw);
};

export const instancePartitionName = (
  project: string,
  instanceId: string,
  partitionId: string,
) => `${instanceName(project, instanceId)}/instancePartitions/${partitionId}`;

export const toSpannerId = (name: string, maxLength: number) => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-");
  next = next.replace(/^-+/, "").replace(/-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `s${next}`;
  next = next.slice(0, maxLength).replace(/-+$/g, "");
  if (next.length < 2) next = `${next}xx`.slice(0, maxLength);
  return next;
};

export const toCustomConfigId = (name: string) => {
  const maxBody = MAX_INSTANCE_CONFIG_ID_LENGTH - CUSTOM_CONFIG_PREFIX.length;
  const body = toSpannerId(name, maxBody);
  if (body.startsWith(CUSTOM_CONFIG_PREFIX)) {
    return body.slice(0, MAX_INSTANCE_CONFIG_ID_LENGTH);
  }
  let next = `${CUSTOM_CONFIG_PREFIX}${body}`;
  next = next.slice(0, MAX_INSTANCE_CONFIG_ID_LENGTH).replace(/-+$/g, "");
  if (!/[a-z0-9]$/.test(next)) {
    next = `${next.slice(0, MAX_INSTANCE_CONFIG_ID_LENGTH - 1)}x`;
  }
  return next;
};

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  maxLength: number,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    return toSpannerId(
      yield* createPhysicalName({
        id,
        maxLength,
        lowercase: true,
      }),
      maxLength,
    );
  });

export const toConfigId = (
  id: string,
  explicit: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) {
      return explicit.startsWith(CUSTOM_CONFIG_PREFIX)
        ? explicit
        : toCustomConfigId(explicit);
    }
    if (existing !== undefined) return existing;
    return toCustomConfigId(
      yield* createPhysicalName({
        id,
        maxLength: MAX_INSTANCE_CONFIG_ID_LENGTH,
        lowercase: true,
      }),
    );
  });

export const displayNameOf = (sourceId: string, displayName?: string) => {
  const source = (displayName ?? sourceId).trim();
  let next = source.slice(0, MAX_DISPLAY_NAME_LENGTH);
  if (next.length < MIN_DISPLAY_NAME_LENGTH) {
    next = `${next}inst`.slice(0, MAX_DISPLAY_NAME_LENGTH);
  }
  return next;
};

export const normalizeEnum = (value: string | undefined, fallback: string) => {
  const next = (value ?? fallback).toUpperCase();
  return next.endsWith("_UNSPECIFIED") ? fallback : next;
};

export const hasAlchemyPrefix = (
  labels: Record<string, string | undefined> | null | undefined,
) =>
  Object.keys(labels ?? {}).some((key) => key.startsWith(ALCHEMY_LABEL_PREFIX));

const getOperation = (name: string) => {
  if (name.includes("/instanceConfigs/")) {
    return spanner.getProjectsInstanceConfigsOperations({ name });
  }
  if (name.includes("/instancePartitions/")) {
    return spanner.getProjectsInstancesInstancePartitionsOperations({ name });
  }
  if (name.includes("/backups/")) {
    return spanner.getProjectsInstancesBackupsOperations({ name });
  }
  if (name.includes("/databases/")) {
    return spanner.getProjectsInstancesDatabasesOperations({ name });
  }
  return spanner.getProjectsInstancesOperations({ name });
};

/**
 * Wait for a Spanner operation. Instance and database provisioning can take
 * many minutes, so the budget is generous.
 */
export const waitForOperation = (
  operation: spanner.Operation,
  options?: { notFoundOk?: boolean; alreadyExistsOk?: boolean },
) =>
  waitForGcpOperation(
    operation,
    (name) =>
      getOperation(name).pipe(
        Effect.catchTag("NotFound", (error) =>
          options?.notFoundOk === true
            ? Effect.succeed<spanner.Operation>({ name, done: true })
            : Effect.fail(error),
        ),
      ),
    { budget: "30 minutes" },
  ).pipe(
    // ALREADY_EXISTS (6) / NOT_FOUND (5) when the caller tolerates them.
    Effect.catchIf(
      (error) =>
        error._tag === "GCP.OperationFailed" &&
        ((options?.alreadyExistsOk === true && error.code === 6) ||
          (options?.notFoundOk === true && error.code === 5)),
      () => Effect.void,
    ),
  );

export const retryConcurrentChanges = <
  A,
  E extends { readonly _tag: string },
  R,
>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (error) => error._tag === "Conflict",
      times: 8,
      schedule: Schedule.spaced("5 seconds"),
    }),
  );

export const getInstanceByName = (name: string) =>
  spanner
    .getProjectsInstances({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const listAlchemyInstances = (project: string) =>
  spanner.listProjectsInstances
    .pages({
      parent: `projects/${project}`,
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.instances ?? [])),
      Stream.filter((instance) => hasAlchemyPrefix(instance.labels)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
    );

export const listAlchemyDatabases = (project: string) =>
  Effect.gen(function* () {
    const instances = yield* listAlchemyInstances(project);
    const pages = yield* Effect.forEach(
      instances,
      (instance) => {
        const parent = instance.name;
        if (parent === undefined || parent.length === 0) {
          return Effect.succeed([] as spanner.Database[]);
        }
        return spanner.listProjectsInstancesDatabases
          .pages({
            parent,
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.databases ?? [])),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            // The instance was deleted while listing.
            Effect.catchTag("NotFound", () =>
              Effect.succeed([] as spanner.Database[]),
            ),
          );
      },
      { concurrency: 4 },
    );
    return pages.flat();
  });

export const parentOwned = (instanceNameValue: string) =>
  getInstanceByName(instanceNameValue).pipe(
    Effect.map((instance) =>
      instance === undefined ? true : hasAlchemyPrefix(instance.labels),
    ),
  );
