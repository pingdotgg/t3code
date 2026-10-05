import * as datalabeling from "@distilled.cloud/gcp/datalabeling_v1beta1";
import { Retry as GcpRetry } from "@distilled.cloud/gcp/Retry";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";
import { isTransientGcpError } from "../Errors.ts";

/**
 * Data Labeling is shut down. The frontend hangs ~20s then returns HTTP
 * 502 (`BadGateway`), which distilled retries as transient. Disable that
 * retry so list/get/create fail in one round trip instead of eight.
 */
export const noRetryLayer = Layer.succeed(GcpRetry, {
  while: () => false,
});

export const MAX_DISPLAY_NAME_LENGTH = 64;
export const MAX_DESCRIPTION_LENGTH = 10_000;
export const MAX_EVALUATION_DESCRIPTION_LENGTH = 25_000;
export const MAX_FEEDBACK_BODY_LENGTH = 10_000;

export class DatalabelingPending extends Data.TaggedError(
  "GCP.DataLabeling.Pending",
)<{
  name: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const parentOf = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  return parts.slice(0, -2).join("/");
};

export const projectParent = (project: string) => `projects/${project}`;

export const parseResourceName = (name: string, collection: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const collectionAt = parts.lastIndexOf(collection);
  const projectsAt = parts.lastIndexOf("projects");
  const datasetsAt = parts.lastIndexOf("datasets");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    datasetId:
      datasetsAt >= 0 && parts[datasetsAt + 1] ? parts[datasetsAt + 1]! : "",
    dataset:
      datasetsAt >= 0
        ? parts.slice(0, datasetsAt + 2).join("/")
        : parentOf(name),
    id:
      collectionAt >= 0 && parts[collectionAt + 1]
        ? parts[collectionAt + 1]!
        : lastSegment(name),
    parent:
      collectionAt > 0
        ? parts.slice(0, collectionAt).join("/")
        : parts.slice(0, Math.max(0, parts.length - 1)).join("/"),
  };
};

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const canonical = (value: unknown): unknown => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    return value.length === 0 ? undefined : value;
  }
  if (Array.isArray(value)) {
    const items = value.map(canonical).filter((item) => item !== undefined);
    return items.length === 0 ? undefined : items;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, canonical(item)] as const)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    if (entries.length === 0) return undefined;
    return Object.fromEntries(entries);
  }
  return undefined;
};

export const fingerprint = (value: unknown): string =>
  JSON.stringify(canonical(value) ?? null);

export const sameJson = (left: unknown, right: unknown) =>
  fingerprint(left) === fingerprint(right);

export const updateMaskOf = (...fields: Array<string | undefined>) =>
  fields.filter((field): field is string => field !== undefined).join(",");

export const toDisplayName = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  maxLength = MAX_DISPLAY_NAME_LENGTH,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength,
      lowercase: true,
    });
    const next = /^[a-z]/.test(generated)
      ? generated
      : `d${generated}`.slice(0, maxLength);
    return next.length > 0 ? next : "d";
  });

const markerOf = (
  labels: Record<string, string>,
  stack: string,
  stage: string,
  id: string,
) =>
  `[alchemy ${alchemyLabelKeys.stack}=${stack} ${alchemyLabelKeys.stage}=${stage} ${alchemyLabelKeys.id}=${id}]`;

const shrinkMarker = (labels: Record<string, string>, maxLength: number) => {
  let stack = labels[alchemyLabelKeys.stack] ?? "x";
  let stage = labels[alchemyLabelKeys.stage] ?? "x";
  let id = labels[alchemyLabelKeys.id] ?? "x";
  let marker = markerOf(labels, stack, stage, id);
  while (
    marker.length > maxLength &&
    (stack.length > 1 || stage.length > 1 || id.length > 1)
  ) {
    if (stack.length >= stage.length && stack.length >= id.length) {
      stack = stack.slice(0, -1);
    } else if (stage.length >= id.length) {
      stage = stage.slice(0, -1);
    } else {
      id = id.slice(0, -1);
    }
    marker = markerOf(labels, stack, stage, id);
  }
  return marker.slice(0, maxLength);
};

export const encodeOwnership = (
  labels: Record<string, string>,
  text: string | undefined,
  maxLength = MAX_DESCRIPTION_LENGTH,
): string => {
  const marker = shrinkMarker(labels, maxLength);
  const trimmed = text?.trim();
  if (!trimmed) return marker;
  return `${marker}\n${trimmed}`.slice(0, maxLength);
};

export const parseOwnership = (
  text: string | undefined,
): {
  labels: Record<string, string>;
  text: string | undefined;
} => {
  if (!text?.startsWith("[alchemy ")) {
    return { labels: {}, text };
  }
  const end = text.indexOf("]");
  if (end < 0) return { labels: {}, text };
  const labels: Record<string, string> = {};
  for (const part of text.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = text.slice(end + 1).replace(/^[\s\n]+/, "");
  return { labels, text: rest.length > 0 ? rest : undefined };
};

export const hasOwnershipMarker = (text: string | undefined) =>
  Object.keys(parseOwnership(text).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const prefixMatch = (expected: string, observed: string) =>
  expected === observed ||
  expected.startsWith(observed) ||
  observed.startsWith(expected);

export const ownedByAlchemy = (id: string, text: string | undefined) =>
  Effect.gen(function* () {
    const expected = yield* createInternalLabels(id);
    const { labels } = parseOwnership(text);
    if (!hasOwnershipMarker(text)) return false;
    const exact = yield* hasAlchemyLabels(id, labels);
    if (exact) return true;
    return (
      prefixMatch(
        expected[alchemyLabelKeys.stack] ?? "",
        labels[alchemyLabelKeys.stack] ?? "",
      ) &&
      prefixMatch(
        expected[alchemyLabelKeys.stage] ?? "",
        labels[alchemyLabelKeys.stage] ?? "",
      ) &&
      prefixMatch(
        expected[alchemyLabelKeys.id] ?? "",
        labels[alchemyLabelKeys.id] ?? "",
      )
    );
  });

export const replaceOnIdentity = (input: {
  previousId?: string;
  nextId?: string;
  previousParent?: string;
  nextParent?: string;
  extra?: boolean;
}) => {
  if (input.extra === true) {
    return { action: "replace" as const, deleteFirst: false };
  }
  if (
    input.previousId !== undefined &&
    input.nextId !== undefined &&
    input.previousId !== input.nextId
  ) {
    return { action: "replace" as const, deleteFirst: false };
  }
  if (
    input.previousParent !== undefined &&
    input.nextParent !== undefined &&
    input.previousParent !== input.nextParent
  ) {
    return { action: "replace" as const, deleteFirst: false };
  }
  return undefined;
};

export const retryTransient = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.provide(noRetryLayer),
    Effect.retry({
      while: isTransientGcpError,
      times: 8,
      schedule: Schedule.exponential("250 millis"),
    }),
  );

export const retryDelete = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.provide(noRetryLayer),
    Effect.retry({
      while: (error) => error._tag === "Conflict" || isTransientGcpError(error),
      times: 8,
      schedule: Schedule.exponential("250 millis"),
    }),
  );

const isGone = <E extends { readonly _tag: string }>(
  error: E,
): error is E & { readonly _tag: "NotFound" | "BadGateway" } =>
  error._tag === "NotFound" || error._tag === "BadGateway";

/** A missing parent (NotFound) has no children. */
const isMissingList = <E extends { readonly _tag: string }>(
  error: E,
): error is E & { readonly _tag: "NotFound" } => error._tag === "NotFound";

export const ignoreGone = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) => effect.pipe(Effect.catchIf(isGone, () => Effect.void));

export class DeleteNotConfirmed extends Data.TaggedError(
  "GCP.DataLabeling.DeleteNotConfirmed",
)<{}> {}

/** Poll until the resource is gone; fails if it is still readable after ~60s. */
export const waitUntilGone = <A, E, R>(
  get: Effect.Effect<A | undefined, E, R>,
) =>
  get.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (value) => value === undefined,
      times: 30,
    }),
    Effect.flatMap((value): Effect.Effect<void, DeleteNotConfirmed> =>
      value === undefined ? Effect.void : Effect.fail(new DeleteNotConfirmed()),
    ),
  );

export const waitForVisible = <A, E, R>(
  get: Effect.Effect<A | undefined, E, R>,
) =>
  get.pipe(
    Effect.filterOrFail(
      (value): value is A => value !== undefined,
      () => new DatalabelingPending({ name: "" }),
    ),
    Effect.retry({
      while: (error) => error instanceof DatalabelingPending,
      times: 8,
      schedule: Schedule.exponential("250 millis"),
    }),
    Effect.catchIf(
      (error): error is DatalabelingPending =>
        error instanceof DatalabelingPending,
      () => Effect.succeed(undefined),
    ),
  );

const emptyList = <A>() => Effect.succeed<A[]>([]);

export const collectPages = <
  Page,
  Item,
  E extends { readonly _tag: string },
  R,
>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly Item[] | null | undefined,
) =>
  pages.pipe(
    Stream.provide(noRetryLayer),
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk) as Item[]),
    Effect.provide(noRetryLayer),
    Effect.catchIf(isMissingList, () => emptyList<Item>()),
  );

export const listAnnotationSpecSets = (parent: string) =>
  parent.length === 0
    ? emptyList<datalabeling.GoogleCloudDatalabelingV1beta1AnnotationSpecSet>()
    : collectPages(
        datalabeling.listProjectsAnnotationSpecSets.pages({
          parent,
          pageSize: 100,
        }),
        (page) => page.annotationSpecSets,
      );

export const listDatasets = (parent: string) =>
  parent.length === 0
    ? emptyList<datalabeling.GoogleCloudDatalabelingV1beta1Dataset>()
    : collectPages(
        datalabeling.listProjectsDatasets.pages({ parent, pageSize: 100 }),
        (page) => page.datasets,
      );

export const listInstructions = (parent: string) =>
  parent.length === 0
    ? emptyList<datalabeling.GoogleCloudDatalabelingV1beta1Instruction>()
    : collectPages(
        datalabeling.listProjectsInstructions.pages({ parent, pageSize: 100 }),
        (page) => page.instructions,
      );

export const listEvaluationJobs = (parent: string) =>
  parent.length === 0
    ? emptyList<datalabeling.GoogleCloudDatalabelingV1beta1EvaluationJob>()
    : collectPages(
        datalabeling.listProjectsEvaluationJobs.pages({
          parent,
          pageSize: 100,
        }),
        (page) => page.evaluationJobs,
      );

export const listAnnotatedDatasets = (parent: string) =>
  parent.length === 0
    ? emptyList<datalabeling.GoogleCloudDatalabelingV1beta1AnnotatedDataset>()
    : collectPages(
        datalabeling.listProjectsDatasetsAnnotatedDatasets.pages({
          parent,
          pageSize: 100,
        }),
        (page) => page.annotatedDatasets,
      );

export const listFeedbackThreads = (parent: string) =>
  parent.length === 0
    ? emptyList<datalabeling.GoogleCloudDatalabelingV1beta1FeedbackThread>()
    : collectPages(
        datalabeling.listProjectsDatasetsAnnotatedDatasetsFeedbackThreads.pages(
          {
            parent,
            pageSize: 100,
          },
        ),
        (page) => page.feedbackThreads,
      );

export const listFeedbackMessages = (parent: string) =>
  parent.length === 0
    ? emptyList<datalabeling.GoogleCloudDatalabelingV1beta1FeedbackMessage>()
    : collectPages(
        datalabeling.listProjectsDatasetsAnnotatedDatasetsFeedbackThreadsFeedbackMessages.pages(
          {
            parent,
            pageSize: 100,
          },
        ),
        (page) => page.feedbackMessages,
      );

export const listAllFeedbackMessages = (project: string) =>
  Effect.gen(function* () {
    const datasets = yield* listDatasets(projectParent(project));
    const namedDatasets = datasets.filter(
      (
        dataset,
      ): dataset is datalabeling.GoogleCloudDatalabelingV1beta1Dataset & {
        name: string;
      } => typeof dataset.name === "string" && dataset.name.length > 0,
    );
    const groups = yield* Effect.forEach(
      namedDatasets,
      (dataset) =>
        Effect.gen(function* () {
          const annotated = yield* listAnnotatedDatasets(dataset.name);
          const namedAnnotated = annotated.filter(
            (
              row,
            ): row is datalabeling.GoogleCloudDatalabelingV1beta1AnnotatedDataset & {
              name: string;
            } => typeof row.name === "string" && row.name.length > 0,
          );
          const threadGroups = yield* Effect.forEach(
            namedAnnotated,
            (annotatedDataset) =>
              Effect.gen(function* () {
                const threads = yield* listFeedbackThreads(
                  annotatedDataset.name,
                );
                const namedThreads = threads.filter(
                  (
                    thread,
                  ): thread is datalabeling.GoogleCloudDatalabelingV1beta1FeedbackThread & {
                    name: string;
                  } =>
                    typeof thread.name === "string" && thread.name.length > 0,
                );
                const messages = yield* Effect.forEach(
                  namedThreads,
                  (thread) => listFeedbackMessages(thread.name),
                  { concurrency: 4 },
                );
                return messages.flat();
              }),
            { concurrency: 4 },
          );
          return threadGroups.flat();
        }),
      { concurrency: 4 },
    );
    return groups.flat();
  });

export const findOwned = <A>(
  id: string,
  items: readonly A[],
  textOf: (item: A) => string | undefined,
) =>
  Effect.gen(function* () {
    for (const item of items) {
      if (yield* ownedByAlchemy(id, textOf(item))) {
        return item;
      }
    }
    return undefined;
  });
