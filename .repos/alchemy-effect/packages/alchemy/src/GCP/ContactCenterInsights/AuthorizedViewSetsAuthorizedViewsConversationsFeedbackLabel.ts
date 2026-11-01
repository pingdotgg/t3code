import * as cci from "@distilled.cloud/gcp/contactcenterinsights_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnershipLine,
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

export type QaAnswerLabel = {
  /** Matches `QaQuestion.AnswerChoice.key`. */
  key?: string;
  /** String answer. */
  strValue?: string;
  /** Numeric answer. */
  numValue?: number;
  /** Boolean answer. */
  boolValue?: boolean;
  /** Not-applicable answer. Should only be `true`. */
  naValue?: boolean;
  /** Skip this question. Should only be `true`. */
  skipValue?: boolean;
};

export type AuthorizedViewSetsAuthorizedViewsConversationsFeedbackLabelProps = {
  /**
   * Parent conversation under an AuthorizedView
   * (`{authorizedView}/conversations/{conversation}`). Immutable —
   * changing it replaces the label.
   */
  parent: string;
  /**
   * Feedback label id (the `{feedback_label}` segment). If omitted, a
   * unique id is generated. Immutable — changing it replaces the label.
   */
  feedbackLabelId?: string;
  /**
   * String label used for topic modeling. Feedback labels have no labels
   * map, so Alchemy ownership is stored in a `[alchemy …]` prefix and
   * stripped from attributes.
   */
  label?: string;
  /**
   * Resource being labeled (QA question, issue model, or generator).
   */
  labeledResource?: string;
  /**
   * QA answer label used for Quality AI example conversations.
   */
  qaAnswerLabel?: QaAnswerLabel;
};

export type AuthorizedViewSetsAuthorizedViewsConversationsFeedbackLabel =
  Resource<
    "GCP.ContactCenterInsights.AuthorizedViewSetsAuthorizedViewsConversationsFeedbackLabel",
    AuthorizedViewSetsAuthorizedViewsConversationsFeedbackLabelProps,
    {
      /** Full resource name. */
      name: string;
      /** Feedback label id (last path segment). */
      feedbackLabelId: string;
      /** Parent conversation under the AuthorizedView. */
      parent: string;
      /** Location id. */
      location: string;
      /** Project id. */
      project: string;
      /** User label with the Alchemy ownership prefix stripped. */
      label: string | undefined;
      /** Labeled resource name. */
      labeledResource: string | undefined;
      /** QA answer label. */
      qaAnswerLabel: QaAnswerLabel | undefined;
      /** RFC3339 creation timestamp. */
      createTime: string | undefined;
      /** RFC3339 last-update timestamp. */
      updateTime: string | undefined;
    },
    never,
    Providers
  >;

/**
 * A Contact Center AI Insights feedback label on a conversation, created
 * through an AuthorizedView.
 *
 * Feedback labels have no labels map — Alchemy stamps ownership into the
 * string `label`. Parent conversation and id are immutable. Label text,
 * labeled resource, and QA answer update in place.
 *
 * ### Creating a Feedback Label
 * **Example:** Topic-modeling label
 * ```typescript
 * const feedback =
 *   yield* GCP.ContactCenterInsights.AuthorizedViewSetsAuthorizedViewsConversationsFeedbackLabel(
 *     "Topic",
 *     {
 *       parent: `${view.name}/conversations/${conversation.conversationId}`,
 *       label: "billing",
 *     },
 *   );
 * ```
 *
 * @resource
 * @category ContactCenterInsights
 */
export const AuthorizedViewSetsAuthorizedViewsConversationsFeedbackLabel =
  Resource<AuthorizedViewSetsAuthorizedViewsConversationsFeedbackLabel>(
    "GCP.ContactCenterInsights.AuthorizedViewSetsAuthorizedViewsConversationsFeedbackLabel",
  );

export class AuthorizedViewSetsAuthorizedViewsConversationsFeedbackLabelNotResolved extends Data.TaggedError(
  "GCP.ContactCenterInsights.AuthorizedViewSetsAuthorizedViewsConversationsFeedbackLabelNotResolved",
)<{
  name: string;
}> {}

const qaOf = (
  value: cci.GoogleCloudContactcenterinsightsV1QaAnswerAnswerValue | undefined,
): QaAnswerLabel | undefined => {
  if (value === undefined) return undefined;
  return {
    key: value.key,
    strValue: value.strValue,
    numValue: value.numValue,
    boolValue: value.boolValue,
    naValue: value.naValue,
    skipValue: value.skipValue,
  };
};

const toAttrs = (
  label: cci.GoogleCloudContactcenterinsightsV1FeedbackLabel,
  project: string,
) => {
  const name = label.name ?? "";
  const parsed = parseOwnership(label.label);
  return {
    name,
    feedbackLabelId: lastSegment(name),
    parent: parentOf(name),
    location: locationOf(name),
    project,
    label: parsed.text,
    labeledResource: label.labeledResource,
    qaAnswerLabel: qaOf(label.qaAnswerLabel),
    createTime: label.createTime,
    updateTime: label.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : cci
        .getProjectsLocationsAuthorizedViewSetsAuthorizedViewsConversationsFeedbackLabels(
          { name },
        )
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAllAt = (parent: string, project: string) =>
  cci.listAllFeedbackLabelsProjectsLocations
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.feedbackLabels ?? [])),
      Stream.filter((label) => hasOwnershipMarker(label.label)),
      Stream.map((label) => toAttrs(label, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

export const AuthorizedViewSetsAuthorizedViewsConversationsFeedbackLabelProvider =
  () =>
    Provider.succeed(
      AuthorizedViewSetsAuthorizedViewsConversationsFeedbackLabel,
      {
        stables: [
          "name",
          "feedbackLabelId",
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
          const previousId = olds?.feedbackLabelId ?? output?.feedbackLabelId;
          if (
            previousId !== undefined &&
            news.feedbackLabelId !== undefined &&
            news.feedbackLabelId !== previousId
          ) {
            return { action: "replace" as const, deleteFirst: false };
          }
          return undefined;
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const env = yield* GcpEnvironment.current;
          const feedbackLabelId = yield* toResourceId(
            id,
            olds?.feedbackLabelId,
            output?.feedbackLabelId,
          );
          const name =
            output?.name ??
            (olds?.parent !== undefined
              ? `${olds.parent}/feedbackLabels/${feedbackLabelId}`
              : "");
          const existing = yield* getByName(name);
          if (existing === undefined) return undefined;
          const attrs = toAttrs(existing, env.project);
          return (yield* ownedByAlchemy(id, existing.label))
            ? attrs
            : Unowned(attrs);
        }),

        list: () =>
          Effect.gen(function* () {
            const env = yield* GcpEnvironment.current;
            return yield* listAllAt(
              locationParent(env.project, env.region),
              env.project,
            );
          }),

        reconcile: Effect.fn(function* ({ id, news, output }) {
          const env = yield* GcpEnvironment.current;
          const feedbackLabelId = yield* toResourceId(
            id,
            news.feedbackLabelId,
            output?.feedbackLabelId,
          );
          const name = `${news.parent}/feedbackLabels/${feedbackLabelId}`;
          const ownership = yield* createInternalLabels(id);
          const label = encodeOwnershipLine(ownership, news.label);

          let current = yield* getByName(output?.name ?? name);

          if (current === undefined) {
            const created = yield* cci
              .createProjectsLocationsAuthorizedViewSetsAuthorizedViewsConversationsFeedbackLabels(
                {
                  parent: news.parent,
                  feedbackLabelId,
                  body: {
                    label,
                    labeledResource: news.labeledResource,
                    qaAnswerLabel: news.qaAnswerLabel,
                  },
                },
              )
              .pipe(Effect.catchTag("Conflict", () => getByName(name)));
            current = created ?? undefined;
          }

          if (current === undefined) {
            return yield* new AuthorizedViewSetsAuthorizedViewsConversationsFeedbackLabelNotResolved(
              { name },
            );
          }

          const currentName = current.name ?? name;
          const labelChanged = (current.label ?? "") !== label;
          const resourceChanged = !sameText(
            current.labeledResource,
            news.labeledResource,
          );
          const qaChanged = !jsonEqual(
            qaOf(current.qaAnswerLabel),
            news.qaAnswerLabel,
          );

          if (labelChanged || resourceChanged || qaChanged) {
            current =
              yield* cci.patchProjectsLocationsAuthorizedViewSetsAuthorizedViewsConversationsFeedbackLabels(
                {
                  name: currentName,
                  updateMask: updateMaskOf(
                    labelChanged ? "label" : undefined,
                    resourceChanged ? "labeled_resource" : undefined,
                    qaChanged ? "qa_answer_label" : undefined,
                  ),
                  body: {
                    name: currentName,
                    label,
                    labeledResource: news.labeledResource,
                    qaAnswerLabel: news.qaAnswerLabel,
                  },
                },
              );
          }

          return toAttrs(current, env.project);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* cci
            .deleteProjectsLocationsAuthorizedViewSetsAuthorizedViewsConversationsFeedbackLabels(
              { name: output.name },
            )
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
      },
    );
