import * as translate from "@distilled.cloud/gcp/translate_v3";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_LOCATION,
  ResourceNotResolved,
  expandParent,
  locationParent,
  normalizeLocation,
  parseResourceName,
  replaceOnIdentity,
  resourceNameOf,
  retryTransient,
  waitUntilGone,
  toRestrictedDisplayName,
} from "./internal.ts";
import { waitForOperation } from "./operations.ts";

export type ModelProps = {
  /**
   * Server-assigned model id (the `{model}` segment of
   * `projects/{project}/locations/{location}/models/{model}`, e.g.
   * `NM…`) of an existing model to manage. Omit to train a new model.
   * Immutable — changing it replaces the model.
   */
  modelId?: string;
  /**
   * Location of the model (`us-central1`, `europe-west1`, …). Custom
   * AutoML Translation models are regional. Immutable — changing it
   * replaces the model.
   * @default "us-central1"
   */
  location?: string;
  /**
   * Training dataset resource name
   * `projects/{project}/locations/{location}/datasets/{dataset}` or the
   * dataset id (combined with `location`). Immutable — changing it
   * replaces the model.
   */
  dataset: string;
  /**
   * User-facing display name. There is no update API — changing display name
   * replaces the model.
   */
  displayName?: string;
};

export type Model = Resource<
  "GCP.Translate.Model",
  ModelProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/models/{model}`. */
    name: string;
    /** Model id (last path segment). */
    modelId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Training dataset resource name. */
    dataset: string | undefined;
    /** Display name. */
    displayName: string | undefined;
    /** BCP-47 source language copied from the dataset. */
    sourceLanguageCode: string | undefined;
    /** BCP-47 target language copied from the dataset. */
    targetLanguageCode: string | undefined;
    /** Number of sentence pairs used to train the model. */
    trainExampleCount: number | undefined;
    /** Number of sentence pairs used to validate the model. */
    validateExampleCount: number | undefined;
    /** Number of sentence pairs used to test the model. */
    testExampleCount: number | undefined;
    /** RFC3339 creation timestamp (also when training started). */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A trained Cloud Translation AutoML model.
 *
 * Model ids are assigned by Google and models have no labels, so Alchemy
 * tracks a model only through the name recorded in state; `read` reports a
 * model it finds without prior state as unowned (adopt it with `--adopt`).
 * Models are trained from a Translation dataset in the same location. Create
 * and delete are long-running operations. Dataset, location, and display name
 * are immutable — there is no patch RPC. Training can take hours; tests
 * skipIf-gate behind `FAST`.
 *
 * ### Creating a Model
 * **Example:** Train from a dataset
 * ```typescript
 * const model = yield* GCP.Translate.Model("EnEs", {
 *   dataset: dataset.name,
 *   displayName: "enes",
 * });
 * ```
 *
 * **Example:** Explicit location
 * ```typescript
 * const model = yield* GCP.Translate.Model("EnEs", {
 *   location: "us-central1",
 *   dataset: dataset.name,
 * });
 * ```
 *
 * @resource
 * @category Translate
 */
export const Model = Resource<Model>("GCP.Translate.Model");

const resourceName = (project: string, location: string, modelId: string) =>
  resourceNameOf(locationParent(project, location), "models", modelId);

const datasetNameOf = (project: string, location: string, dataset: string) =>
  expandParent(dataset, project, location, "datasets");

const toAttrs = (model: translate.Model, project: string) => {
  const name = model.name ?? "";
  const parsed = parseResourceName(name, "models");
  return {
    name,
    modelId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    dataset: model.dataset,
    displayName: model.displayName,
    sourceLanguageCode: model.sourceLanguageCode,
    targetLanguageCode: model.targetLanguageCode,
    trainExampleCount: model.trainExampleCount,
    validateExampleCount: model.validateExampleCount,
    testExampleCount: model.testExampleCount,
    createTime: model.createTime,
    updateTime: model.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : translate
        .getProjectsLocationsModels({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const ModelProvider = () =>
  Provider.succeed(Model, {
    stables: ["name", "modelId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousDataset = olds?.dataset ?? output?.dataset;
      const extra =
        (previousDataset !== undefined &&
          news.dataset !== previousDataset &&
          !news.dataset.endsWith(`/${previousDataset}`) &&
          !(previousDataset ?? "").endsWith(`/${news.dataset}`)) ||
        (news.displayName !== undefined &&
          (olds?.displayName ?? output?.displayName) !== undefined &&
          news.displayName !== (olds?.displayName ?? output?.displayName));
      return replaceOnIdentity({
        previousId: olds?.modelId ?? output?.modelId,
        nextId: news.modelId,
        previousLocation: olds?.location ?? output?.location,
        nextLocation: news.location ?? olds?.location ?? output?.location,
        extra,
      });
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(olds?.location ?? output?.location);
      const modelId = olds?.modelId ?? output?.modelId;
      const name =
        output?.name ??
        (modelId ? resourceName(env.project, location, modelId) : "");
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      // No labels field: without prior state it may not be ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location ?? DEFAULT_LOCATION,
      );
      const parent = locationParent(env.project, location);
      const dataset = datasetNameOf(env.project, location, news.dataset);
      const displayName = toRestrictedDisplayName(news.displayName ?? id);
      const hinted =
        output?.name ??
        (news.modelId ? resourceName(env.project, location, news.modelId) : "");

      let current = yield* getByName(hinted);

      if (current === undefined) {
        const operation = yield* retryTransient(
          translate.createProjectsLocationsModels({
            parent,
            body: { displayName, dataset },
          }),
        );
        // Training a custom model takes hours.
        const done = yield* waitForOperation(operation, { budget: "12 hours" });
        const createdName = done.response?.name;
        current = yield* getByName(
          typeof createdName === "string" ? createdName : "",
        );
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name: hinted || parent });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      const operation = yield* retryTransient(
        translate.deleteProjectsLocationsModels({
          name: output.name,
        }),
      ).pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined && "done" in operation) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
