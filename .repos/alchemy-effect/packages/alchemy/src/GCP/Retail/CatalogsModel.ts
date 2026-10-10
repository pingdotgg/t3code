import * as retail from "@distilled.cloud/gcp/retail_v2";
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
  MAX_MODEL_ID_LENGTH,
  expandCatalog,
  normalizeLocation,
  parseResourceName,
  replaceOnIdentity,
  sameText,
  slugNoDigits,
  toPhysical,
  updateMaskOf,
} from "./internal.ts";
import { resourceNameFromOperation, waitForOperation } from "./operations.ts";

export type CatalogsModelProps = {
  /**
   * Parent catalog resource name
   * `projects/{project}/locations/{location}/catalogs/{catalog}` or a
   * catalog id (combined with `location`). Immutable — changing it
   * replaces the model.
   * @default "default_catalog"
   */
  catalog?: string;
  /**
   * Location used when `catalog` is a bare id. Immutable.
   * @default "global"
   */
  location?: string;
  /**
   * Model id (4-40 characters). If omitted, a unique id is generated.
   * Immutable — changing it replaces the model.
   */
  modelId?: string;
  /**
   * Human-readable name (max 1,024 characters). Display name is set at create
   * time and is not updated in place.
   */
  displayName?: string;
  /**
   * Model type. Immutable.
   * @default "recommended-for-you"
   */
  type?: string;
  /**
   * Optimization objective (`ctr`, `cvr`, `revenue-per-order`). Immutable
   * after create.
   */
  optimizationObjective?: string;
  /**
   * Training state. Synced via pause/resume after create.
   * @default "PAUSED"
   */
  trainingState?:
    | "TRAINING_STATE_UNSPECIFIED"
    | "PAUSED"
    | "TRAINING"
    | (string & {});
  /**
   * Periodic tuning state. Patchable.
   */
  periodicTuningState?:
    | "PERIODIC_TUNING_STATE_UNSPECIFIED"
    | "PERIODIC_TUNING_DISABLED"
    | "ALL_TUNING_DISABLED"
    | "PERIODIC_TUNING_ENABLED"
    | (string & {});
  /**
   * Recommendation attribute filtering.
   */
  filteringOption?:
    | "RECOMMENDATIONS_FILTERING_OPTION_UNSPECIFIED"
    | "RECOMMENDATIONS_FILTERING_DISABLED"
    | "RECOMMENDATIONS_FILTERING_ENABLED"
    | (string & {});
};

export type CatalogsModel = Resource<
  "GCP.Retail.CatalogsModel",
  CatalogsModelProps,
  {
    /** Full resource name. */
    name: string;
    /** Model id. */
    modelId: string;
    /** Parent catalog resource name. */
    catalog: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** Model type. */
    type: string | undefined;
    /** Optimization objective. */
    optimizationObjective: string | undefined;
    /** Training state. */
    trainingState: string | undefined;
    /** Serving state. */
    servingState: string | undefined;
    /** Data state. */
    dataState: string | undefined;
    /** Periodic tuning state. */
    periodicTuningState: string | undefined;
    /** Filtering option. */
    filteringOption: string | undefined;
    /** RFC3339 create time. */
    createTime: string | undefined;
    /** RFC3339 update time. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Retail recommendation model on a catalog.
 *
 * Without labels, ownership rests on the deterministic id: `read` reports a
 * resource it finds without prior state as unowned (adopt it with `--adopt`).
 * Parent, model id, type, and optimization objective are immutable.
 * `filteringOption` and `periodicTuningState` patch in place; `trainingState`
 * is synced with pause/resume.
 *
 * Creating a model requires Retail Recommendations and enough catalog
 * and user-event data. Create is a long-running operation.
 *
 * ### Creating a Model
 * **Example:** Recommended-for-you model, paused
 * ```typescript
 * const model = yield* GCP.Retail.CatalogsModel("Homepage", {
 *   displayName: "homepage recs",
 *   type: "recommended-for-you",
 *   trainingState: "PAUSED",
 * });
 * ```
 *
 * @resource
 * @category Retail
 */
export const CatalogsModel = Resource<CatalogsModel>(
  "GCP.Retail.CatalogsModel",
);

export class CatalogsModelNotResolved extends Data.TaggedError(
  "GCP.Retail.CatalogsModelNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (model: retail.GoogleCloudRetailV2Model, project: string) => {
  const name = model.name ?? "";
  const parsed = parseResourceName(name, "models");
  return {
    name,
    modelId: parsed.id,
    catalog: parsed.catalog,
    project: parsed.project || project,
    location: parsed.location,
    displayName: model.displayName,
    type: model.type,
    optimizationObjective: model.optimizationObjective,
    trainingState: model.trainingState,
    servingState: model.servingState,
    dataState: model.dataState,
    periodicTuningState: model.periodicTuningState,
    filteringOption: model.filteringOption,
    createTime: model.createTime,
    updateTime: model.updateTime,
  };
};

const resourceName = (catalog: string, modelId: string) =>
  `${catalog}/models/${modelId}`;

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : retail
        .getProjectsLocationsCatalogsModels({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const refresh = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (model): model is retail.GoogleCloudRetailV2Model => model !== undefined,
      () => new CatalogsModelNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Retail.CatalogsModelNotResolved",
      times: 5,
      schedule: Schedule.exponential("250 millis"),
    }),
  );

export const CatalogsModelProvider = () =>
  Provider.succeed(CatalogsModel, {
    stables: [
      "name",
      "modelId",
      "catalog",
      "project",
      "location",
      "type",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousParent = olds?.catalog ?? output?.catalog;
      const nextParent = expandCatalog(
        news.catalog,
        env.project,
        normalizeLocation(news.location ?? output?.location),
      );
      const previousType = olds?.type ?? output?.type;
      const nextType = news.type ?? previousType;
      const previousObjective =
        olds?.optimizationObjective ?? output?.optimizationObjective;
      const nextObjective = news.optimizationObjective ?? previousObjective;
      const identity = replaceOnIdentity({
        previousId: olds?.modelId ?? output?.modelId,
        nextId: news.modelId,
        previousParent,
        nextParent,
      });
      if (
        identity !== undefined ||
        (previousType !== undefined &&
          nextType !== undefined &&
          previousType !== nextType) ||
        (previousObjective !== undefined &&
          nextObjective !== undefined &&
          previousObjective !== nextObjective)
      ) {
        return (
          identity ?? {
            action: "replace" as const,
            deleteFirst: true,
          }
        );
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const catalog = olds?.catalog ?? output?.catalog;
      const modelId = yield* toPhysical(
        id,
        olds?.modelId,
        output?.modelId,
        (name) => slugNoDigits(name, MAX_MODEL_ID_LENGTH),
        MAX_MODEL_ID_LENGTH,
      );
      const name =
        output?.name ??
        (catalog !== undefined
          ? resourceName(
              expandCatalog(
                catalog,
                env.project,
                normalizeLocation(output?.location),
              ),
              modelId,
            )
          : undefined);
      if (name === undefined) return undefined;
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      // No labels field: without prior state it may not be ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(news.location ?? output?.location);
      const catalog = expandCatalog(news.catalog, env.project, location);
      const modelId = yield* toPhysical(
        id,
        news.modelId,
        output?.modelId,
        (name) => slugNoDigits(name, MAX_MODEL_ID_LENGTH),
        MAX_MODEL_ID_LENGTH,
      );
      const name = resourceName(catalog, modelId);
      const displayName = news.displayName ?? modelId;
      const type = news.type ?? "recommended-for-you";
      const desiredTraining = news.trainingState ?? "PAUSED";

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const operation = yield* retail
          .createProjectsLocationsCatalogsModels({
            parent: catalog,
            body: {
              name,
              displayName,
              type,
              optimizationObjective: news.optimizationObjective,
              trainingState: "TRAINING",
              periodicTuningState: news.periodicTuningState,
              filteringOption: news.filteringOption,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              Effect.succeed<retail.GoogleLongrunningOperation>({
                name: "",
                done: true,
              }),
            ),
          );
        yield* waitForOperation(operation);
        const createdName = resourceNameFromOperation(operation) ?? name;
        current = yield* getByName(createdName).pipe(
          Effect.flatMap((model) =>
            model !== undefined ? Effect.succeed(model) : getByName(name),
          ),
        );
        if (current === undefined) {
          current = yield* refresh(name).pipe(
            Effect.catchTag("GCP.Retail.CatalogsModelNotResolved", () =>
              Effect.succeed(undefined),
            ),
          );
        }
      }

      if (current === undefined) {
        return yield* new CatalogsModelNotResolved({ name });
      }

      const resource = current.name ?? name;
      const mask = updateMaskOf(
        sameText(current.filteringOption, news.filteringOption)
          ? undefined
          : "filtering_option",
        sameText(current.periodicTuningState, news.periodicTuningState)
          ? undefined
          : "periodic_tuning_state",
      );
      if (mask.length > 0) {
        current = yield* retail.patchProjectsLocationsCatalogsModels({
          name: resource,
          updateMask: mask,
          body: {
            name: resource,
            filteringOption: news.filteringOption,
            periodicTuningState: news.periodicTuningState,
          },
        });
      }

      const observedTraining = current.trainingState ?? "TRAINING";
      if (desiredTraining === "PAUSED" && observedTraining !== "PAUSED") {
        current = yield* retail.pauseProjectsLocationsCatalogsModels({
          name: resource,
          body: {},
        });
      } else if (
        desiredTraining === "TRAINING" &&
        observedTraining !== "TRAINING"
      ) {
        current = yield* retail.resumeProjectsLocationsCatalogsModels({
          name: resource,
          body: {},
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* retail
        .deleteProjectsLocationsCatalogsModels({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
