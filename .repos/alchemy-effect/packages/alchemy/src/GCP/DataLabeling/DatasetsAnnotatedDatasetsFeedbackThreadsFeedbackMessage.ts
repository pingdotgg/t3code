import * as datalabeling from "@distilled.cloud/gcp/datalabeling_v1beta1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnership,
  findOwned,
  hasOwnershipMarker,
  ignoreGone,
  listAllFeedbackMessages,
  MAX_FEEDBACK_BODY_LENGTH,
  noRetryLayer,
  ownedByAlchemy,
  parseOwnership,
  parseResourceName,
  replaceOnIdentity,
  retryDelete,
  retryTransient,
  sameText,
  waitForVisible,
  waitUntilGone,
} from "./internal.ts";
import { resourceNameFromOperation, waitForOperation } from "./operations.ts";

export type DatasetsAnnotatedDatasetsFeedbackThreadsFeedbackMessageProps = {
  /**
   * Parent feedback thread resource name
   * `projects/{project}/datasets/{dataset}/annotatedDatasets/{annotatedDataset}/feedbackThreads/{feedbackThread}`.
   * Immutable — changing it replaces the message.
   */
  parent: string;
  /**
   * Feedback message id (the last path segment). Server-assigned on
   * create. Immutable — changing it replaces the message.
   */
  feedbackMessageId?: string;
  /**
   * String content of the feedback. Maximum 10,000 characters. Messages
   * have no labels field, so Alchemy stamps ownership into this field.
   * Immutable — changing it replaces the message.
   */
  body?: string;
  /**
   * Image payload for this feedback, if the comment is an image.
   * Immutable — changing it replaces the message.
   */
  image?: string;
};

export type DatasetsAnnotatedDatasetsFeedbackThreadsFeedbackMessage = Resource<
  "GCP.DataLabeling.DatasetsAnnotatedDatasetsFeedbackThreadsFeedbackMessage",
  DatasetsAnnotatedDatasetsFeedbackThreadsFeedbackMessageProps,
  {
    /**
     * Full resource name
     * `.../feedbackThreads/{thread}/feedbackMessages/{message}`.
     */
    name: string;
    /** Feedback message id (last path segment). */
    feedbackMessageId: string;
    /** Parent feedback thread resource name. */
    parent: string;
    /** Project id. */
    project: string;
    /** Dataset id. */
    datasetId: string;
    /** User body with the Alchemy ownership prefix stripped. */
    body: string | undefined;
    /** Image payload, if any. */
    image: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Data Labeling feedback message on a labeling-task feedback thread.
 *
 * Create is a long-running operation. Message ids are server-assigned.
 * Parent thread, body, and image are immutable — changing them replaces
 * the message. There is no labels API, so Alchemy stamps ownership into
 * `body` so `list` / nuke can find them.
 *
 * ### Creating a Feedback Message
 * **Example:** Text comment on a thread
 * ```typescript
 * const message = yield* GCP.DataLabeling.DatasetsAnnotatedDatasetsFeedbackThreadsFeedbackMessage(
 *   "Note",
 *   {
 *     parent: threadName,
 *     body: "please relabel the occluded boxes",
 *   },
 * );
 * ```
 *
 * **Example:** Ownership-only body
 * ```typescript
 * const message = yield* GCP.DataLabeling.DatasetsAnnotatedDatasetsFeedbackThreadsFeedbackMessage(
 *   "Note",
 *   {
 *     parent: threadName,
 *   },
 * );
 * ```
 *
 * @resource
 * @category DataLabeling
 */
export const DatasetsAnnotatedDatasetsFeedbackThreadsFeedbackMessage =
  Resource<DatasetsAnnotatedDatasetsFeedbackThreadsFeedbackMessage>(
    "GCP.DataLabeling.DatasetsAnnotatedDatasetsFeedbackThreadsFeedbackMessage",
  );

export class DatasetsAnnotatedDatasetsFeedbackThreadsFeedbackMessageNotResolved extends Data.TaggedError(
  "GCP.DataLabeling.DatasetsAnnotatedDatasetsFeedbackThreadsFeedbackMessageNotResolved",
)<{
  name: string;
}> {}

const resourceNameOf = (parent: string, feedbackMessageId: string) =>
  `${parent}/feedbackMessages/${feedbackMessageId}`;

const expandParent = (parent: string, project: string) =>
  parent.includes("/")
    ? parent.replace(/\/+$/, "")
    : `projects/${project}/datasets/_/annotatedDatasets/_/feedbackThreads/${parent}`;

const toAttrs = (
  message: datalabeling.GoogleCloudDatalabelingV1beta1FeedbackMessage,
  project: string,
) => {
  const name = message.name ?? "";
  const parsed = parseResourceName(
    name.replace(/\/feedbackMessage\//, "/feedbackMessages/"),
    "feedbackMessages",
  );
  const fallback = parseResourceName(name, "feedbackMessage");
  const collection = parsed.id.length > 0 ? parsed : fallback;
  return {
    name,
    feedbackMessageId: collection.id,
    parent: collection.parent,
    project: collection.project || project,
    datasetId: collection.datasetId,
    body: parseOwnership(message.body).text,
    image: message.image,
    createTime: message.createTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : datalabeling
        .getProjectsDatasetsAnnotatedDatasetsFeedbackThreadsFeedbackMessages({
          name,
        })
        .pipe(
          Effect.provide(noRetryLayer),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          Effect.catchTag("BadGateway", () => Effect.succeed(undefined)),
        );

const findByOwnership = (id: string, project: string) =>
  Effect.gen(function* () {
    const rows = yield* listAllFeedbackMessages(project);
    return yield* findOwned(id, rows, (row) => row.body);
  });

export const DatasetsAnnotatedDatasetsFeedbackThreadsFeedbackMessageProvider =
  () =>
    Provider.succeed(DatasetsAnnotatedDatasetsFeedbackThreadsFeedbackMessage, {
      stables: [
        "name",
        "feedbackMessageId",
        "parent",
        "project",
        "datasetId",
        "createTime",
      ],

      diff: Effect.fn(function* ({ news, olds, output }) {
        if (!isResolved(news)) return undefined;
        const extra =
          (olds !== undefined && !sameText(news.body, output?.body)) ||
          (output !== undefined && !sameText(news.image, output.image));
        return replaceOnIdentity({
          previousId: olds?.feedbackMessageId ?? output?.feedbackMessageId,
          nextId: news.feedbackMessageId,
          previousParent: olds?.parent ?? output?.parent,
          nextParent: news.parent,
          extra,
        });
      }),

      read: Effect.fn(function* ({ id, olds, output }) {
        const env = yield* GcpEnvironment.current;
        const parent =
          olds?.parent !== undefined
            ? expandParent(olds.parent, env.project)
            : (output?.parent ?? "");
        const feedbackMessageId =
          olds?.feedbackMessageId ??
          output?.feedbackMessageId ??
          (output?.name
            ? parseResourceName(
                output.name.replace(
                  /\/feedbackMessage\//,
                  "/feedbackMessages/",
                ),
                "feedbackMessages",
              ).id
            : "");
        const name =
          output?.name ??
          (parent.length > 0 && feedbackMessageId.length > 0
            ? resourceNameOf(parent, feedbackMessageId)
            : "");
        const existing =
          (yield* getByName(name)) ?? (yield* findByOwnership(id, env.project));
        if (existing === undefined) return undefined;
        const attrs = toAttrs(existing, env.project);
        return (yield* ownedByAlchemy(id, existing.body))
          ? attrs
          : Unowned(attrs);
      }),

      list: () =>
        Effect.gen(function* () {
          const env = yield* GcpEnvironment.current;
          const rows = yield* listAllFeedbackMessages(env.project);
          return rows
            .filter((row) => hasOwnershipMarker(row.body))
            .map((row) => toAttrs(row, env.project));
        }),

      reconcile: Effect.fn(function* ({ id, news, output }) {
        const env = yield* GcpEnvironment.current;
        const parent = expandParent(news.parent, env.project);
        const feedbackMessageId =
          news.feedbackMessageId ?? output?.feedbackMessageId;
        const name =
          output?.name ??
          (feedbackMessageId !== undefined
            ? resourceNameOf(parent, feedbackMessageId)
            : "");
        const ownership = yield* createInternalLabels(id);
        const body = encodeOwnership(
          ownership,
          news.body,
          MAX_FEEDBACK_BODY_LENGTH,
        );

        let current =
          (yield* getByName(name)) ?? (yield* findByOwnership(id, env.project));

        if (current === undefined) {
          const created = yield* retryTransient(
            datalabeling.createProjectsDatasetsAnnotatedDatasetsFeedbackThreadsFeedbackMessages(
              {
                parent,
                body: {
                  body,
                  image: news.image,
                  requesterFeedbackMetadata: {},
                },
              },
            ),
          ).pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
          if (created !== undefined) {
            const done = yield* waitForOperation(created);
            const createdName = resourceNameFromOperation(done);
            if (createdName !== undefined) {
              current = yield* waitForVisible(getByName(createdName));
            }
          }
          if (current === undefined) {
            current = yield* findByOwnership(id, env.project);
          }
        }

        if (current === undefined) {
          return yield* new DatasetsAnnotatedDatasetsFeedbackThreadsFeedbackMessageNotResolved(
            { name: name || parent },
          );
        }

        return toAttrs(current, env.project);
      }),

      delete: Effect.fn(function* ({ output }) {
        if (!output.name) return;
        yield* ignoreGone(
          retryDelete(
            datalabeling.deleteProjectsDatasetsAnnotatedDatasetsFeedbackThreadsFeedbackMessages(
              { name: output.name },
            ),
          ),
        );
        yield* waitUntilGone(getByName(output.name));
      }),
    });
