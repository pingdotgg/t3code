import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { listLocations } from "./names.ts";
import { resourceNameFromOperation, waitForOperation } from "./operations.ts";
import {
  AiPlatformNotResolved,
  AiPlatformStillExists,
  collectPages,
  encodeDescription,
  hasDescriptionOwnership,
  jsonEqual,
  locationParent,
  normalizeLocation,
  parseDescription,
  parseResourceName,
  type EncryptionSpec,
} from "./shared.ts";

const COLLECTION = "ragCorpora";

export type VertexAiSearchConfig = {
  /** Vertex AI Search serving config resource name. */
  servingConfig?: string;
};

export type RagEmbeddingModelConfig = {
  /** Vertex Prediction endpoint for embeddings. */
  vertexPredictionEndpoint?: {
    endpoint?: string;
  };
};

export type RagVectorDbConfig = {
  /** Embedding model used for dense vector search. */
  ragEmbeddingModelConfig?: RagEmbeddingModelConfig;
};

export type RagCorporaProps = {
  /**
   * Vertex AI location. Immutable — changing it replaces the corpus.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Display name (max 128 UTF-8 characters). Required by the API.
   */
  displayName?: string;
  /**
   * Human-readable description. RagCorpus has no labels field, so Alchemy
   * ownership is stored in a `[alchemy …]` prefix for `list` / nuke.
   */
  description?: string;
  /**
   * Customer-managed encryption key. Immutable.
   */
  encryptionSpec?: EncryptionSpec;
  /**
   * Vertex AI Search config. Immutable.
   */
  vertexAiSearchConfig?: VertexAiSearchConfig;
  /**
   * Vector DB config. Immutable.
   */
  vectorDbConfig?: RagVectorDbConfig;
};

export type RagCorpora = Resource<
  "GCP.AIPlatform.RagCorpora",
  RagCorporaProps,
  {
    /** Full resource name. */
    name: string;
    /** Corpus id (last path segment). */
    ragCorpusId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Corpus status (`INITIALIZED`, `ACTIVE`, `ERROR`). */
    corpusState: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Vertex AI RAG corpus — a container for RagFiles used by retrieval
 * augmented generation.
 *
 * RagCorpus has no labels, so Alchemy stamps ownership into the
 * description. Changing `location`, `encryptionSpec`,
 * `vertexAiSearchConfig`, or `vectorDbConfig` replaces the corpus.
 * Display name and description update in place.
 *
 * ### Creating a Corpus
 * **Example:** Managed-DB corpus
 * ```typescript
 * const corpus = yield* GCP.AIPlatform.RagCorpora("Docs", {
 *   displayName: "product-docs",
 *   description: "product manuals",
 * });
 * ```
 *
 * @resource
 * @category AIPlatform
 */
export const RagCorpora = Resource<RagCorpora>("GCP.AIPlatform.RagCorpora");

export class RagCorporaNotResolved extends Data.TaggedError(
  "GCP.AIPlatform.RagCorporaNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (
  corpus: aiplatform.GoogleCloudAiplatformV1RagCorpus,
  project: string,
) => {
  const name = corpus.name ?? "";
  const parsed = parseResourceName(name, COLLECTION);
  const description = parseDescription(corpus.description);
  return {
    name,
    ragCorpusId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: corpus.displayName,
    description: description.description,
    corpusState: corpus.corpusStatus?.state,
    createTime: corpus.createTime,
    updateTime: corpus.updateTime,
  };
};

const getByName = (name: string) =>
  aiplatform
    .getProjectsLocationsRagCorpora({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (corpus): corpus is aiplatform.GoogleCloudAiplatformV1RagCorpus =>
        corpus !== undefined,
      () => new AiPlatformNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.AIPlatform.NotResolved",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (corpus) => corpus === undefined,
      () => new AiPlatformStillExists({ name }),
    ),
    Effect.asVoid,
    Effect.retry({
      while: (error) => error._tag === "GCP.AIPlatform.StillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const findOwned = (parent: string, id: string, project: string) =>
  Effect.gen(function* () {
    const expected = yield* createInternalLabels(id);
    const pages = yield* collectPages(
      aiplatform.listProjectsLocationsRagCorpora.pages({
        parent,
        pageSize: 100,
      }),
    ).pipe(Effect.catchTag("NotFound", () => Effect.succeed([])));
    return pages
      .flatMap((page) => page.ragCorpora ?? [])
      .find((corpus) => {
        const parsed = parseDescription(corpus.description);
        return parsed.labels["alchemy-id"] === expected["alchemy-id"];
      });
  });

export const RagCorporaProvider = () =>
  Provider.succeed(RagCorpora, {
    stables: ["name", "ragCorpusId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      const env = yield* GcpEnvironment.current;
      if (!isResolved(news)) return undefined;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const encryptionChanged =
        (news.encryptionSpec?.kmsKeyName ?? "") !==
        (olds?.encryptionSpec?.kmsKeyName ?? "");
      const searchChanged = !jsonEqual(
        news.vertexAiSearchConfig,
        olds?.vertexAiSearchConfig,
      );
      const vectorChanged = !jsonEqual(
        news.vectorDbConfig,
        olds?.vectorDbConfig,
      );
      const replace =
        previousLocation !== nextLocation ||
        (olds !== undefined &&
          (encryptionChanged || searchChanged || vectorChanged));
      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst: previousLocation === nextLocation,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const parent = locationParent(env.project, location);
      const existing =
        output?.name !== undefined
          ? yield* getByName(output.name)
          : yield* findOwned(parent, id, env.project);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const parsed = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, parsed.labels))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = (yield* Effect.forEach(
          listLocations(env.region),
          (location) =>
            collectPages(
              aiplatform.listProjectsLocationsRagCorpora.pages({
                parent: locationParent(env.project, location),
                pageSize: 100,
              }),
            ).pipe(Effect.catchTag("NotFound", () => Effect.succeed([]))),
        )).flat();
        return pages.flatMap((page) =>
          (page.ragCorpora ?? [])
            .filter((corpus) => hasDescriptionOwnership(corpus.description))
            .map((corpus) => toAttrs(corpus, env.project)),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const parent = locationParent(env.project, location);
      const internal = yield* createInternalLabels(id);
      const stampedDescription = encodeDescription(internal, news.description);
      const displayName = news.displayName ?? "rag-corpus";

      let current =
        output?.name !== undefined
          ? yield* getByName(output.name)
          : yield* findOwned(parent, id, env.project);

      if (current === undefined) {
        const created = yield* aiplatform.createProjectsLocationsRagCorpora({
          parent,
          body: {
            displayName,
            description: stampedDescription,
            encryptionSpec: news.encryptionSpec,
            vertexAiSearchConfig: news.vertexAiSearchConfig,
            vectorDbConfig: news.vectorDbConfig,
          },
        });
        yield* waitForOperation(created, { alreadyExistsOk: true });
        const createdName = resourceNameFromOperation(created);
        current =
          createdName !== undefined
            ? yield* waitUntilExists(createdName)
            : yield* findOwned(parent, id, env.project);
      }

      if (current === undefined || current.name === undefined) {
        return yield* new RagCorporaNotResolved({
          name: output?.name ?? parent,
        });
      }

      const observedName = current.name;
      const observed = parseDescription(current.description);
      const displayChanged = (current.displayName ?? "") !== displayName;
      const descriptionChanged =
        (observed.description ?? "") !== (news.description ?? "");

      if (displayChanged || descriptionChanged) {
        const patched = yield* aiplatform.patchProjectsLocationsRagCorpora({
          name: observedName,
          body: {
            name: observedName,
            displayName,
            description: stampedDescription,
          },
        });
        yield* waitForOperation(patched);
        current = yield* getByName(observedName);
      }

      if (current === undefined) {
        return yield* new RagCorporaNotResolved({ name: observedName });
      }
      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* aiplatform
        .deleteProjectsLocationsRagCorpora({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
