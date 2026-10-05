import * as cci from "@distilled.cloud/gcp/contactcenterinsights_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import type { AnnotatorSelector } from "./AnalysisRule.ts";
import { resourceNameFromOperation, waitForOperation } from "./operations.ts";
import {
  lastSegment,
  locationOf,
  locationParent,
  parentOf,
  sameJson,
} from "./ownership.ts";

type AnalysisAnnotatorSelector = AnnotatorSelector & {
  /** Summarization annotator configuration. */
  summarizationConfig?: cci.GoogleCloudContactcenterinsightsV1AnnotatorSelectorSummarizationConfig;
  /** QA annotator configuration. */
  qaConfig?: cci.GoogleCloudContactcenterinsightsV1AnnotatorSelectorQaConfig;
};

export type ConversationsAnalysesProps = {
  /**
   * Parent Conversation resource name
   * (`projects/{project}/locations/{location}/conversations/{conversation}`).
   * Immutable — changing it replaces the analysis.
   */
  parent: string;
  /**
   * Annotators to run. Analyses have no update RPC; changing the selector
   * replaces the analysis. Analyses have no labels or description field —
   * nuke finds them by walking alchemy-labeled parent conversations.
   */
  annotatorSelector?: AnalysisAnnotatorSelector;
};

export type ConversationsAnalyses = Resource<
  "GCP.ContactCenterInsights.ConversationsAnalyses",
  ConversationsAnalysesProps,
  {
    /** Full resource name. */
    name: string;
    /** Analysis id (last path segment). */
    analysisId: string;
    /** Parent conversation resource name. */
    parent: string;
    /** Region id. */
    location: string;
    /** Project id. */
    project: string;
    /** Annotators that were selected. */
    annotatorSelector: AnalysisAnnotatorSelector | undefined;
    /** RFC3339 time the analysis was requested. */
    requestTime: string | undefined;
    /** RFC3339 creation timestamp (when the LRO completed). */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An analysis of a Contact Center Insights conversation.
 *
 * Parent conversation and annotator selector are immutable — there is no
 * update RPC, so changing either replaces the analysis. Create is a
 * long-running operation that completes when the analysis finishes.
 * Analyses have no labels field; `list` walks alchemy-labeled parent
 * conversations.
 *
 * ### Creating an Analysis
 * **Example:** Silence-only analysis
 * ```typescript
 * const analysis = yield* GCP.ContactCenterInsights.ConversationsAnalyses(
 *   "Silence",
 *   {
 *     parent: conversation.name,
 *     annotatorSelector: { runSilenceAnnotator: true },
 *   },
 * );
 * ```
 *
 * @resource
 * @category ContactCenterInsights
 */
export const ConversationsAnalyses = Resource<ConversationsAnalyses>(
  "GCP.ContactCenterInsights.ConversationsAnalyses",
);

export class ConversationsAnalysesNotResolved extends Data.TaggedError(
  "GCP.ContactCenterInsights.ConversationsAnalysesNotResolved",
)<{
  name: string;
}> {}

const toSelector = (
  selector:
    | cci.GoogleCloudContactcenterinsightsV1AnnotatorSelector
    | AnalysisAnnotatorSelector
    | undefined,
): AnalysisAnnotatorSelector | undefined => {
  if (selector === undefined) return undefined;
  return {
    runSentimentAnnotator: selector.runSentimentAnnotator,
    runSummarizationAnnotator: selector.runSummarizationAnnotator,
    runQaAnnotator: selector.runQaAnnotator,
    runAutoLabelingAnnotator: selector.runAutoLabelingAnnotator,
    runIssueModelAnnotator: selector.runIssueModelAnnotator,
    runSilenceAnnotator: selector.runSilenceAnnotator,
    runPhraseMatcherAnnotator: selector.runPhraseMatcherAnnotator,
    runEntityAnnotator: selector.runEntityAnnotator,
    runIntentAnnotator: selector.runIntentAnnotator,
    runInterruptionAnnotator: selector.runInterruptionAnnotator,
    issueModels: selector.issueModels,
    phraseMatchers: selector.phraseMatchers,
    summarizationConfig: selector.summarizationConfig,
    qaConfig: selector.qaConfig,
  };
};

const toAttrs = (
  analysis: cci.GoogleCloudContactcenterinsightsV1Analysis,
  project: string,
) => {
  const name = analysis.name ?? "";
  return {
    name,
    analysisId: lastSegment(name),
    parent: parentOf(name),
    location: locationOf(name),
    project,
    annotatorSelector: toSelector(analysis.annotatorSelector),
    requestTime: analysis.requestTime,
    createTime: analysis.createTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : cci
        .getProjectsLocationsConversationsAnalyses({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((analysis) =>
      analysis
        ? Effect.succeed(analysis)
        : Effect.fail(new ConversationsAnalysesNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag ===
        "GCP.ContactCenterInsights.ConversationsAnalysesNotResolved",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const listConversations = (parent: string) =>
  cci.listProjectsLocationsConversations
    .pages({ parent, pageSize: 100, view: "BASIC" })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.conversations ?? [])),
      Stream.filter((conversation) =>
        Object.keys(conversation.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ),
      Stream.map((conversation) => conversation.name ?? ""),
      Stream.filter((name) => name.length > 0),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([] as string[])),
    );

const listAtParent = (parent: string, project: string) =>
  cci.listProjectsLocationsConversationsAnalyses
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.analyses ?? [])),
      Stream.map((analysis) => toAttrs(analysis, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

export const ConversationsAnalysesProvider = () =>
  Provider.succeed(ConversationsAnalyses, {
    stables: [
      "name",
      "analysisId",
      "parent",
      "location",
      "project",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.parent ?? output?.parent;
      if (previousParent !== undefined && news.parent !== previousParent) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousSelector =
        olds?.annotatorSelector ?? output?.annotatorSelector;
      if (
        previousSelector !== undefined &&
        !sameJson(
          toSelector(previousSelector),
          toSelector(news.annotatorSelector),
        )
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const existing = yield* getByName(output?.name ?? "");
      if (existing === undefined) return undefined;
      return toAttrs(existing, env.project);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const parent = locationParent(env.project, env.region);
        const conversations = yield* listConversations(parent);
        const pages = yield* Effect.forEach(
          conversations,
          (conversation) => listAtParent(conversation, env.project),
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const env = yield* GcpEnvironment.current;
      let current = yield* getByName(output?.name ?? "");

      if (current === undefined) {
        const created = yield* cci
          .createProjectsLocationsConversationsAnalyses({
            parent: news.parent,
            body: {
              annotatorSelector: news.annotatorSelector,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          const done = yield* waitForOperation(created);
          const createdName = resourceNameFromOperation(done) ?? "";
          if (createdName.length > 0) {
            current = yield* waitUntilExists(createdName);
          }
        }
      }

      if (current === undefined) {
        const listed = yield* listAtParent(news.parent, env.project);
        current = listed[0] ? yield* getByName(listed[0].name) : undefined;
      }

      if (current === undefined) {
        return yield* new ConversationsAnalysesNotResolved({
          name: output?.name ?? `${news.parent}/analyses/-`,
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* cci
        .deleteProjectsLocationsConversationsAnalyses({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
