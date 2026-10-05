import * as bigtable from "@distilled.cloud/gcp/bigtableadmin_v2";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { waitForOperation as waitForGcpOperation } from "../Operation.ts";

export const DEFAULT_ZONE = "us-central1-b";
export const DEFAULT_STORAGE = "HDD";
export const DEFAULT_SERVE_NODES = 1;
export const DEFAULT_INSTANCE_TYPE = "PRODUCTION";
export const DEFAULT_EDITION = "ENTERPRISE";
export const DEFAULT_CLUSTER_ID = "cluster";
export const MAX_INSTANCE_ID_LENGTH = 33;
export const MIN_INSTANCE_ID_LENGTH = 6;
export const MAX_CLUSTER_ID_LENGTH = 30;
export const MIN_CLUSTER_ID_LENGTH = 6;
export const MAX_APP_PROFILE_ID_LENGTH = 50;
export const MAX_TABLE_ID_LENGTH = 50;
export const MAX_BACKUP_ID_LENGTH = 50;
export const MAX_LOGICAL_VIEW_ID_LENGTH = 50;
export const MAX_MATERIALIZED_VIEW_ID_LENGTH = 50;
export const MAX_AUTHORIZED_VIEW_ID_LENGTH = 50;
export const MAX_SCHEMA_BUNDLE_ID_LENGTH = 50;

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const rfc1035 = (
  name: string,
  maxLength: number,
  minLength = 1,
): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `b${next}`;
  next = next.slice(0, maxLength).replace(/-+$/g, "");
  if (next.length === 0) next = "bigtable";
  if (!/[a-z0-9]$/.test(next)) next = `${next.slice(0, maxLength - 1)}0`;
  if (next.length < minLength) {
    next = `${next}${"x".repeat(minLength)}`.slice(0, minLength);
  }
  return next.slice(0, maxLength);
};

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  maxLength: number,
  minLength = 1,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength,
        lowercase: true,
      }),
      maxLength,
      minLength,
    );
  });

export const instanceName = (project: string, instanceId: string) =>
  `projects/${project}/instances/${instanceId}`;

export const clusterName = (
  project: string,
  instanceId: string,
  clusterId: string,
) => `${instanceName(project, instanceId)}/clusters/${clusterId}`;

export const appProfileName = (
  project: string,
  instanceId: string,
  appProfileId: string,
) => `${instanceName(project, instanceId)}/appProfiles/${appProfileId}`;

export const tableName = (
  project: string,
  instanceId: string,
  tableId: string,
) => `${instanceName(project, instanceId)}/tables/${tableId}`;

export const backupName = (
  project: string,
  instanceId: string,
  clusterId: string,
  backupId: string,
) => `${clusterName(project, instanceId, clusterId)}/backups/${backupId}`;

export const logicalViewName = (
  project: string,
  instanceId: string,
  logicalViewId: string,
) => `${instanceName(project, instanceId)}/logicalViews/${logicalViewId}`;

export const materializedViewName = (
  project: string,
  instanceId: string,
  materializedViewId: string,
) =>
  `${instanceName(project, instanceId)}/materializedViews/${materializedViewId}`;

export const authorizedViewName = (
  project: string,
  instanceId: string,
  tableId: string,
  authorizedViewId: string,
) =>
  `${tableName(project, instanceId, tableId)}/authorizedViews/${authorizedViewId}`;

export const schemaBundleName = (
  project: string,
  instanceId: string,
  tableId: string,
  schemaBundleId: string,
) =>
  `${tableName(project, instanceId, tableId)}/schemaBundles/${schemaBundleId}`;

export const parseResourceName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const indexOf = (segment: string) => parts.lastIndexOf(segment);
  const after = (segment: string) => {
    const at = indexOf(segment);
    return at >= 0 && parts[at + 1] ? parts[at + 1]! : "";
  };
  const project = after("projects");
  const instanceId = after("instances");
  const clusterId = after("clusters");
  const tableId = after("tables");
  return {
    project,
    instanceId,
    clusterId,
    appProfileId: after("appProfiles"),
    tableId,
    backupId: after("backups"),
    logicalViewId: after("logicalViews"),
    materializedViewId: after("materializedViews"),
    authorizedViewId: after("authorizedViews"),
    schemaBundleId: after("schemaBundles"),
    instance: project && instanceId ? instanceName(project, instanceId) : "",
    cluster:
      project && instanceId && clusterId
        ? clusterName(project, instanceId, clusterId)
        : "",
    table:
      project && instanceId && tableId
        ? tableName(project, instanceId, tableId)
        : "",
  };
};

export const instanceNameOf = (project: string, instance: string) => {
  if (instance.includes("/instances/")) {
    const parsed = parseResourceName(instance);
    return instanceName(parsed.project || project, parsed.instanceId);
  }
  return instanceName(project, lastSegment(instance));
};

export const instanceIdOf = (value: string) =>
  value.includes("/instances/")
    ? parseResourceName(value).instanceId
    : lastSegment(value);

export const clusterIdOf = (value: string) =>
  value.includes("/clusters/")
    ? parseResourceName(value).clusterId
    : lastSegment(value);

export const tableIdOf = (value: string) =>
  value.includes("/tables/")
    ? parseResourceName(value).tableId
    : lastSegment(value);

export const clusterNameOf = (
  project: string,
  instance: string,
  cluster: string,
) => {
  if (cluster.includes("/clusters/")) {
    const parsed = parseResourceName(cluster);
    return clusterName(
      parsed.project || project,
      parsed.instanceId || instanceIdOf(instance),
      parsed.clusterId,
    );
  }
  return clusterName(project, instanceIdOf(instance), lastSegment(cluster));
};

export const tableNameOf = (
  project: string,
  instance: string,
  table: string,
) => {
  if (table.includes("/tables/")) {
    const parsed = parseResourceName(table);
    return tableName(
      parsed.project || project,
      parsed.instanceId || instanceIdOf(instance),
      parsed.tableId,
    );
  }
  return `${instanceNameOf(project, instance)}/tables/${lastSegment(table)}`;
};

export const clusterLocation = (project: string, location: string) => {
  if (location.includes("/locations/")) {
    const zone = lastSegment(location);
    const parsed = parseResourceName(location);
    return `projects/${parsed.project || project}/locations/${zone}`;
  }
  return `projects/${project}/locations/${lastSegment(location).toLowerCase()}`;
};

export const zoneOf = (location: string | undefined) =>
  lastSegment(location ?? DEFAULT_ZONE).toLowerCase();

export const hasAlchemyPrefix = (
  labels: Record<string, string | undefined> | null | undefined,
) => Object.keys(labels ?? {}).some((key) => key.startsWith("alchemy-"));

/**
 * Wait for a Bigtable admin operation. Cluster resizes and materialized
 * views are the slowest (several minutes). With `alreadyExistsOk`, an
 * ALREADY_EXISTS (code 6) result counts as success (create race).
 */
export const waitForOperation = (
  operation: bigtable.Operation,
  options?: { alreadyExistsOk?: boolean },
) =>
  waitForGcpOperation(operation, (name) => bigtable.getOperations({ name }), {
    budget: "20 minutes",
  }).pipe(
    Effect.catchIf(
      (error) =>
        options?.alreadyExistsOk === true &&
        error._tag === "GCP.OperationFailed" &&
        error.code === 6,
      () => Effect.succeed(operation),
    ),
  );

export const getInstanceByName = (name: string) =>
  bigtable
    .getProjectsInstances({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const collectPages = <Page, A, E, R>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly A[] | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

export const listAlchemyInstances = (project: string) =>
  collectPages(
    bigtable.listProjectsInstances.pages({ parent: `projects/${project}` }),
    (page) => page.instances,
  ).pipe(
    Effect.map((instances) =>
      instances.filter((instance) => hasAlchemyPrefix(instance.labels)),
    ),
  );

export const parentOwned = (instanceNameValue: string) =>
  getInstanceByName(instanceNameValue).pipe(
    Effect.map((instance) =>
      instance === undefined ? true : hasAlchemyPrefix(instance.labels),
    ),
  );

export const listAlchemyTables = (project: string) =>
  Effect.gen(function* () {
    const instances = (yield* listAlchemyInstances(project)).filter(
      (instance): instance is bigtable.Instance & { name: string } =>
        typeof instance.name === "string" && instance.name.length > 0,
    );
    const pages = yield* Effect.forEach(
      instances,
      (instance) =>
        collectPages(
          bigtable.listProjectsInstancesTables.pages({
            parent: instance.name,
            pageSize: 1000,
          }),
          (page) => page.tables,
        ).pipe(
          // The instance was deleted between the two list calls.
          Effect.catchTag("NotFound", () =>
            Effect.succeed([] as bigtable.Table[]),
          ),
        ),
      { concurrency: 4 },
    );
    return pages.flat();
  });
