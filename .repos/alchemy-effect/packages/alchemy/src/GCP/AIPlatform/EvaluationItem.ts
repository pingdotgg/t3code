import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels, toLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { waitForOperation } from "./operations.ts";
import {
  hasAlchemyLabelMap,
  normalizeLocation,
  parseResourceName,
  toPhysicalRfc1035,
  userLabels,
} from "./helpers.ts";

const MAX_NAME_LENGTH = 63;

export type EvaluationItemProps = {
  /**
   * Evaluation item id (the `{evaluation_item}` segment). Assigned by
   * Vertex on create. Provide to target an existing item.
   */
  evaluationItemId?: string;
  /**
   * Region. Immutable — changing it replaces the item.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Display name. Defaults to a generated id when omitted.
   */
  displayName?: string;
  /**
   * Item type (`REQUEST` or `RESULT`). Immutable.
   */
  evaluationItemType:
    | aiplatform.GoogleCloudAiplatformV1EvaluationItemEvaluationItemTypeEnum
    | (string & {});
  /**
   * Cloud Storage object holding the request or response.
   */
  gcsUri?: string;
  /**
   * Inlined evaluation request (prompt, golden response, candidates).
   */
  evaluationRequest?: aiplatform.GoogleCloudAiplatformV1EvaluationRequest;
  /**
   * Arbitrary caller metadata.
   */
  metadata?: unknown;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type EvaluationItem = Resource<
  "GCP.AIPlatform.EvaluationItem",
  EvaluationItemProps,
  {
    /** Full resource name. */
    name: string;
    /** Evaluation item id (last path segment). */
    evaluationItemId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** Item type. */
    evaluationItemType: string | undefined;
    /** GCS object URI, if set. */
    gcsUri: string | undefined;
    /** Inlined evaluation request, if set. */
    evaluationRequest:
      | aiplatform.GoogleCloudAiplatformV1EvaluationRequest
      | undefined;
    /** Evaluation result (RESULT items). */
    evaluationResponse:
      | aiplatform.GoogleCloudAiplatformV1EvaluationResult
      | undefined;
    /** Caller metadata. */
    metadata: unknown;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Error, if any. */
    error: aiplatform.GoogleRpcStatus | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Vertex AI Evaluation Item — one request or result row used by
 * Evaluation Sets and Evaluation Runs.
 *
 * Vertex assigns the resource id. There is no update API: changing type,
 * location, display name, request, or GCS URI replaces the item. Labels
 * are stamped at create time.
 *
 * ### Creating an Evaluation Item
 * **Example:** Request item with an inlined prompt
 * ```typescript
 * const item = yield* GCP.AIPlatform.EvaluationItem("Prompt", {
 *   evaluationItemType: "REQUEST",
 *   evaluationRequest: { prompt: { text: "What is 2+2?" } },
 *   labels: { env: "test" },
 * });
 * ```
 *
 * @resource
 * @category AIPlatform
 */
export const EvaluationItem = Resource<EvaluationItem>(
  "GCP.AIPlatform.EvaluationItem",
);

export class EvaluationItemNotResolved extends Data.TaggedError(
  "GCP.AIPlatform.EvaluationItemNotResolved",
)<{
  name: string;
}> {}

export class EvaluationItemStillExists extends Data.TaggedError(
  "GCP.AIPlatform.EvaluationItemStillExists",
)<{
  name: string;
}> {}

const resourceName = (project: string, location: string, itemId: string) =>
  `projects/${project}/locations/${location}/evaluationItems/${itemId}`;

const toAttrs = (
  item: aiplatform.GoogleCloudAiplatformV1EvaluationItem,
  project: string,
) => {
  const name = item.name ?? "";
  const parsed = parseResourceName(name, "evaluationItems");
  return {
    name,
    evaluationItemId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: item.displayName,
    evaluationItemType: item.evaluationItemType,
    gcsUri: item.gcsUri,
    evaluationRequest: item.evaluationRequest,
    evaluationResponse: item.evaluationResponse,
    metadata: item.metadata,
    labels: userLabels(item.labels),
    error: item.error,
    createTime: item.createTime,
  };
};

const getByName = (name: string) =>
  aiplatform
    .getProjectsLocationsEvaluationItems({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, location = "-") =>
  aiplatform.listProjectsLocationsEvaluationItems
    .pages({
      parent: `projects/${project}/locations/${location}`,
      pageSize: 100,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.evaluationItems ?? [])),
      Stream.filter((item) => hasAlchemyLabelMap(item.labels)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const findOwned = (id: string, project: string, location?: string) =>
  Effect.gen(function* () {
    const items = yield* listOwned(project, location);
    for (const item of items) {
      if (yield* hasAlchemyLabels(id, tagRecord(item.labels))) {
        return item;
      }
    }
    return undefined;
  });

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((item) =>
      item === undefined
        ? Effect.void
        : Effect.fail(new EvaluationItemStillExists({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.AIPlatform.EvaluationItemStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const EvaluationItemProvider = () =>
  Provider.succeed(EvaluationItem, {
    stables: [
      "name",
      "evaluationItemId",
      "project",
      "location",
      "createTime",
      "evaluationItemType",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      const env = yield* GcpEnvironment.current;
      if (!isResolved(news)) return undefined;
      const previousId = olds?.evaluationItemId ?? output?.evaluationItemId;
      const nextId = news.evaluationItemId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const previousType =
        olds?.evaluationItemType ?? output?.evaluationItemType ?? "";
      const nextType = news.evaluationItemType ?? previousType;
      const previousDisplay = olds?.displayName ?? output?.displayName ?? "";
      const nextDisplay = news.displayName ?? previousDisplay;
      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        previousType !== nextType ||
        (news.displayName !== undefined && nextDisplay !== previousDisplay);
      if (!replace) return undefined;
      return { action: "replace" as const, deleteFirst: false };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const itemId = olds?.evaluationItemId ?? output?.evaluationItemId;
      const name =
        output?.name ??
        (itemId ? resourceName(env.project, location, itemId) : undefined);
      const existing = name
        ? yield* getByName(name)
        : yield* findOwned(id, env.project, location);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwned(env.project);
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const itemId = news.evaluationItemId ?? output?.evaluationItemId;
      const name =
        output?.name ??
        (itemId ? resourceName(env.project, location, itemId) : undefined);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const displayName =
        news.displayName ??
        (yield* toPhysicalRfc1035(id, undefined, undefined, MAX_NAME_LENGTH));

      let current = name
        ? yield* getByName(name)
        : yield* findOwned(id, env.project, location);

      if (current === undefined) {
        current = yield* aiplatform
          .createProjectsLocationsEvaluationItems({
            parent: `projects/${env.project}/locations/${location}`,
            body: {
              displayName,
              evaluationItemType: news.evaluationItemType,
              gcsUri: news.gcsUri,
              evaluationRequest: news.evaluationRequest,
              metadata: news.metadata,
              labels: desiredLabels,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findOwned(id, env.project, location),
            ),
          );
      }

      if (current === undefined) {
        return yield* new EvaluationItemNotResolved({
          name: name ?? displayName,
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* aiplatform
        .deleteProjectsLocationsEvaluationItems({ name: output.name })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("5 seconds"),
          }),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
