import * as cci from "@distilled.cloud/gcp/contactcenterinsights_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnership,
  hasOwnershipMarker,
  jsonEqual,
  lastSegment,
  locationOf,
  locationParent,
  ownedByAlchemy,
  parentOf,
  parseOwnership,
  sameText,
  toResourceId,
  updateMaskOf,
} from "./ownership.ts";

export type QaQuestionType =
  | "QA_QUESTION_TYPE_UNSPECIFIED"
  | "CUSTOMIZABLE"
  | "PREDEFINED";

export type QaQuestionAnswerChoice = {
  /** String answer value. */
  strValue?: string;
  /** Short identifier for the choice. */
  key?: string;
  /** Numerical answer value. */
  numValue?: number;
  /** Boolean answer value. */
  boolValue?: boolean;
  /** When true, the answer is N/A and excluded from scoring. */
  naValue?: boolean;
  /** Numerical score contributed by this choice. */
  score?: number;
};

export type QaQuestionPredefinedQuestionConfig = {
  /** Predefined question type. */
  type?:
    | "PREDEFINED_QUESTION_TYPE_UNSPECIFIED"
    | "CONVERSATION_OUTCOME"
    | "CONVERSATION_OUTCOME_ESCALATION_INITIATOR_ROLE"
    | (string & {});
};

export type QaQuestionDataOptions = {
  /** Conversation transcript options used to generate the question. */
  conversationDataOptions?: {
    /** Include per-turn Dialogflow interaction data. */
    includeDialogflowInteractionData?: boolean;
  };
};

export type QaScorecardsRevisionsQaQuestionProps = {
  /**
   * Parent QaScorecardRevision resource name
   * (`projects/{project}/locations/{location}/qaScorecards/{qa_scorecard}/revisions/{revision}`).
   * Immutable — changing it replaces the question.
   */
  parent: string;
  /**
   * Question id (the `{qa_question}` segment). If omitted, a unique id is
   * generated. Must match `^[a-z0-9-]{4,64}$`. Immutable — changing it
   * replaces the question.
   */
  qaQuestionId?: string;
  /**
   * Full question text, e.g. "Did the agent greet the customer?"
   */
  questionBody?: string;
  /**
   * Short UI label, e.g. "Greeting".
   */
  abbreviation?: string;
  /**
   * Question type.
   */
  questionType?: QaQuestionType;
  /**
   * Instructions describing how to determine the answer. Questions have
   * no labels field, so Alchemy ownership is stored in a `[alchemy …]`
   * prefix and stripped from attributes.
   */
  answerInstructions?: string;
  /**
   * Order of the question within its parent revision.
   */
  order?: number;
  /**
   * Valid answers the model must choose from.
   */
  answerChoices?: QaQuestionAnswerChoice[];
  /**
   * Default or custom tags used to group and score the question.
   */
  tags?: string[];
  /**
   * Configuration for a predefined question. Set when `questionType` is
   * `PREDEFINED`.
   */
  predefinedQuestionConfig?: QaQuestionPredefinedQuestionConfig;
  /**
   * Options for conversation data used to generate the question.
   */
  qaQuestionDataOptions?: QaQuestionDataOptions;
};

export type QaScorecardsRevisionsQaQuestion = Resource<
  "GCP.ContactCenterInsights.QaScorecardsRevisionsQaQuestion",
  QaScorecardsRevisionsQaQuestionProps,
  {
    /** Full resource name. */
    name: string;
    /** Question id (last path segment). */
    qaQuestionId: string;
    /** Parent revision resource name. */
    parent: string;
    /** Location id. */
    location: string;
    /** Project id. */
    project: string;
    /** Question text. */
    questionBody: string | undefined;
    /** Short UI label. */
    abbreviation: string | undefined;
    /** Question type. */
    questionType: string | undefined;
    /** User instructions with the Alchemy ownership prefix stripped. */
    answerInstructions: string | undefined;
    /** Order within the parent revision. */
    order: number | undefined;
    /** Valid answer choices. */
    answerChoices: QaQuestionAnswerChoice[] | undefined;
    /** Grouping tags. */
    tags: string[];
    /** Predefined question config. */
    predefinedQuestionConfig: QaQuestionPredefinedQuestionConfig | undefined;
    /** Question data options. */
    qaQuestionDataOptions: QaQuestionDataOptions | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A question on a Contact Center AI Insights QA scorecard revision.
 *
 * Parent revision and question id are immutable. Questions have no
 * labels field — Alchemy stamps ownership into `answerInstructions`.
 * Question body, abbreviation, instructions, order, choices, and tags
 * update in place while the parent revision is `EDITABLE`.
 *
 * ### Creating a QA Question
 * **Example:** Greeting question
 * ```typescript
 * const question = yield* GCP.ContactCenterInsights.QaScorecardsRevisionsQaQuestion(
 *   "Greeting",
 *   {
 *     parent: revision.name,
 *     abbreviation: "Greeting",
 *     questionBody: "Did the agent greet the customer?",
 *     answerChoices: [
 *       { strValue: "Yes", score: 1 },
 *       { strValue: "No", score: 0 },
 *     ],
 *   },
 * );
 * ```
 *
 * @resource
 * @category ContactCenterInsights
 */
export const QaScorecardsRevisionsQaQuestion =
  Resource<QaScorecardsRevisionsQaQuestion>(
    "GCP.ContactCenterInsights.QaScorecardsRevisionsQaQuestion",
  );

export class QaScorecardsRevisionsQaQuestionNotResolved extends Data.TaggedError(
  "GCP.ContactCenterInsights.QaScorecardsRevisionsQaQuestionNotResolved",
)<{
  name: string;
}> {}

const resourceName = (parent: string, qaQuestionId: string) =>
  `${parent}/qaQuestions/${qaQuestionId}`;

const choicesOf = (
  choices:
    | cci.GoogleCloudContactcenterinsightsV1QaQuestionAnswerChoiceList
    | undefined,
): QaQuestionAnswerChoice[] | undefined => {
  if (choices === undefined) return undefined;
  return choices.map((choice) => ({
    strValue: choice.strValue,
    key: choice.key,
    numValue: choice.numValue,
    boolValue: choice.boolValue,
    naValue: choice.naValue,
    score: choice.score,
  }));
};

const optionalString = (value: string | undefined): string | undefined => value;

const toAttrs = (
  question: cci.GoogleCloudContactcenterinsightsV1QaQuestion,
  project: string,
) => {
  const name = question.name ?? "";
  const parsed = parseOwnership(question.answerInstructions);
  return {
    name,
    qaQuestionId: lastSegment(name),
    parent: parentOf(name),
    location: locationOf(name),
    project,
    questionBody: question.questionBody,
    abbreviation: question.abbreviation,
    questionType: optionalString(question.questionType),
    answerInstructions: parsed.text,
    order: question.order,
    answerChoices: choicesOf(question.answerChoices),
    tags: [...(question.tags ?? [])],
    predefinedQuestionConfig: question.predefinedQuestionConfig
      ? { type: question.predefinedQuestionConfig.type }
      : undefined,
    qaQuestionDataOptions: question.qaQuestionDataOptions
      ? {
          conversationDataOptions: question.qaQuestionDataOptions
            .conversationDataOptions
            ? {
                includeDialogflowInteractionData:
                  question.qaQuestionDataOptions.conversationDataOptions
                    .includeDialogflowInteractionData,
              }
            : undefined,
        }
      : undefined,
    createTime: question.createTime,
    updateTime: question.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : cci
        .getProjectsLocationsQaScorecardsRevisionsQaQuestions({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listRevisions = (parent: string) =>
  cci.listProjectsLocationsQaScorecardsRevisions
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.qaScorecardRevisions ?? []),
      ),
      Stream.map((revision) => revision.name ?? ""),
      Stream.filter((name) => name.length > 0),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([] as string[])),
    );

const listAtParent = (parent: string, project: string) =>
  cci.listProjectsLocationsQaScorecardsRevisionsQaQuestions
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.qaQuestions ?? [])),
      Stream.filter((question) =>
        hasOwnershipMarker(question.answerInstructions),
      ),
      Stream.map((question) => toAttrs(question, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

export const QaScorecardsRevisionsQaQuestionProvider = () =>
  Provider.succeed(QaScorecardsRevisionsQaQuestion, {
    stables: [
      "name",
      "qaQuestionId",
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
      const previousId = olds?.qaQuestionId ?? output?.qaQuestionId;
      if (
        previousId !== undefined &&
        news.qaQuestionId !== undefined &&
        news.qaQuestionId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const qaQuestionId = yield* toResourceId(
        id,
        olds?.qaQuestionId,
        output?.qaQuestionId,
      );
      const name =
        output?.name ??
        (olds?.parent !== undefined
          ? resourceName(olds.parent, qaQuestionId)
          : "");
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.answerInstructions))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const revisions = yield* listRevisions(
          `${locationParent(env.project, env.region)}/qaScorecards/-`,
        );
        const pages = yield* Effect.forEach(
          revisions,
          (parent) => listAtParent(parent, env.project),
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const qaQuestionId = yield* toResourceId(
        id,
        news.qaQuestionId,
        output?.qaQuestionId,
      );
      const name = resourceName(news.parent, qaQuestionId);
      const ownership = yield* createInternalLabels(id);
      const answerInstructions = encodeOwnership(
        ownership,
        news.answerInstructions,
      );
      const tags = news.tags ?? [];

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* cci
          .createProjectsLocationsQaScorecardsRevisionsQaQuestions({
            parent: news.parent,
            qaQuestionId,
            body: {
              questionBody: news.questionBody,
              abbreviation: news.abbreviation,
              questionType: news.questionType,
              answerInstructions,
              order: news.order,
              answerChoices: news.answerChoices,
              tags: tags.length > 0 ? tags : undefined,
              predefinedQuestionConfig: news.predefinedQuestionConfig,
              qaQuestionDataOptions: news.qaQuestionDataOptions,
            },
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "QaScorecardPreconditionFailed",
              times: 8,
              schedule: Schedule.exponential("250 millis"),
            }),
            Effect.catchIf(
              (error) => error._tag === "Conflict",
              () => getByName(name),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new QaScorecardsRevisionsQaQuestionNotResolved({
          name,
        });
      }

      const currentName = current.name ?? name;
      const bodyChanged = !sameText(current.questionBody, news.questionBody);
      const abbreviationChanged = !sameText(
        current.abbreviation,
        news.abbreviation,
      );
      const instructionsChanged =
        (current.answerInstructions ?? "") !== answerInstructions;
      const orderChanged = (current.order ?? 0) !== (news.order ?? 0);
      const choicesChanged = !jsonEqual(
        choicesOf(current.answerChoices),
        news.answerChoices,
      );
      const tagsChanged = !jsonEqual(current.tags ?? [], tags);

      if (
        bodyChanged ||
        abbreviationChanged ||
        instructionsChanged ||
        orderChanged ||
        choicesChanged ||
        tagsChanged
      ) {
        current =
          yield* cci.patchProjectsLocationsQaScorecardsRevisionsQaQuestions({
            name: currentName,
            updateMask: updateMaskOf(
              bodyChanged ? "question_body" : undefined,
              abbreviationChanged ? "abbreviation" : undefined,
              instructionsChanged ? "answer_instructions" : undefined,
              orderChanged ? "order" : undefined,
              choicesChanged ? "answer_choices" : undefined,
              tagsChanged ? "tags" : undefined,
            ),
            body: {
              name: currentName,
              questionBody: news.questionBody,
              abbreviation: news.abbreviation,
              answerInstructions,
              order: news.order,
              answerChoices: news.answerChoices,
              tags,
            },
          });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* cci
        .deleteProjectsLocationsQaScorecardsRevisionsQaQuestions({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
