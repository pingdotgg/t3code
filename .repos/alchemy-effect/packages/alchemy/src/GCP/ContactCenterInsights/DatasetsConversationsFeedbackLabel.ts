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
import type { QaAnswerLabel } from "./AuthorizedViewSetsAuthorizedViewsConversationsFeedbackLabel.ts";
import {
  encodeOwnershipLine,
  hasOwnershipMarker,
  lastSegment,
  locationOf,
  locationParent,
  MAX_LABEL_LENGTH,
  ownedByAlchemy,
  parentOf,
  parseOwnership,
  sameJson,
  toResourceId,
} from "./ownership.ts";

export type DatasetsConversationsFeedbackLabelProps = {
  /**
   * Parent dataset conversation resource name
   * (`projects/{project}/locations/{location}/datasets/{dataset}/conversations/{conversation}`).
   * Immutable — changing it replaces the feedback label.
   */
  parent: string;
  /**
   * Feedback label id (the `{feedback_label}` segment). If omitted, a
   * unique id is generated. Immutable — changing it replaces the label.
   */
  feedbackLabelId?: string;
  /**
   * Topic-modeling string label. Feedback labels have no labels field, so
   * Alchemy ownership is stored in a `[alchemy …]` prefix and stripped
   * from attributes.
   */
  label?: string;
  /**
   * Resource being labeled (scorecard question, issue model, or generator).
   */
  labeledResource?: string;
  /**
   * Quality-AI answer label.
   */
  qaAnswerLabel?: QaAnswerLabel;
};

export type DatasetsConversationsFeedbackLabel = Resource<
  "GCP.ContactCenterInsights.DatasetsConversationsFeedbackLabel",
  DatasetsConversationsFeedbackLabelProps,
  {
    /** Full resource name. */
    name: string;
    /** Feedback label id (last path segment). */
    feedbackLabelId: string;
    /** Parent dataset conversation resource name. */
    parent: string;
    /** Region id. */
    location: string;
    /** Project id. */
    project: string;
    /** User label with the Alchemy ownership prefix stripped. */
    label: string | undefined;
    /** Resource being labeled. */
    labeledResource: string | undefined;
    /** Quality-AI answer label. */
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
 * A feedback label on a conversation inside a Contact Center Insights
 * dataset.
 *
 * Parent dataset conversation and feedback label id are immutable.
 * Feedback labels have no labels map — Alchemy stamps ownership into the
 * `label` string. The label text, labeled resource, and QA answer update
 * in place.
 *
 * ### Creating a Dataset Conversation Feedback Label
 * **Example:** Topic-modeling label
 * ```typescript
 * const label = yield* GCP.ContactCenterInsights.DatasetsConversationsFeedbackLabel(
 *   "Topic",
 *   {
 *     parent: datasetConversation.name,
 *     label: "billing",
 *   },
 * );
 * ```
 *
 * @resource
 * @category ContactCenterInsights
 */
export const DatasetsConversationsFeedbackLabel =
  Resource<DatasetsConversationsFeedbackLabel>(
    "GCP.ContactCenterInsights.DatasetsConversationsFeedbackLabel",
  );

export class DatasetsConversationsFeedbackLabelNotResolved extends Data.TaggedError(
  "GCP.ContactCenterInsights.DatasetsConversationsFeedbackLabelNotResolved",
)<{
  name: string;
}> {}

const resourceName = (parent: string, feedbackLabelId: string) =>
  `${parent}/feedbackLabels/${feedbackLabelId}`;

const toQa = (
  value:
    | cci.GoogleCloudContactcenterinsightsV1QaAnswerAnswerValue
    | QaAnswerLabel
    | undefined,
): QaAnswerLabel | undefined => {
  if (value === undefined) return undefined;
  return {
    skipValue: value.skipValue,
    naValue: value.naValue,
    key: value.key,
    numValue: value.numValue,
    boolValue: value.boolValue,
    strValue: value.strValue,
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
    qaAnswerLabel: toQa(label.qaAnswerLabel),
    createTime: label.createTime,
    updateTime: label.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : cci
        .getProjectsLocationsDatasetsConversationsFeedbackLabels({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listDatasets = (parent: string) =>
  cci.listProjectsLocationsDatasets.pages({ parent, pageSize: 100 }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.datasets ?? [])),
    Stream.map((dataset) => dataset.name ?? ""),
    Stream.filter((name) => name.length > 0),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("NotFound", () => Effect.succeed([] as string[])),
  );

const listAtDataset = (dataset: string, project: string) =>
  cci.listAllFeedbackLabelsProjectsLocationsDatasets
    .pages({ parent: dataset, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.feedbackLabels ?? [])),
      Stream.filter((label) => hasOwnershipMarker(label.label)),
      Stream.map((label) => toAttrs(label, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

export const DatasetsConversationsFeedbackLabelProvider = () =>
  Provider.succeed(DatasetsConversationsFeedbackLabel, {
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
        return { action: "replace" as const, deleteFirst: true };
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
          ? resourceName(olds.parent, feedbackLabelId)
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
        const datasets = yield* listDatasets(
          locationParent(env.project, env.region),
        );
        const pages = yield* Effect.forEach(
          datasets,
          (dataset) => listAtDataset(dataset, env.project),
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const feedbackLabelId = yield* toResourceId(
        id,
        news.feedbackLabelId,
        output?.feedbackLabelId,
      );
      const name = resourceName(news.parent, feedbackLabelId);
      const ownership = yield* createInternalLabels(id);
      const label = encodeOwnershipLine(
        ownership,
        news.label,
        MAX_LABEL_LENGTH,
      );

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* cci
          .createProjectsLocationsDatasetsConversationsFeedbackLabels({
            parent: news.parent,
            feedbackLabelId,
            body: {
              label,
              labeledResource: news.labeledResource,
              qaAnswerLabel: news.qaAnswerLabel,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new DatasetsConversationsFeedbackLabelNotResolved({
          name,
        });
      }

      const labelChanged = (current.label ?? "") !== label;
      const resourceChanged =
        (current.labeledResource ?? "") !== (news.labeledResource ?? "");
      const qaChanged = !sameJson(
        toQa(current.qaAnswerLabel),
        news.qaAnswerLabel,
      );

      if (labelChanged || resourceChanged || qaChanged) {
        current =
          yield* cci.patchProjectsLocationsDatasetsConversationsFeedbackLabels({
            name: current.name ?? name,
            updateMask: [
              labelChanged ? "label" : undefined,
              resourceChanged ? "labeled_resource" : undefined,
              qaChanged ? "qa_answer_label" : undefined,
            ]
              .filter((field): field is string => field !== undefined)
              .join(","),
            body: {
              name: current.name ?? name,
              label,
              labeledResource: news.labeledResource,
              qaAnswerLabel: news.qaAnswerLabel,
            },
          });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* cci
        .deleteProjectsLocationsDatasetsConversationsFeedbackLabels({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
