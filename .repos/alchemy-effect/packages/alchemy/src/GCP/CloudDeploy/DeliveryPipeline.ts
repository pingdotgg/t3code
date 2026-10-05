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
  fieldMask,
  fingerprint,
  listAtLocation,
  listLabeledPages,
  normalizeLocation,
  parentOf,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  sameBool,
  sameText,
  stringMap,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type Stage = {
  /**
   * Target id this stage points at (the last segment of a Target name).
   */
  targetId?: string;
  /**
   * Skaffold profiles used when rendering this stage's Target.
   */
  profiles?: string[];
  /**
   * Rollout strategy for this stage (`standard` or `canary`).
   */
  strategy?: clouddeploy.Strategy;
  /**
   * Deploy parameters applied to the target in this stage.
   */
  deployParameters?: clouddeploy.DeployParameters[];
};

export type SerialPipeline = {
  /**
   * Ordered stages. The list order is the promotion flow.
   */
  stages?: Stage[];
};

export type PipelineCondition = {
  /** Whether referenced targets exist. */
  targetsPresentCondition?: clouddeploy.TargetsPresentCondition;
  /** Whether the pipeline's target types are compatible. */
  targetsTypeCondition?: clouddeploy.TargetsTypeCondition;
  /** Whether the pipeline is ready. */
  pipelineReadyCondition?: clouddeploy.PipelineReadyCondition;
};

export type DeliveryPipelineProps = {
  /**
   * Delivery pipeline id (the `{deliveryPipeline}` segment of
   * `projects/{project}/locations/{location}/deliveryPipelines/{deliveryPipeline}`).
   * If omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Immutable — changing it replaces the pipeline.
   */
  deliveryPipelineId?: string;
  /**
   * Region (`us-central1`, `us-east1`, …). Immutable — changing it
   * replaces the pipeline. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Sequential stages this pipeline promotes through.
   */
  serialPipeline?: SerialPipeline;
  /**
   * Human-readable description. Max length 255 characters.
   */
  description?: string;
  /**
   * When true, no new releases or rollouts can be created. In-progress
   * ones still complete.
   * @default false
   */
  suspended?: boolean;
  /**
   * User annotations (not used by Cloud Deploy).
   */
  annotations?: Record<string, string>;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type DeliveryPipeline = Resource<
  "GCP.CloudDeploy.DeliveryPipeline",
  DeliveryPipelineProps,
  {
    /** Full resource name. */
    name: string;
    /** Delivery pipeline id (last path segment). */
    deliveryPipelineId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Sequential pipeline configuration. */
    serialPipeline: SerialPipeline | undefined;
    /** Human-readable description. */
    description: string | undefined;
    /** Whether the pipeline is suspended. */
    suspended: boolean;
    /** Server-reported pipeline condition. */
    condition: PipelineCondition | undefined;
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
 * A Cloud Deploy delivery pipeline — the ordered stages a Skaffold
 * configuration progresses through.
 *
 * Changing `deliveryPipelineId` or `location` replaces the pipeline.
 * `serialPipeline`, description, labels, annotations, and `suspended`
 * update in place.
 *
 * ### Creating a Delivery Pipeline
 * **Example:** Generated name
 * ```typescript
 * const pipeline = yield* GCP.CloudDeploy.DeliveryPipeline("App", {
 *   serialPipeline: { stages: [{ targetId: "prod" }] },
 * });
 * ```
 *
 * **Example:** Explicit id and labels
 * ```typescript
 * const pipeline = yield* GCP.CloudDeploy.DeliveryPipeline("App", {
 *   deliveryPipelineId: "app-pipeline",
 *   serialPipeline: {
 *     stages: [
 *       { targetId: "staging" },
 *       { targetId: "prod" },
 *     ],
 *   },
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Delivery Pipeline
 * Re-declare the same logical id with changed props; the engine keeps the
 * physical resource and updates it in place.
 *
 * **Example:** Description, suspend, and labels
 * ```typescript
 * const pipeline = yield* GCP.CloudDeploy.DeliveryPipeline("App", {
 *   serialPipeline: { stages: [{ targetId: "prod" }] },
 *   description: "app pipeline v2",
 *   suspended: true,
 *   labels: { env: "prod", team: "platform" },
 * });
 * ```
 *
 * @resource
 * @category CloudDeploy
 */
export const DeliveryPipeline = Resource<DeliveryPipeline>(
  "GCP.CloudDeploy.DeliveryPipeline",
);

const resourceName = (
  project: string,
  location: string,
  deliveryPipelineId: string,
) =>
  `projects/${project}/locations/${location}/deliveryPipelines/${deliveryPipelineId}`;

const toSerialPipeline = (
  value: clouddeploy.SerialPipeline | undefined,
): SerialPipeline | undefined =>
  value === undefined
    ? undefined
    : {
        stages: value.stages?.map((stage) => ({
          targetId: stage.targetId,
          profiles: stage.profiles,
          strategy: stage.strategy,
          deployParameters: stage.deployParameters,
        })),
      };

const toCondition = (
  value: clouddeploy.PipelineCondition | undefined,
): PipelineCondition | undefined =>
  value === undefined
    ? undefined
    : {
        targetsPresentCondition: value.targetsPresentCondition,
        targetsTypeCondition: value.targetsTypeCondition,
        pipelineReadyCondition: value.pipelineReadyCondition,
      };

const toAttrs = (item: clouddeploy.DeliveryPipeline, project: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "deliveryPipelines");
  return {
    name,
    deliveryPipelineId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    serialPipeline: toSerialPipeline(item.serialPipeline),
    description: item.description,
    suspended: item.suspended === true,
    condition: toCondition(item.condition),
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
    .getProjectsLocationsDeliveryPipelines({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, region: string) =>
  listAtLocation(project, region, (parent) =>
    listLabeledPages(
      clouddeploy.listProjectsLocationsDeliveryPipelines.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.deliveryPipelines,
      (item) => item.labels,
    ),
  );

export const DeliveryPipelineProvider = () =>
  Provider.succeed(DeliveryPipeline, {
    stables: [
      "name",
      "deliveryPipelineId",
      "project",
      "location",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousId: olds?.deliveryPipelineId ?? output?.deliveryPipelineId,
        nextId:
          news.deliveryPipelineId ??
          olds?.deliveryPipelineId ??
          output?.deliveryPipelineId,
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
      const deliveryPipelineId = yield* toPhysicalId(
        id,
        olds?.deliveryPipelineId,
        output?.deliveryPipelineId,
        "deliverypipeline",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, deliveryPipelineId);
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
      const deliveryPipelineId = yield* toPhysicalId(
        id,
        news.deliveryPipelineId,
        output?.deliveryPipelineId,
        "deliverypipeline",
      );
      const location = normalizeLocation(
        news.location ?? output?.location ?? env.region,
      );
      const name = resourceName(env.project, location, deliveryPipelineId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredAnnotations = news.annotations ?? {};
      const desiredSuspended = news.suspended === true;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* clouddeploy
          .createProjectsLocationsDeliveryPipelines({
            parent: parentOf(env.project, location),
            deliveryPipelineId,
            body: {
              description: news.description,
              serialPipeline: news.serialPipeline,
              suspended: desiredSuspended,
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
        !sameBool(current.suspended, desiredSuspended) && "suspended",
        fingerprint(toSerialPipeline(current.serialPipeline)) !==
          fingerprint(news.serialPipeline) && "serialPipeline",
      ]);

      if (mask.length > 0) {
        const operation =
          yield* clouddeploy.patchProjectsLocationsDeliveryPipelines({
            name: current.name ?? name,
            updateMask: mask,
            body: {
              etag: current.etag,
              description: news.description,
              serialPipeline: news.serialPipeline,
              suspended: desiredSuspended,
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
        .deleteProjectsLocationsDeliveryPipelines({
          name: output.name,
          force: true,
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
