import * as clouddeploy from "@distilled.cloud/gcp/clouddeploy_v1";
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
  gkeClusterName,
  listAtLocation,
  listLabeledPages,
  membershipName,
  normalizeLocation,
  parentOf,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  runLocationName,
  sameBool,
  sameText,
  stringMap,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type GkeCluster = {
  /**
   * GKE cluster resource name
   * `projects/{project}/locations/{location}/clusters/{cluster}` or the
   * cluster id.
   */
  cluster?: string;
  /**
   * Access the cluster using the DNS endpoint. Cannot be combined with
   * `internalIp`.
   */
  dnsEndpoint?: boolean;
  /**
   * Access a private cluster using the private control-plane IP.
   */
  internalIp?: boolean;
  /**
   * Optional HTTP proxy URL for the Kubernetes API server.
   */
  proxyUrl?: string;
};

export type AnthosCluster = {
  /**
   * GKE Hub membership
   * `projects/{project}/locations/{location}/memberships/{membership}`
   * or the membership id.
   */
  membership?: string;
};

export type CloudRunLocation = {
  /**
   * Cloud Run location
   * `projects/{project}/locations/{location}` or a location id.
   */
  location?: string;
};

export type CustomTarget = {
  /**
   * Custom target type resource name
   * `projects/{project}/locations/{location}/customTargetTypes/{customTargetType}`
   * or the type id.
   */
  customTargetType?: string;
};

export type MultiTarget = {
  /** Child target ids. */
  targetIds?: string[];
};

export type DefaultPool = {
  /** Cloud Storage location for execution outputs. */
  artifactStorage?: string;
  /** Service account used for execution. */
  serviceAccount?: string;
};

export type PrivatePool = {
  /**
   * Cloud Build worker pool
   * `projects/{project}/locations/{location}/workerPools/{pool}`.
   */
  workerPool?: string;
  /** Cloud Storage location for execution outputs. */
  artifactStorage?: string;
  /** Service account used for execution. */
  serviceAccount?: string;
};

export type ExecutionConfig = {
  /**
   * Usages this configuration applies to (`RENDER`, `DEPLOY`, `VERIFY`,
   * `PREDEPLOY`, `POSTDEPLOY`, `ANALYSIS`).
   */
  usages?: Array<clouddeploy.ExecutionConfigUsagesItemEnum | (string & {})>;
  /** Cloud Build execution timeout (10m–24h, seconds format). */
  executionTimeout?: string;
  /** Default Cloud Build pool. */
  defaultPool?: DefaultPool;
  /**
   * Worker pool resource name. If omitted, the default Cloud Build pool
   * is used.
   */
  workerPool?: string;
  /** Cloud Storage location for execution outputs. */
  artifactStorage?: string;
  /** Private Cloud Build pool. */
  privatePool?: PrivatePool;
  /** Extra logging when running builds. */
  verbose?: boolean;
  /** Service account used for execution. */
  serviceAccount?: string;
};

export type TargetProps = {
  /**
   * Target id (the `{target}` segment of
   * `projects/{project}/locations/{location}/targets/{target}`). If
   * omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Immutable — changing it replaces the target.
   */
  targetId?: string;
  /**
   * Region (`us-central1`, `us-east1`, …). Immutable — changing it
   * replaces the target. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * GKE cluster destination. Mutually exclusive with `run`,
   * `anthosCluster`, `customTarget`, and `multiTarget`.
   */
  gke?: GkeCluster;
  /**
   * Cloud Run destination. Mutually exclusive with the other destination
   * fields.
   */
  run?: CloudRunLocation;
  /**
   * Anthos / GKE Hub membership destination. Mutually exclusive with the
   * other destination fields.
   */
  anthosCluster?: AnthosCluster;
  /**
   * Custom target destination. Mutually exclusive with the other
   * destination fields.
   */
  customTarget?: CustomTarget;
  /**
   * Multi-target grouping child targets. Mutually exclusive with the
   * other destination fields.
   */
  multiTarget?: MultiTarget;
  /**
   * Whether rollouts to this target require approval.
   * @default false
   */
  requireApproval?: boolean;
  /**
   * Execution environments for render/deploy (and optional verify).
   */
  executionConfigs?: ExecutionConfig[];
  /**
   * Deploy parameters for this target.
   */
  deployParameters?: Record<string, string>;
  /**
   * Associated entities keyed by entity id (Gateway API canary, …).
   */
  associatedEntities?: clouddeploy.AssociatedEntitiesMap;
  /**
   * Human-readable description. Max length 255 characters.
   */
  description?: string;
  /**
   * User annotations (not used by Cloud Deploy).
   */
  annotations?: Record<string, string>;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type Target = Resource<
  "GCP.CloudDeploy.Target",
  TargetProps,
  {
    /** Full resource name. */
    name: string;
    /** Target id (last path segment). */
    targetId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** GKE destination, if configured. */
    gke: GkeCluster | undefined;
    /** Cloud Run destination, if configured. */
    run: CloudRunLocation | undefined;
    /** Anthos destination, if configured. */
    anthosCluster: AnthosCluster | undefined;
    /** Custom target destination, if configured. */
    customTarget: CustomTarget | undefined;
    /** Multi-target grouping, if configured. */
    multiTarget: MultiTarget | undefined;
    /** Whether rollouts require approval. */
    requireApproval: boolean;
    /** Execution environment configurations. */
    executionConfigs: ExecutionConfig[] | undefined;
    /** Deploy parameters. */
    deployParameters: Record<string, string>;
    /** Associated entities. */
    associatedEntities: clouddeploy.AssociatedEntitiesMap | undefined;
    /** Human-readable description. */
    description: string | undefined;
    /** User annotations. */
    annotations: Record<string, string>;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-generated resource uid. */
    uid: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** Server-computed etag. */
    etag: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Deploy target — a location a Skaffold configuration can be
 * deployed to (GKE, Cloud Run, Anthos, a custom target type, or a
 * multi-target).
 *
 * Changing `targetId` or `location` replaces the target. Destination,
 * approval, execution configs, description, labels, and annotations
 * update in place.
 *
 * ### Creating a Target
 * **Example:** Cloud Run
 * ```typescript
 * const target = yield* GCP.CloudDeploy.Target("Prod", {
 *   run: { location: "projects/my-project/locations/us-central1" },
 * });
 * ```
 *
 * **Example:** GKE cluster
 * ```typescript
 * const target = yield* GCP.CloudDeploy.Target("Prod", {
 *   gke: {
 *     cluster: "projects/my-project/locations/us-central1/clusters/app",
 *   },
 *   requireApproval: true,
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Target
 * Re-declare the same logical id with changed props; the engine keeps the
 * physical resource and updates it in place.
 *
 * **Example:** Description and labels
 * ```typescript
 * const target = yield* GCP.CloudDeploy.Target("Prod", {
 *   run: { location: "projects/my-project/locations/us-central1" },
 *   description: "prod run target v2",
 *   labels: { env: "prod", team: "platform" },
 * });
 * ```
 *
 * @resource
 * @category CloudDeploy
 */
export const Target = Resource<Target>("GCP.CloudDeploy.Target");

const resourceName = (project: string, location: string, targetId: string) =>
  `projects/${project}/locations/${location}/targets/${targetId}`;

const desiredDestination = (
  news: TargetProps,
  project: string,
  location: string,
) => {
  const gke =
    news.gke === undefined
      ? undefined
      : {
          ...news.gke,
          cluster:
            news.gke.cluster === undefined
              ? undefined
              : gkeClusterName(news.gke.cluster, project, location),
        };
  const run =
    news.run === undefined
      ? undefined
      : {
          location:
            news.run.location === undefined
              ? undefined
              : runLocationName(news.run.location, project, location),
        };
  const anthosCluster =
    news.anthosCluster === undefined
      ? undefined
      : {
          membership:
            news.anthosCluster.membership === undefined
              ? undefined
              : membershipName(
                  news.anthosCluster.membership,
                  project,
                  location,
                ),
        };
  const customTarget =
    news.customTarget === undefined
      ? undefined
      : {
          customTargetType:
            news.customTarget.customTargetType === undefined
              ? undefined
              : expandParent(
                  news.customTarget.customTargetType,
                  project,
                  location,
                  "customTargetTypes",
                ),
        };
  return {
    gke,
    run,
    anthosCluster,
    customTarget,
    multiTarget: news.multiTarget,
  };
};

const toGke = (
  value: clouddeploy.GkeCluster | undefined,
): GkeCluster | undefined =>
  value === undefined
    ? undefined
    : {
        cluster: value.cluster,
        dnsEndpoint: value.dnsEndpoint,
        internalIp: value.internalIp,
        proxyUrl: value.proxyUrl,
      };

const toRun = (
  value: clouddeploy.CloudRunLocation | undefined,
): CloudRunLocation | undefined =>
  value === undefined ? undefined : { location: value.location };

const toAnthos = (
  value: clouddeploy.AnthosCluster | undefined,
): AnthosCluster | undefined =>
  value === undefined ? undefined : { membership: value.membership };

const toCustom = (
  value: clouddeploy.CustomTarget | undefined,
): CustomTarget | undefined =>
  value === undefined
    ? undefined
    : { customTargetType: value.customTargetType };

const toMulti = (
  value: clouddeploy.MultiTarget | undefined,
): MultiTarget | undefined =>
  value === undefined ? undefined : { targetIds: value.targetIds };

const toExecutionConfigs = (
  value: clouddeploy.ExecutionConfigList | undefined,
): ExecutionConfig[] | undefined =>
  value === undefined
    ? undefined
    : value.map((config) => ({
        usages: config.usages,
        executionTimeout: config.executionTimeout,
        defaultPool: config.defaultPool,
        workerPool: config.workerPool,
        artifactStorage: config.artifactStorage,
        privatePool: config.privatePool,
        verbose: config.verbose,
        serviceAccount: config.serviceAccount,
      }));

const toAttrs = (item: clouddeploy.Target, project: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "targets");
  return {
    name,
    targetId: item.targetId ?? parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    gke: toGke(item.gke),
    run: toRun(item.run),
    anthosCluster: toAnthos(item.anthosCluster),
    customTarget: toCustom(item.customTarget),
    multiTarget: toMulti(item.multiTarget),
    requireApproval: item.requireApproval === true,
    executionConfigs: toExecutionConfigs(item.executionConfigs),
    deployParameters: stringMap(item.deployParameters),
    associatedEntities: item.associatedEntities,
    description: item.description,
    annotations: stringMap(item.annotations),
    labels: userLabels(item.labels),
    uid: item.uid,
    createTime: item.createTime,
    updateTime: item.updateTime,
    etag: item.etag,
  };
};

const getByName = (name: string) =>
  clouddeploy
    .getProjectsLocationsTargets({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, region: string) =>
  listAtLocation(project, region, (parent) =>
    listLabeledPages(
      clouddeploy.listProjectsLocationsTargets.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.targets,
      (item) => item.labels,
    ),
  );

export const TargetProvider = () =>
  Provider.succeed(Target, {
    stables: ["name", "targetId", "project", "location", "uid", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousId: olds?.targetId ?? output?.targetId,
        nextId: news.targetId ?? olds?.targetId ?? output?.targetId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location ?? env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location ?? env.region,
        ),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const targetId = yield* toPhysicalId(
        id,
        olds?.targetId,
        output?.targetId,
        "target",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, targetId);
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
        const items = yield* listOwned(env.project, env.region);
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const targetId = yield* toPhysicalId(
        id,
        news.targetId,
        output?.targetId,
        "target",
      );
      const location = normalizeLocation(
        news.location ?? output?.location ?? env.region,
      );
      const name = resourceName(env.project, location, targetId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredAnnotations = news.annotations ?? {};
      const desiredParameters = news.deployParameters ?? {};
      const desiredApproval = news.requireApproval === true;
      const destination = desiredDestination(news, env.project, location);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* clouddeploy
          .createProjectsLocationsTargets({
            parent: parentOf(env.project, location),
            targetId,
            body: {
              description: news.description,
              requireApproval: desiredApproval,
              gke: destination.gke,
              run: destination.run,
              anthosCluster: destination.anthosCluster,
              customTarget: destination.customTarget,
              multiTarget: destination.multiTarget,
              executionConfigs: news.executionConfigs,
              deployParameters: desiredParameters,
              associatedEntities: news.associatedEntities,
              annotations: desiredAnnotations,
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

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const mask = fieldMask([
        (upsert.length > 0 || removed.length > 0) && "labels",
        fingerprint(stringMap(current.annotations)) !==
          fingerprint(desiredAnnotations) && "annotations",
        !sameText(current.description, news.description) && "description",
        !sameBool(current.requireApproval, desiredApproval) &&
          "requireApproval",
        fingerprint(toGke(current.gke)) !== fingerprint(destination.gke) &&
          "gke",
        fingerprint(toRun(current.run)) !== fingerprint(destination.run) &&
          "run",
        fingerprint(toAnthos(current.anthosCluster)) !==
          fingerprint(destination.anthosCluster) && "anthosCluster",
        fingerprint(toCustom(current.customTarget)) !==
          fingerprint(destination.customTarget) && "customTarget",
        fingerprint(toMulti(current.multiTarget)) !==
          fingerprint(destination.multiTarget) && "multiTarget",
        fingerprint(toExecutionConfigs(current.executionConfigs)) !==
          fingerprint(news.executionConfigs) && "executionConfigs",
        fingerprint(stringMap(current.deployParameters)) !==
          fingerprint(desiredParameters) && "deployParameters",
        fingerprint(current.associatedEntities) !==
          fingerprint(news.associatedEntities) && "associatedEntities",
      ]);

      if (mask.length > 0) {
        const operation = yield* clouddeploy.patchProjectsLocationsTargets({
          name: current.name ?? name,
          updateMask: mask,
          body: {
            etag: current.etag,
            description: news.description,
            requireApproval: desiredApproval,
            gke: destination.gke,
            run: destination.run,
            anthosCluster: destination.anthosCluster,
            customTarget: destination.customTarget,
            multiTarget: destination.multiTarget,
            executionConfigs: news.executionConfigs,
            deployParameters: desiredParameters,
            associatedEntities: news.associatedEntities,
            annotations: desiredAnnotations,
            labels: desiredLabels,
          },
        });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* clouddeploy
        .deleteProjectsLocationsTargets({
          name: output.name,
          allowMissing: true,
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
