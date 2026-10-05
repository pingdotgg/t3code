import * as workstations from "@distilled.cloud/gcp/workstations_v1";
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
  expandParent,
  fieldMask,
  fingerprint,
  listAtNested,
  listLabeledPages,
  normalizeLocation,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  sameText,
  stringMap,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type WorkstationPersistentDirectory = {
  /** Mount path of the persistent directory. */
  mountPath?: string;
  /** Desired size of the directory in GB. */
  sizeGb?: number;
};

export type GceInstanceHost = {
  /** Compute Engine instance id. */
  id?: string;
  /** Compute Engine instance name. */
  name?: string;
  /** Compute Engine zone. */
  zone?: string;
};

export type RuntimeHost = {
  /** Compute Engine instance host while the workstation is running. */
  gceInstanceHost?: GceInstanceHost;
};

export type WorkstationClustersWorkstationConfigsWorkstationProps = {
  /**
   * Parent workstation configuration. Full name
   * `projects/{project}/locations/{location}/workstationClusters/{workstationCluster}/workstationConfigs/{workstationConfig}`
   * or a configuration id (combined with `workstationCluster` and
   * `location`). Immutable — changing it replaces the workstation.
   */
  workstationConfig: string;
  /**
   * Parent cluster. Full name or cluster id. Required when
   * `workstationConfig` is a bare id. Immutable.
   */
  workstationCluster?: string;
  /**
   * Workstation id (the `{workstation}` segment). If omitted, a unique
   * RFC1035 name is generated from the stack, stage, and logical id.
   * Immutable — changing it replaces the workstation.
   */
  workstationId?: string;
  /**
   * Region used when parent names are bare ids.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Human-readable display name.
   */
  displayName?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Client-specified annotations.
   */
  annotations?: Record<string, string>;
  /**
   * Environment variables passed to the workstation container entrypoint.
   */
  env?: Record<string, string>;
  /**
   * Directories persisted across sessions. Size updates apply after the
   * workstation is restarted.
   */
  persistentDirectories?: WorkstationPersistentDirectory[];
  /**
   * Source workstation whose persistent directories are cloned on create.
   * Immutable.
   */
  sourceWorkstation?: string;
};

export type WorkstationClustersWorkstationConfigsWorkstation = Resource<
  "GCP.Workstations.WorkstationClustersWorkstationConfigsWorkstation",
  WorkstationClustersWorkstationConfigsWorkstationProps,
  {
    /** Full resource name. */
    name: string;
    /** Workstation id (last path segment). */
    workstationId: string;
    /** Parent configuration name. */
    workstationConfig: string;
    /** Parent cluster name. */
    workstationCluster: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Human-readable display name. */
    displayName: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Client-specified annotations. */
    annotations: Record<string, string>;
    /** Environment variables. */
    env: Record<string, string>;
    /** Persistent directories. */
    persistentDirectories: WorkstationPersistentDirectory[] | undefined;
    /** Source workstation cloned on create. */
    sourceWorkstation: string | undefined;
    /** Current workstation state. */
    state: string | undefined;
    /** Hostname for HTTPS traffic to the workstation. */
    host: string | undefined;
    /** Runtime host while `STATE_RUNNING`. */
    runtimeHost: RuntimeHost | undefined;
    /** KMS key encrypting this workstation. */
    kmsKey: string | undefined;
    /** Whether the workstation is reconciling. */
    reconciling: boolean;
    /** RFC3339 last-start timestamp. */
    startTime: string | undefined;
    /** Server-generated resource uid. */
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
 * A Cloud Workstations workstation — a single developer VM with its own
 * persistent storage, created from a workstation configuration.
 *
 * Changing `workstationId`, `location`, `workstationConfig`,
 * `workstationCluster`, or `sourceWorkstation` replaces the workstation.
 * Display name, labels, annotations, env, and persistent directory size
 * update in place.
 *
 * ### Creating a Workstation
 * **Example:** Generated name
 * ```typescript
 * const workstation =
 *   yield* GCP.Workstations.WorkstationClustersWorkstationConfigsWorkstation(
 *     "Mine",
 *     { workstationConfig: config.name },
 *   );
 * ```
 *
 * **Example:** Explicit id and labels
 * ```typescript
 * const workstation =
 *   yield* GCP.Workstations.WorkstationClustersWorkstationConfigsWorkstation(
 *     "Mine",
 *     {
 *       workstationConfig: config.name,
 *       displayName: "alice-dev",
 *       labels: { env: "prod" },
 *     },
 *   );
 * ```
 *
 * ### Updating a Workstation
 * **Example:** Display name and env
 * ```typescript
 * // Same logical id, changed props: the engine updates it in place.
 * const workstation =
 *   yield* GCP.Workstations.WorkstationClustersWorkstationConfigsWorkstation(
 *     "Mine",
 *     {
 *       workstationConfig: config.name,
 *       displayName: "alice-dev v2",
 *       env: { EDITOR: "vim" },
 *     },
 *   );
 * ```
 *
 * @resource
 * @category Workstations
 */
export const WorkstationClustersWorkstationConfigsWorkstation =
  Resource<WorkstationClustersWorkstationConfigsWorkstation>(
    "GCP.Workstations.WorkstationClustersWorkstationConfigsWorkstation",
  );

const resourceName = (config: string, workstationId: string) =>
  `${config}/workstations/${workstationId}`;

const clusterOfConfig = (config: string) => {
  const parsed = parseName(config, "workstationConfigs", "");
  return parsed.parent;
};

const expandConfig = (
  value: string,
  project: string,
  location: string,
  cluster: string | undefined,
) => {
  if (value.includes("/")) return value.replace(/\/+$/, "");
  const clusterName = expandParent(
    cluster ?? "",
    project,
    location,
    "workstationClusters",
  );
  return `${clusterName}/workstationConfigs/${value}`;
};

const toPersistent = (
  value:
    | workstations.WorkstationPersistentDirectory
    | WorkstationPersistentDirectory,
): WorkstationPersistentDirectory => ({
  mountPath: value.mountPath,
  sizeGb: value.sizeGb,
});

const toRuntimeHost = (
  value: workstations.RuntimeHost | undefined,
): RuntimeHost | undefined =>
  value === undefined
    ? undefined
    : {
        gceInstanceHost: value.gceInstanceHost
          ? {
              id: value.gceInstanceHost.id,
              name: value.gceInstanceHost.name,
              zone: value.gceInstanceHost.zone,
            }
          : undefined,
      };

const toAttrs = (
  item: workstations.Workstation,
  project: string,
  region: string,
) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "workstations", region);
  const workstationConfig = parsed.parent;
  return {
    name,
    workstationId: parsed.id,
    workstationConfig,
    workstationCluster: clusterOfConfig(workstationConfig),
    project: parsed.project || project,
    location: parsed.location,
    displayName: item.displayName,
    labels: userLabels(item.labels),
    annotations: stringMap(item.annotations) ?? {},
    env: stringMap(item.env) ?? {},
    persistentDirectories: item.persistentDirectories?.map(toPersistent),
    sourceWorkstation: item.sourceWorkstation,
    state: item.state,
    host: item.host,
    runtimeHost: toRuntimeHost(item.runtimeHost),
    kmsKey: item.kmsKey,
    reconciling: item.reconciling === true,
    startTime: item.startTime,
    uid: item.uid,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  workstations
    .getProjectsLocationsWorkstationClustersWorkstationConfigsWorkstations({
      name,
    })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, region: string) =>
  listAtNested(
    project,
    region,
    "workstationClusters/-/workstationConfigs/-",
    (parent) =>
      listLabeledPages(
        workstations.listProjectsLocationsWorkstationClustersWorkstationConfigsWorkstations.pages(
          {
            parent,
            pageSize: 1000,
          },
        ),
        (page) => page.workstations,
        (item) => item.labels,
      ),
  );

export const WorkstationClustersWorkstationConfigsWorkstationProvider = () =>
  Provider.succeed(WorkstationClustersWorkstationConfigsWorkstation, {
    stables: [
      "name",
      "workstationId",
      "workstationConfig",
      "workstationCluster",
      "project",
      "location",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousSource =
        olds?.sourceWorkstation ?? output?.sourceWorkstation;
      return replaceOnIdentity({
        previousId: olds?.workstationId ?? output?.workstationId,
        nextId:
          news.workstationId ?? olds?.workstationId ?? output?.workstationId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        previousParent: olds?.workstationConfig ?? output?.workstationConfig,
        nextParent: news.workstationConfig,
        extra:
          previousSource !== undefined &&
          news.sourceWorkstation !== undefined &&
          previousSource !== news.sourceWorkstation,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = olds?.workstationConfig ?? output?.workstationConfig;
      // A workstation cannot exist before its config's name resolved.
      if (output?.name === undefined && !parent) return undefined;
      const workstationId = yield* toPhysicalId(
        id,
        olds?.workstationId,
        output?.workstationId,
        "station",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const config = expandConfig(
        parent ?? "",
        env.project,
        location,
        olds?.workstationCluster ?? output?.workstationCluster,
      );
      const name = output?.name ?? resourceName(config, workstationId);
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
      const workstationId = yield* toPhysicalId(
        id,
        news.workstationId,
        output?.workstationId,
        "station",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const config = expandConfig(
        news.workstationConfig,
        env.project,
        location,
        news.workstationCluster,
      );
      const name = resourceName(config, workstationId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredAnnotations = stringMap(news.annotations);
      const desiredEnv = stringMap(news.env);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* workstations
          .createProjectsLocationsWorkstationClustersWorkstationConfigsWorkstations(
            {
              parent: config,
              workstationId,
              body: {
                displayName: news.displayName,
                labels: desiredLabels,
                annotations: desiredAnnotations,
                env: desiredEnv,
                persistentDirectories: news.persistentDirectories,
                sourceWorkstation: news.sourceWorkstation,
              },
            },
          )
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          // ALREADY_EXISTS (6): a concurrent create won the race.
          yield* waitForOperation(created).pipe(
            Effect.catchTag("GCP.OperationFailed", (error) =>
              error.code === 6 ? Effect.void : Effect.fail(error),
            ),
          );
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const mask = fieldMask([
        (upsert.length > 0 || removed.length > 0) && "labels",
        !sameText(current.displayName, news.displayName) && "displayName",
        fingerprint(stringMap(current.annotations)) !==
          fingerprint(desiredAnnotations) && "annotations",
        fingerprint(stringMap(current.env)) !== fingerprint(desiredEnv) &&
          "env",
        news.persistentDirectories !== undefined &&
          fingerprint(current.persistentDirectories?.map(toPersistent)) !==
            fingerprint(news.persistentDirectories.map(toPersistent)) &&
          "persistentDirectories",
      ]);

      if (mask.length > 0) {
        const operation = yield* workstations
          .patchProjectsLocationsWorkstationClustersWorkstationConfigsWorkstations(
            {
              name: current.name ?? name,
              updateMask: mask,
              body: {
                etag: current.etag,
                labels: desiredLabels,
                displayName: news.displayName,
                annotations: desiredAnnotations,
                env: desiredEnv,
                persistentDirectories: news.persistentDirectories,
              },
            },
          )
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 8,
              schedule: Schedule.spaced("2 seconds"),
            }),
          );
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* workstations
        .deleteProjectsLocationsWorkstationClustersWorkstationConfigsWorkstations(
          { name: output.name },
        )
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        // NOT_FOUND (5): already gone.
        yield* waitForOperation(operation).pipe(
          Effect.catchTag("GCP.OperationFailed", (error) =>
            error.code === 5 ? Effect.void : Effect.fail(error),
          ),
        );
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
