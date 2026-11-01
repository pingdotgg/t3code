import * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import * as we from "@distilled.cloud/gcp/workspaceevents_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
  sanitizeLabelValue,
} from "../Labels.ts";
import { waitForOperation as waitForGcpOperation } from "../Operation.ts";

export const SUBSCRIPTION_PREFIX = "subscriptions/";
export const TASK_PREFIX = "tasks/";
export const CONFIG_COLLECTION = "pushNotificationConfigs";
export const MAX_CONFIG_ID_LENGTH = 63;
export const MAX_TOPIC_ID_LENGTH = 255;
export const MAX_TOKEN_LENGTH = 8000;

export const WESUB_LABEL_KEYS = {
  stack: "alchemy-wesub-stack",
  stage: "alchemy-wesub-stage",
  id: "alchemy-wesub-id",
} as const;

export const LIST_EVENT_TYPES = [
  "google.workspace.chat.message.v1.created",
  "google.workspace.chat.message.v1.updated",
  "google.workspace.chat.message.v1.deleted",
  "google.workspace.chat.membership.v1.created",
  "google.workspace.chat.membership.v1.updated",
  "google.workspace.chat.membership.v1.deleted",
  "google.workspace.chat.reaction.v1.created",
  "google.workspace.chat.reaction.v1.deleted",
  "google.workspace.chat.space.v1.updated",
  "google.workspace.chat.space.v1.deleted",
  "google.workspace.meet.conference.v2.started",
  "google.workspace.meet.conference.v2.ended",
  "google.workspace.meet.participant.v2.joined",
  "google.workspace.meet.participant.v2.left",
  "google.workspace.meet.recording.v2.fileGenerated",
  "google.workspace.meet.transcript.v2.fileGenerated",
  "google.workspace.drive.file.v3.created",
  "google.workspace.drive.file.v3.updated",
  "google.workspace.drive.file.v3.deleted",
] as const;

export class ResourceNotResolved extends Data.TaggedError(
  "GCP.WorkspaceEvents.ResourceNotResolved",
)<{
  name: string;
}> {}

export class ResourceStillExists extends Data.TaggedError(
  "GCP.WorkspaceEvents.ResourceStillExists",
)<{
  name: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const sameBoolean = (
  left: boolean | undefined,
  right: boolean | undefined,
) => (left ?? false) === (right ?? false);

export const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const sortedStrings = (values: readonly string[] | undefined) =>
  [...(values ?? [])].slice().sort();

export const updateMaskOf = (...fields: Array<string | undefined>) =>
  fields.filter((field): field is string => field !== undefined).join(",");

export const rfc1035 = (
  name: string,
  fallback = "config",
  maxLength = MAX_CONFIG_ID_LENGTH,
): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!/^[a-z]/.test(next)) next = `w${next}`;
  next = next.slice(0, maxLength).replace(/-+$/, "");
  if (next.length === 0) return fallback;
  if (!/[a-z0-9]$/.test(next)) {
    next = `${next.slice(0, maxLength - 1)}0`;
  }
  return next.slice(0, maxLength);
};

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  fallback: string,
  maxLength: number,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined && explicit.length > 0) {
      return rfc1035(explicit, fallback, maxLength);
    }
    if (existing !== undefined && existing.length > 0) {
      return existing;
    }
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength,
        lowercase: true,
      }),
      fallback,
      maxLength,
    );
  });

export const wesubLabels = (id: string) =>
  Effect.gen(function* () {
    const internal = yield* createInternalLabels(id);
    const labels: Record<string, string> = {
      [WESUB_LABEL_KEYS.stack]:
        internal[alchemyLabelKeys.stack] ?? sanitizeLabelValue("x"),
      [WESUB_LABEL_KEYS.stage]:
        internal[alchemyLabelKeys.stage] ?? sanitizeLabelValue("x"),
      [WESUB_LABEL_KEYS.id]:
        internal[alchemyLabelKeys.id] ?? sanitizeLabelValue("x"),
    };
    return labels;
  });

export const hasWesubLabels = (
  labels: Record<string, string | undefined> | null | undefined,
) =>
  Object.keys(labels ?? {}).some(
    (key) => key.startsWith("alchemy-wesub-") || key.startsWith("alchemy-"),
  );

const prefixMatch = (expected: string, observed: string) =>
  expected === observed ||
  expected.startsWith(observed) ||
  observed.startsWith(expected);

export const ownedByWesubLabels = (
  id: string,
  labels: Record<string, string | undefined> | null | undefined,
) =>
  Effect.gen(function* () {
    const expected = yield* wesubLabels(id);
    const observed = tagRecord(labels);
    if (!hasWesubLabels(observed)) return false;
    const exact =
      observed[WESUB_LABEL_KEYS.stack] === expected[WESUB_LABEL_KEYS.stack] &&
      observed[WESUB_LABEL_KEYS.stage] === expected[WESUB_LABEL_KEYS.stage] &&
      observed[WESUB_LABEL_KEYS.id] === expected[WESUB_LABEL_KEYS.id];
    if (exact) return true;
    return (
      prefixMatch(
        expected[WESUB_LABEL_KEYS.stack] ?? "",
        observed[WESUB_LABEL_KEYS.stack] ?? "",
      ) &&
      prefixMatch(
        expected[WESUB_LABEL_KEYS.stage] ?? "",
        observed[WESUB_LABEL_KEYS.stage] ?? "",
      ) &&
      prefixMatch(
        expected[WESUB_LABEL_KEYS.id] ?? "",
        observed[WESUB_LABEL_KEYS.id] ?? "",
      )
    );
  });

export const toSubscriptionName = (value: string) => {
  if (value.length === 0) return value;
  return value.startsWith(SUBSCRIPTION_PREFIX)
    ? value
    : `${SUBSCRIPTION_PREFIX}${value}`;
};

export const subscriptionIdOf = (name: string) =>
  name.startsWith(SUBSCRIPTION_PREFIX)
    ? name.slice(SUBSCRIPTION_PREFIX.length)
    : lastSegment(name);

export const toTaskName = (value: string) => {
  if (value.length === 0) return value;
  return value.startsWith(TASK_PREFIX) ? value : `${TASK_PREFIX}${value}`;
};

export const taskIdOf = (name: string) =>
  name.startsWith(TASK_PREFIX)
    ? name.slice(TASK_PREFIX.length)
    : lastSegment(name);

export const toConfigName = (task: string, configId: string) =>
  `${toTaskName(task)}/${CONFIG_COLLECTION}/${configId}`;

export const configIdOf = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const at = parts.lastIndexOf(CONFIG_COLLECTION);
  return at >= 0 && parts[at + 1] ? parts[at + 1]! : lastSegment(name);
};

export const parentOfConfig = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const at = parts.lastIndexOf(CONFIG_COLLECTION);
  return at > 0 ? parts.slice(0, at).join("/") : toTaskName(lastSegment(name));
};

export const expandTopic = (value: string, project: string) => {
  const trimmed = value.replace(/\/+$/, "");
  if (trimmed.includes("/topics/")) return trimmed;
  return `projects/${project}/topics/${lastSegment(trimmed)}`;
};

export const listFilter = (
  eventTypes: readonly string[],
  targetResource?: string,
) => {
  const events = eventTypes.map((type) => `event_types:"${type}"`).join(" OR ");
  if (targetResource !== undefined && targetResource.length > 0) {
    return `(${events}) AND target_resource="${targetResource}"`;
  }
  return events;
};

export const catchMissing = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.catchIf(
      (error): error is E & { readonly _tag: "NotFound" } =>
        error._tag === "NotFound",
      () => Effect.succeed(undefined),
    ),
  );

export const ignoreMissing = <E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<unknown, E, R>,
) =>
  effect.pipe(
    Effect.catchIf(
      (error): error is E & { readonly _tag: "NotFound" } =>
        error._tag === "NotFound",
      () => Effect.void,
    ),
  );

export const getSubscription = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(we.getSubscriptions({ name: toSubscriptionName(name) }));

export const getConfig = (name: string, tenant?: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(
        we.getTasksPushNotificationConfigs({
          name,
          tenant,
        }),
      );

export const getTopic = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : pubsub
        .getProjectsTopics({ topic: name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const ensureTopic = (name: string, labels: Record<string, string>) =>
  Effect.gen(function* () {
    let current = yield* getTopic(name);
    if (current === undefined) {
      const created = yield* pubsub
        .createProjectsTopics({
          name,
          body: { labels },
        })
        .pipe(Effect.catchTag("Conflict", () => getTopic(name)));
      current = created ?? undefined;
    }
    if (current === undefined) return undefined;
    const observed = tagRecord(current.labels);
    const desired = { ...observed, ...labels };
    const changed = Object.entries(desired).some(
      ([key, value]) => observed[key] !== value,
    );
    if (!changed) return current;
    return yield* pubsub
      .patchProjectsTopics({
        name,
        body: {
          topic: { name, labels: desired },
          updateMask: "labels",
        },
      })
      .pipe(
        Effect.catchTag(["NotFound", "Conflict"], () =>
          Effect.succeed(current),
        ),
      );
  });

export const stringField = (
  value: unknown,
  key: string,
): string | undefined => {
  if (value === null || value === undefined || typeof value !== "object") {
    return undefined;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
};

export const operationResourceName = (operation: we.Operation) =>
  stringField(operation.response, "name") ??
  stringField(operation.metadata, "name");

/**
 * Wait for a Workspace Events long-running operation (subscription create/update/delete).
 */
export const waitForOperation = (operation: we.Operation) =>
  Effect.gen(function* () {
    yield* waitForGcpOperation(
      operation,
      (name) => we.getOperations({ name }),
      { budget: "10 minutes" },
    );
    // Return the finished operation so callers can read its `response`.
    if (operation.done === true || !operation.name) return operation;
    return yield* we.getOperations({ name: operation.name });
  });

export const waitUntilExists = <A, E, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
): Effect.Effect<NonNullable<A>, E | ResourceNotResolved, R> =>
  get.pipe(
    Effect.filterOrFail(
      (value): value is NonNullable<A> => value != null,
      () => new ResourceNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) => error instanceof ResourceNotResolved,
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const waitUntilGone = <A, E, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
): Effect.Effect<void, E | ResourceStillExists, R> =>
  get.pipe(
    Effect.filterOrFail(
      (value) => value === undefined,
      () => new ResourceStillExists({ name }),
    ),
    Effect.retry({
      while: (error) => error instanceof ResourceStillExists,
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
    Effect.asVoid,
  );

export const collectPages = <Page, A, E, R>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly A[] | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

export const listSubscriptions = (filter: string) =>
  collectPages(
    we.listSubscriptions.pages({
      filter,
      pageSize: 100,
    }),
    (page) => page.subscriptions,
  ).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed([] as we.Subscription[])),
  );

export const listOwnedSubscriptions = () =>
  Effect.gen(function* () {
    const found = new Map<string, we.Subscription>();
    const chunkSize = 6;
    for (let index = 0; index < LIST_EVENT_TYPES.length; index += chunkSize) {
      const chunk = LIST_EVENT_TYPES.slice(index, index + chunkSize);
      const page = yield* listSubscriptions(listFilter(chunk));
      for (const subscription of page) {
        const name = subscription.name;
        if (name !== undefined && name.length > 0) {
          found.set(name, subscription);
        }
      }
    }
    const owned: we.Subscription[] = [];
    for (const subscription of found.values()) {
      const topic = subscription.notificationEndpoint?.pubsubTopic;
      if (topic === undefined || topic.length === 0) continue;
      const observed = yield* getTopic(topic);
      if (hasWesubLabels(observed?.labels)) {
        owned.push(subscription);
      }
    }
    return owned;
  });

export const findSubscription = (
  name: string,
  eventTypes: readonly string[],
  targetResource: string | undefined,
) =>
  Effect.gen(function* () {
    const existing = yield* getSubscription(name);
    if (existing !== undefined) return existing;
    if (eventTypes.length === 0) return undefined;
    const listed = yield* listSubscriptions(
      listFilter(eventTypes, targetResource),
    );
    return listed[0];
  });

export const listConfigs = (parent: string, tenant?: string) =>
  collectPages(
    we.listTasksPushNotificationConfigs.pages({
      parent,
      tenant,
      pageSize: 100,
    }),
    (page) => page.configs,
  ).pipe(
    Effect.catchTag("NotFound", () =>
      Effect.succeed([] as we.TaskPushNotificationConfig[]),
    ),
  );
