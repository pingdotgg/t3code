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
  getModel,
  lastSegment,
  listOwnedModels,
  listVersions,
  modelOwnedByAlchemy,
  modelResourceName,
  normalizeRegions,
  parseModelName,
  parseOwnership,
  replaceOnIdentity,
  ResourceNotResolved,
  sameStringList,
  sameText,
  toPhysicalId,
  userLabels,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";
import { waitForOperation } from "./operations.ts";

export type ModelProps = {
  /**
   * Model id (the `{model}` segment of `projects/{project}/models/{model}`).
   * If omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Immutable — changing it replaces the model.
   */
  modelId?: string;
  /**
   * Human-readable description. Patch supports this field. Alchemy also
   * stamps an `[alchemy …]` ownership prefix here (labels are not
   * updatable on existing models) and strips it from attributes.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically
   * on create. The patch API does not update labels.
   */
  labels?: Record<string, string>;
  /**
   * Regions where the model is deployed. Only one region is supported.
   * Immutable — changing it replaces the model.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  regions?: string[];
  /**
   * Send online-prediction access logs to Cloud Logging. Immutable —
   * changing it replaces the model.
   * @default false
   */
  onlinePredictionLogging?: boolean;
  /**
   * Send online-prediction stdout/stderr to Cloud Logging. Immutable —
   * changing it replaces the model.
   * @default false
   */
  onlinePredictionConsoleLogging?: boolean;
  /**
   * Default version id used when a predict request omits the version.
   * Patchable as `defaultVersion.name`. The first created version becomes
   * the default automatically.
   */
  defaultVersion?: string;
};

export type Model = Resource<
  "GCP.ML.Model",
  ModelProps,
  {
    /** Full resource name `projects/{project}/models/{model}`. */
    name: string;
    /** Model id (last path segment). */
    modelId: string;
    /** Project id. */
    project: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Deployment regions. */
    regions: string[];
    /** Whether online-prediction access logs are enabled. */
    onlinePredictionLogging: boolean;
    /** Whether online-prediction console logs are enabled. */
    onlinePredictionConsoleLogging: boolean;
    /** Default version resource name, if any. */
    defaultVersion: string | undefined;
    /** Optimistic-concurrency etag. */
    etag: string | undefined;
  },
  never,
  Providers
>;

/**
 * An AI Platform (legacy ML Engine) model — a named container for
 * deployed {@link ModelsVersion}s.
 *
 * Labels are set at create time but are not patchable, so Alchemy also
 * stamps ownership into `description` for `list` / nuke. Model id,
 * regions, and logging flags are identity. Description and the default
 * version update in place.
 *
 * The AI Platform Training and Prediction API (`ml.googleapis.com`)
 * must be enabled. Create of a model is metadata-only; serving traffic
 * requires at least one version.
 *
 * ### Creating a Model
 * **Example:** Generated name
 * ```typescript
 * const model = yield* GCP.ML.Model("Classifier", {
 *   description: "image classifier",
 * });
 * ```
 *
 * **Example:** Explicit id, region, and labels
 * ```typescript
 * const model = yield* GCP.ML.Model("Classifier", {
 *   modelId: "image-classifier",
 *   regions: ["us-central1"],
 *   labels: { env: "prod" },
 *   onlinePredictionLogging: true,
 * });
 * ```
 *
 * ### Updating a Model
 * **Example:** Change the description
 * ```typescript
 * const model = yield* GCP.ML.Model("Classifier", {
 *   description: "image classifier v2",
 * });
 * ```
 *
 * @resource
 * @category ML
 */
export const Model = Resource<Model>("GCP.ML.Model");

export { ResourceNotResolved as ModelNotResolved };

const toAttrs = (model: ml.GoogleCloudMlV1__Model, project: string) => {
  const name = model.name ?? "";
  const parsed = parseModelName(name, project);
  return {
    name,
    modelId: parsed.modelId,
    project: parsed.project || project,
    description: parseOwnership(model.description).text,
    labels: userLabels(model.labels),
    regions: normalizeRegions(model.regions, []),
    onlinePredictionLogging: model.onlinePredictionLogging === true,
    onlinePredictionConsoleLogging:
      model.onlinePredictionConsoleLogging === true,
    defaultVersion: model.defaultVersion?.name,
    etag: model.etag,
  };
};

const desiredDefaultVersion = (value: string | undefined) =>
  value === undefined || value.length === 0 ? undefined : lastSegment(value);

const deleteVersions = (parent: string) =>
  Effect.gen(function* () {
    const versions = yield* listVersions(parent);
    const ordered = [
      ...versions.filter((version) => version.isDefault !== true),
      ...versions.filter((version) => version.isDefault === true),
    ];
    yield* Effect.forEach(
      ordered,
      (version) =>
        version.name
          ? ml.deleteProjectsModelsVersions({ name: version.name }).pipe(
              Effect.flatMap((operation) =>
                waitForOperation(operation, { notFoundOk: true }),
              ),
              Effect.catchTag("NotFound", () => Effect.void),
            )
          : Effect.void,
      { concurrency: 1 },
    );
  });

export const ModelProvider = () =>
  Provider.succeed(Model, {
    stables: ["name", "modelId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousRegions = normalizeRegions(
        olds?.regions ?? output?.regions,
        [env.region],
      );
      const nextRegions = normalizeRegions(
        news.regions ?? olds?.regions ?? output?.regions,
        [env.region],
      );
      const previousLogging =
        olds?.onlinePredictionLogging ??
        output?.onlinePredictionLogging ??
        false;
      const nextLogging = news.onlinePredictionLogging ?? previousLogging;
      const previousConsole =
        olds?.onlinePredictionConsoleLogging ??
        output?.onlinePredictionConsoleLogging ??
        false;
      const nextConsole =
        news.onlinePredictionConsoleLogging ?? previousConsole;
      return replaceOnIdentity({
        previousId: olds?.modelId ?? output?.modelId,
        nextId: news.modelId ?? olds?.modelId ?? output?.modelId,
        extra:
          !sameStringList(previousRegions, nextRegions) ||
          previousLogging !== nextLogging ||
          previousConsole !== nextConsole,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const modelId = yield* toPhysicalId(
        id,
        olds?.modelId,
        output?.modelId,
        "model",
      );
      const name = output?.name ?? modelResourceName(env.project, modelId);
      const existing = yield* getModel(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* modelOwnedByAlchemy(id, existing))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const models = yield* listOwnedModels(env.project);
        return models.map((model) => toAttrs(model, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const modelId = yield* toPhysicalId(
        id,
        news.modelId,
        output?.modelId,
        "model",
      );
      const name = modelResourceName(env.project, modelId);
      const ownership = yield* createInternalLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...ownership,
      };
      const regions = normalizeRegions(news.regions ?? output?.regions, [
        env.region,
      ]);
      const onlinePredictionLogging = news.onlinePredictionLogging === true;
      const onlinePredictionConsoleLogging =
        news.onlinePredictionConsoleLogging === true;
      const defaultVersion = desiredDefaultVersion(news.defaultVersion);

      let current = yield* getModel(output?.name ?? name);

      if (current === undefined) {
        yield* ml
          .createProjectsModels({
            parent: `projects/${env.project}`,
            body: {
              name: modelId,
              description,
              labels: desiredLabels,
              regions,
              onlinePredictionLogging,
              onlinePredictionConsoleLogging,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.void));
        current = yield* waitUntilExists(getModel(name), name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const descriptionChanged = !sameText(current.description, description);
      const observedDefault = desiredDefaultVersion(
        current.defaultVersion?.name,
      );
      const defaultChanged =
        defaultVersion !== undefined && observedDefault !== defaultVersion;
      const mask = fieldMask([
        descriptionChanged && "description",
        defaultChanged && "default_version.name",
      ]);

      if (mask.length > 0) {
        const operation = yield* ml.patchProjectsModels({
          name: currentName,
          updateMask: mask,
          body: {
            name: currentName,
            description,
            defaultVersion:
              defaultVersion !== undefined
                ? {
                    name: defaultVersion.includes("/")
                      ? defaultVersion
                      : defaultVersion,
                  }
                : undefined,
          },
        });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(getModel(currentName), currentName);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const name = output.name;
      if (!name) return;
      yield* Effect.gen(function* () {
        yield* deleteVersions(name);
        const operation = yield* ml
          .deleteProjectsModels({ name })
          .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
        if (operation !== undefined) {
          yield* waitForOperation(operation, { notFoundOk: true });
        }
      }).pipe(
        Effect.retry({
          while: (error) =>
            error._tag === "Conflict" || error._tag === "BadRequest",
          times: 8,
          schedule: Schedule.spaced("2 seconds"),
        }),
      );
      yield* waitUntilGone(getModel(name), name);
    }),
  });

export const modelNameOf = (project: string, model: string) =>
  expandModel(project, model);
