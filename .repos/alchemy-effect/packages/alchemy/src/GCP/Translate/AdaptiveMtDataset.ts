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
  locationParent,
  normalizeLocation,
  parseResourceName,
  replaceOnIdentity,
  resourceNameOf,
  retryTransient,
  toPhysicalId,
  waitUntilGone,
  toRestrictedDisplayName,
} from "./internal.ts";

export type AdaptiveMtDatasetProps = {
  /**
   * Dataset id (the `{dataset}` segment of
   * `projects/{project}/locations/{location}/adaptiveMtDatasets/{dataset}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Immutable — changing it replaces the dataset.
   */
  datasetId?: string;
  /**
   * Location of the dataset (`us-central1`, `europe-west1`, …). Adaptive
   * MT is regional. Immutable — changing it replaces the dataset.
   * @default "us-central1"
   */
  location?: string;
  /**
   * User-facing display name. There is no update API — changing display name
   * replaces the dataset.
   */
  displayName?: string;
  /**
   * BCP-47 source language code, for example `"en"`. Immutable —
   * changing it replaces the dataset.
   */
  sourceLanguageCode: string;
  /**
   * BCP-47 target language code, for example `"es"`. Immutable —
   * changing it replaces the dataset.
   */
  targetLanguageCode: string;
};

export type AdaptiveMtDataset = Resource<
  "GCP.Translate.AdaptiveMtDataset",
  AdaptiveMtDatasetProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/adaptiveMtDatasets/{dataset}`. */
    name: string;
    /** Dataset id (last path segment). */
    datasetId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** BCP-47 source language code. */
    sourceLanguageCode: string | undefined;
    /** BCP-47 target language code. */
    targetLanguageCode: string | undefined;
    /** Number of imported sentence pairs. */
    exampleCount: number | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Adaptive MT dataset of source/target sentence pairs used to
 * customize Cloud Translation.
 *
 * Without labels, ownership rests on the deterministic id: `read` reports a
 * resource it finds without prior state as unowned (adopt it with `--adopt`).
 * Adaptive MT datasets are location-scoped and have no labels field. Language
 * pair, location, and display name are immutable — there is no patch RPC.
 *
 * ### Creating a Dataset
 * **Example:** English to Spanish
 * ```typescript
 * const dataset = yield* GCP.Translate.AdaptiveMtDataset("EnEs", {
 *   sourceLanguageCode: "en",
 *   targetLanguageCode: "es",
 * });
 * ```
 *
 * **Example:** Explicit id and location
 * ```typescript
 * const dataset = yield* GCP.Translate.AdaptiveMtDataset("EnEs", {
 *   datasetId: "en-es-adaptive",
 *   location: "us-central1",
 *   sourceLanguageCode: "en",
 *   targetLanguageCode: "es",
 *   displayName: "enes",
 * });
 * ```
 *
 * @resource
 * @category Translate
 */
export const AdaptiveMtDataset = Resource<AdaptiveMtDataset>(
  "GCP.Translate.AdaptiveMtDataset",
);

const resourceName = (project: string, location: string, datasetId: string) =>
  resourceNameOf(
    locationParent(project, location),
    "adaptiveMtDatasets",
    datasetId,
  );

const toAttrs = (dataset: translate.AdaptiveMtDataset, project: string) => {
  const name = dataset.name ?? "";
  const parsed = parseResourceName(name, "adaptiveMtDatasets");
  return {
    name,
    datasetId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: dataset.displayName,
    sourceLanguageCode: dataset.sourceLanguageCode,
    targetLanguageCode: dataset.targetLanguageCode,
    exampleCount: dataset.exampleCount,
    createTime: dataset.createTime,
    updateTime: dataset.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : translate
        .getProjectsLocationsAdaptiveMtDatasets({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const AdaptiveMtDatasetProvider = () =>
  Provider.succeed(AdaptiveMtDataset, {
    stables: ["name", "datasetId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const extra =
        (olds?.sourceLanguageCode !== undefined &&
          news.sourceLanguageCode !== olds.sourceLanguageCode) ||
        (output?.sourceLanguageCode !== undefined &&
          news.sourceLanguageCode !== output.sourceLanguageCode) ||
        (olds?.targetLanguageCode !== undefined &&
          news.targetLanguageCode !== olds.targetLanguageCode) ||
        (output?.targetLanguageCode !== undefined &&
          news.targetLanguageCode !== output.targetLanguageCode) ||
        (news.displayName !== undefined &&
          (olds?.displayName ?? output?.displayName) !== undefined &&
          news.displayName !== (olds?.displayName ?? output?.displayName));
      return replaceOnIdentity({
        previousId: olds?.datasetId ?? output?.datasetId,
        nextId: news.datasetId,
        previousLocation: olds?.location ?? output?.location,
        nextLocation: news.location ?? olds?.location ?? output?.location,
        extra,
      });
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(olds?.location ?? output?.location);
      const datasetId = olds?.datasetId ?? output?.datasetId;
      const name =
        output?.name ??
        (datasetId ? resourceName(env.project, location, datasetId) : "");
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
      const datasetId = yield* toPhysicalId(
        id,
        news.datasetId,
        output?.datasetId,
      );
      const name = resourceName(env.project, location, datasetId);
      const displayName = toRestrictedDisplayName(
        news.displayName ?? datasetId,
      );
      const hinted = output?.name ?? name;

      let current = yield* getByName(hinted);

      if (current === undefined) {
        const created = yield* retryTransient(
          translate.createProjectsLocationsAdaptiveMtDatasets({
            parent,
            body: {
              name,
              displayName,
              sourceLanguageCode: news.sourceLanguageCode,
              targetLanguageCode: news.targetLanguageCode,
            },
          }),
        ).pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name: hinted || name });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* retryTransient(
        translate.deleteProjectsLocationsAdaptiveMtDatasets({
          name: output.name,
        }),
      ).pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
