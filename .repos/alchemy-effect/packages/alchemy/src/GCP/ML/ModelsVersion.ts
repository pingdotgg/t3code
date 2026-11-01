import * as ml from "@distilled.cloud/gcp/ml_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, toLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnership,
  expandModel,
  fieldMask,
  getVersion,
  lastSegment,
  listOwnedVersions,
  parseOwnership,
  parseVersionName,
  replaceOnIdentity,
  ResourceNotResolved,
  sameText,
  toPhysicalId,
  userLabels,
  versionOwnedByAlchemy,
  versionResourceName,
  waitUntilExists,
  waitUntilGone,
  waitUntilVersionReady,
} from "./internal.ts";
import { waitForOperation } from "./operations.ts";

export type AutoScaling = ml.GoogleCloudMlV1__AutoScaling;
export type ManualScaling = ml.GoogleCloudMlV1__ManualScaling;
export type ContainerSpec = ml.GoogleCloudMlV1__ContainerSpec;
export type RequestLoggingConfig = ml.GoogleCloudMlV1__RequestLoggingConfig;
export type AcceleratorConfig = ml.GoogleCloudMlV1__AcceleratorConfig;
export type ExplanationConfig = ml.GoogleCloudMlV1__ExplanationConfig;
export type RouteMap = ml.GoogleCloudMlV1__RouteMap;
export type VersionFramework =
  | ml.GoogleCloudMlV1__VersionFrameworkEnum
  | (string & {});

export type ModelsVersionProps = {
  /**
   * Parent model. Full name `projects/{project}/models/{model}` or the
   * model id. Immutable — changing it replaces the version.
   */
  model: string;
  /**
   * Version id (the `{version}` segment of
   * `projects/{project}/models/{model}/versions/{version}`). If omitted,
   * a unique RFC1035 name is generated. Immutable — changing it
   * replaces the version.
   */
  versionId?: string;
  /**
   * Cloud Storage URI of a directory containing trained model artifacts
   * (`gs://bucket/path`). Required unless `container` is set. Immutable.
   */
  deploymentUri?: string;
  /**
   * AI Platform runtime version (for example `"2.11"`). Immutable.
   */
  runtimeVersion?: string;
  /**
   * Python version used in prediction (`"3.7"`, `"3.5"`, `"2.7"`).
   * Immutable.
   */
  pythonVersion?: string;
  /**
   * Framework: `TENSORFLOW`, `SCIKIT_LEARN`, or `XGBOOST`. Immutable.
   */
  framework?: VersionFramework;
  /**
   * Machine type for online prediction (for example `mls1-c1-m2` or
   * `n1-standard-2`). Immutable.
   */
  machineType?: string;
  /**
   * Human-readable description. Patchable. Alchemy stamps an
   * `[alchemy …]` ownership prefix here and strips it from attributes.
   */
  description?: string;
  /**
   * User labels. Merged with Alchemy ownership labels on create. The
   * patch API does not update labels.
   */
  labels?: Record<string, string>;
  /**
   * Automatic node scaling. `minNodes` is patchable.
   */
  autoScaling?: AutoScaling;
  /**
   * Fixed node count. `nodes` is patchable on Compute Engine machine
   * types.
   */
  manualScaling?: ManualScaling;
  /**
   * Custom serving container. Immutable. When set, `deploymentUri` is
   * optional and `runtimeVersion` must be omitted.
   */
  container?: ContainerSpec;
  /**
   * Custom prediction-routine packages (`gs://…`). Immutable.
   */
  packageUris?: string[];
  /**
   * Fully qualified Predictor class (`module.Class`). Immutable.
   */
  predictionClass?: string;
  /**
   * Service account for resource access control. Immutable.
   */
  serviceAccount?: string;
  /**
   * GPU accelerator for N1 machine types. Immutable.
   */
  acceleratorConfig?: AcceleratorConfig;
  /**
   * Explainability configuration. Immutable.
   */
  explanationConfig?: ExplanationConfig;
  /**
   * Custom container HTTP routes. Immutable.
   */
  routes?: RouteMap;
  /**
   * Request-response pair logging to BigQuery. Patchable.
   */
  requestLoggingConfig?: RequestLoggingConfig;
  /**
   * When true, this version handles predict requests that omit a
   * version. The first version of a model is default automatically;
   * later versions call `versions.setDefault`.
   */
  isDefault?: boolean;
};

export type ModelsVersion = Resource<
  "GCP.ML.ModelsVersion",
  ModelsVersionProps,
  {
    /** Full resource name `projects/{project}/models/{model}/versions/{version}`. */
    name: string;
    /** Version id (last path segment). */
    versionId: string;
    /** Parent model resource name. */
    model: string;
    /** Parent model id. */
    modelId: string;
    /** Project id. */
    project: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Model-artifact Cloud Storage URI. */
    deploymentUri: string | undefined;
    /** Runtime version. */
    runtimeVersion: string | undefined;
    /** Python version. */
    pythonVersion: string | undefined;
    /** Framework. */
    framework: string | undefined;
    /** Serving machine type. */
    machineType: string | undefined;
    /** Automatic scaling, if set. */
    autoScaling: AutoScaling | undefined;
    /** Manual scaling, if set. */
    manualScaling: ManualScaling | undefined;
    /** Whether this is the model's default version. */
    isDefault: boolean;
    /** Version state (`READY`, `CREATING`, `FAILED`, …). */
    state: string | undefined;
    /** Failure details, if the version failed. */
    errorMessage: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A deployed version of an AI Platform (legacy ML Engine)
 * {@link Model}. Each version serves online and batch predictions from
 * a Cloud Storage SavedModel (or a custom container).
 *
 * Version id, parent model, `deploymentUri`, runtime, framework, and
 * machine type are identity. Description, `autoScaling.minNodes`,
 * `manualScaling.nodes`, and `requestLoggingConfig` update in place.
 * Create and delete are long-running operations.
 *
 * ### Creating a ModelsVersion
 * **Example:** TensorFlow SavedModel
 * ```typescript
 * const model = yield* GCP.ML.Model("Classifier", {});
 * const version = yield* GCP.ML.ModelsVersion("V1", {
 *   model: model.name,
 *   deploymentUri: "gs://my-bucket/saved-model",
 *   runtimeVersion: "2.11",
 *   pythonVersion: "3.7",
 *   framework: "TENSORFLOW",
 * });
 * ```
 *
 * **Example:** Explicit version id and labels
 * ```typescript
 * const version = yield* GCP.ML.ModelsVersion("V1", {
 *   model: model.name,
 *   versionId: "v1",
 *   deploymentUri: "gs://my-bucket/saved-model",
 *   labels: { env: "prod" },
 *   autoScaling: { minNodes: 0 },
 * });
 * ```
 *
 * ### Updating a ModelsVersion
 * **Example:** Raise min nodes
 * ```typescript
 * const version = yield* GCP.ML.ModelsVersion("V1", {
 *   model: model.name,
 *   autoScaling: { minNodes: 1 },
 * });
 * ```
 *
 * @resource
 * @category ML
 */
export const ModelsVersion = Resource<ModelsVersion>("GCP.ML.ModelsVersion");

export { ResourceNotResolved as ModelsVersionNotResolved };

const toAttrs = (version: ml.GoogleCloudMlV1__Version, project: string) => {
  const name = version.name ?? "";
  const parsed = parseVersionName(name, project);
  return {
    name,
    versionId: parsed.versionId,
    model: parsed.model,
    modelId: parsed.modelId,
    project: parsed.project || project,
    description: parseOwnership(version.description).text,
    labels: userLabels(version.labels),
    deploymentUri: version.deploymentUri,
    runtimeVersion: version.runtimeVersion,
    pythonVersion: version.pythonVersion,
    framework: version.framework,
    machineType: version.machineType,
    autoScaling: version.autoScaling,
    manualScaling: version.manualScaling,
    isDefault: version.isDefault === true,
    state: version.state,
    errorMessage: version.errorMessage,
    createTime: version.createTime,
  };
};

const sameMinNodes = (
  left: AutoScaling | undefined,
  right: AutoScaling | undefined,
) => (left?.minNodes ?? undefined) === (right?.minNodes ?? undefined);

const sameManualNodes = (
  left: ManualScaling | undefined,
  right: ManualScaling | undefined,
) => (left?.nodes ?? undefined) === (right?.nodes ?? undefined);

const sameLogging = (
  left: RequestLoggingConfig | undefined,
  right: RequestLoggingConfig | undefined,
) =>
  (left?.bigqueryTableName ?? "") === (right?.bigqueryTableName ?? "") &&
  (left?.samplingPercentage ?? undefined) ===
    (right?.samplingPercentage ?? undefined);

export const ModelsVersionProvider = () =>
  Provider.succeed(ModelsVersion, {
    stables: ["name", "versionId", "model", "modelId", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousParent = expandModel(
        env.project,
        olds?.model ?? output?.model ?? "",
      );
      const nextParent = expandModel(env.project, news.model);
      return replaceOnIdentity({
        previousId: olds?.versionId ?? output?.versionId,
        nextId: news.versionId ?? olds?.versionId ?? output?.versionId,
        previousParent,
        nextParent,
        extra:
          (news.deploymentUri !== undefined &&
            (olds?.deploymentUri ?? output?.deploymentUri) !== undefined &&
            news.deploymentUri !==
              (olds?.deploymentUri ?? output?.deploymentUri)) ||
          (news.runtimeVersion !== undefined &&
            (olds?.runtimeVersion ?? output?.runtimeVersion) !== undefined &&
            news.runtimeVersion !==
              (olds?.runtimeVersion ?? output?.runtimeVersion)) ||
          (news.pythonVersion !== undefined &&
            (olds?.pythonVersion ?? output?.pythonVersion) !== undefined &&
            news.pythonVersion !==
              (olds?.pythonVersion ?? output?.pythonVersion)) ||
          (news.framework !== undefined &&
            (olds?.framework ?? output?.framework) !== undefined &&
            news.framework !== (olds?.framework ?? output?.framework)) ||
          (news.machineType !== undefined &&
            (olds?.machineType ?? output?.machineType) !== undefined &&
            news.machineType !== (olds?.machineType ?? output?.machineType)),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const versionId = yield* toPhysicalId(
        id,
        olds?.versionId,
        output?.versionId,
        "version",
      );
      const model = expandModel(
        env.project,
        olds?.model ?? output?.model ?? "",
      );
      const name =
        output?.name ??
        (model.length > 0 ? versionResourceName(model, versionId) : "");
      const existing = yield* getVersion(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* versionOwnedByAlchemy(id, existing))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const versions = yield* listOwnedVersions(env.project);
        return versions.map((version) => toAttrs(version, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const versionId = yield* toPhysicalId(
        id,
        news.versionId,
        output?.versionId,
        "version",
      );
      const model = expandModel(env.project, news.model);
      const name = versionResourceName(model, versionId);
      const ownership = yield* createInternalLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...ownership,
      };

      let current = yield* getVersion(output?.name ?? name);

      if (current === undefined) {
        const created = yield* ml
          .createProjectsModelsVersions({
            parent: model,
            body: {
              name: versionId,
              description,
              labels: desiredLabels,
              deploymentUri: news.deploymentUri,
              runtimeVersion: news.runtimeVersion,
              pythonVersion: news.pythonVersion,
              framework: news.framework,
              machineType: news.machineType,
              autoScaling: news.autoScaling,
              manualScaling: news.manualScaling,
              container: news.container,
              packageUris: news.packageUris,
              predictionClass: news.predictionClass,
              serviceAccount: news.serviceAccount,
              acceleratorConfig: news.acceleratorConfig,
              explanationConfig: news.explanationConfig,
              routes: news.routes,
              requestLoggingConfig: news.requestLoggingConfig,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilVersionReady(name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const descriptionChanged = !sameText(current.description, description);
      const minNodesChanged = !sameMinNodes(
        current.autoScaling,
        news.autoScaling,
      );
      const manualNodesChanged = !sameManualNodes(
        current.manualScaling,
        news.manualScaling,
      );
      const loggingChanged =
        news.requestLoggingConfig !== undefined &&
        !sameLogging(current.requestLoggingConfig, news.requestLoggingConfig);
      const mask = fieldMask([
        descriptionChanged && "description",
        minNodesChanged &&
          news.autoScaling !== undefined &&
          "autoScaling.minNodes",
        manualNodesChanged &&
          news.manualScaling !== undefined &&
          "manualScaling.nodes",
        loggingChanged && "requestLoggingConfig",
      ]);

      if (mask.length > 0) {
        const operation = yield* ml.patchProjectsModelsVersions({
          name: currentName,
          updateMask: mask,
          body: {
            name: currentName,
            description,
            autoScaling: news.autoScaling,
            manualScaling: news.manualScaling,
            requestLoggingConfig: news.requestLoggingConfig,
          },
        });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(getVersion(currentName), currentName);
      }

      if (news.isDefault === true && current.isDefault !== true) {
        current = yield* ml.setDefaultProjectsModelsVersions({
          name: currentName,
          body: {},
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const name = output.name;
      if (!name) return;
      const operation = yield* ml.deleteProjectsModelsVersions({ name }).pipe(
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
      yield* waitUntilGone(getVersion(name), name);
    }),
  });
