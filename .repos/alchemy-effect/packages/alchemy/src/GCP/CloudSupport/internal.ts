import * as cloudsupport from "@distilled.cloud/gcp/cloudsupport_v2";
import * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  hasAlchemyLabels,
  sanitizeLabelValue,
} from "../Labels.ts";

export const COLLECTION = "supportEventSubscriptions";
export const MAX_TOPIC_ID_LENGTH = 255;
export const PUBLISHER_ROLE = "roles/pubsub.publisher";
export const CLOUD_SUPPORT_EVENTS_MEMBER =
  "serviceAccount:cloud-support-apievents@system.gserviceaccount.com";

export class OrganizationRequired extends Data.TaggedError(
  "GCP.CloudSupport.OrganizationRequired",
)<{
  project: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const organizationParent = (value: string) =>
  value.startsWith("organizations/")
    ? value
    : `organizations/${lastSegment(value)}`;

export const parentOfName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const index = parts.lastIndexOf(COLLECTION);
  if (index <= 0) return "";
  return parts.slice(0, index).join("/");
};

export const subscriptionIdOf = (name: string) => lastSegment(name);

export const toSubscriptionName = (parent: string, value: string) => {
  if (value.length === 0) return "";
  if (value.includes(`/${COLLECTION}/`)) return value;
  if (parent.length === 0) return value;
  return `${parent}/${COLLECTION}/${lastSegment(value)}`;
};

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const isDeleted = (
  subscription: cloudsupport.SupportEventSubscription | undefined,
) => subscription?.state === "DELETED";

export const expandTopic = (value: string, project: string) => {
  const trimmed = value.replace(/\/+$/, "");
  if (trimmed.includes("/topics/")) return trimmed;
  return `projects/${project}/topics/${lastSegment(trimmed)}`;
};

export const sameTopic = (
  left: string | undefined,
  right: string | undefined,
) => {
  if (left === undefined || right === undefined) return left === right;
  return left === right || lastSegment(left) === lastSegment(right);
};

export const rfc1035 = (
  name: string,
  fallback = "topic",
  maxLength = MAX_TOPIC_ID_LENGTH,
): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!/^[a-z]/.test(next)) next = `t${next}`;
  next = next.slice(0, maxLength).replace(/-+$/, "");
  if (next.length < 3) {
    next = `${next}${fallback}`.slice(0, maxLength);
  }
  if (!/[a-z0-9]$/.test(next)) {
    next = `${next.slice(0, maxLength - 1)}0`;
  }
  return next.slice(0, maxLength);
};

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined && explicit.length > 0) {
      return rfc1035(explicit);
    }
    if (existing !== undefined && existing.length > 0) {
      return lastSegment(existing);
    }
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_TOPIC_ID_LENGTH,
        lowercase: true,
      }),
    );
  });

const emptyList = <A>() => Effect.succeed([] as A[]);

const parentOfResource = (name: string) =>
  name.startsWith("projects/")
    ? resourcemanager.getProjects({ name }).pipe(
        Effect.map((resource) => resource.parent),
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      )
    : name.startsWith("folders/")
      ? resourcemanager.getFolders({ name }).pipe(
          Effect.map((folder) => folder.parent),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        )
      : Effect.succeed(undefined);

export const tryResolveOrganization = () =>
  Effect.gen(function* () {
    const env = yield* GcpEnvironment.current;
    let current: string | undefined = `projects/${env.project}`;
    for (let i = 0; i < 8; i++) {
      if (current === undefined) return undefined;
      if (current.startsWith("organizations/")) return current;
      current = yield* parentOfResource(current);
    }
    return undefined;
  });

export const resolveOrganization = (
  explicit: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined && explicit.length > 0) {
      return organizationParent(explicit);
    }
    if (existing !== undefined && existing.length > 0) {
      return organizationParent(existing);
    }
    const resolved = yield* tryResolveOrganization();
    if (resolved === undefined) {
      const env = yield* GcpEnvironment.current;
      return yield* new OrganizationRequired({ project: env.project });
    }
    return resolved;
  });

export const listOrganizationParents = () =>
  Effect.gen(function* () {
    const resolved = yield* tryResolveOrganization();
    return resolved === undefined ? [] : [resolved];
  });

export const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : cloudsupport.getOrganizationsSupportEventSubscriptions({ name }).pipe(
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        Effect.map((subscription) =>
          isDeleted(subscription) ? undefined : subscription,
        ),
      );

export const getDeletedByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : cloudsupport
        .getOrganizationsSupportEventSubscriptions({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const getTopic = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : pubsub
        .getProjectsTopics({ topic: name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const grantCloudSupportPublisher = (topic: string) =>
  Effect.gen(function* () {
    if (topic.length === 0) return;
    const policy = yield* pubsub.getIamPolicyProjectsTopics({
      resource: topic,
    });
    const bindings = (policy.bindings ?? []).map((binding) => ({
      ...binding,
      members: [...(binding.members ?? [])],
    }));
    const publisher = bindings.find(
      (binding) => binding.role === PUBLISHER_ROLE,
    );
    if (publisher?.members?.includes(CLOUD_SUPPORT_EVENTS_MEMBER)) return;
    if (publisher) {
      publisher.members = [
        ...(publisher.members ?? []),
        CLOUD_SUPPORT_EVENTS_MEMBER,
      ];
    } else {
      bindings.push({
        role: PUBLISHER_ROLE,
        members: [CLOUD_SUPPORT_EVENTS_MEMBER],
      });
    }
    yield* pubsub.setIamPolicyProjectsTopics({
      resource: topic,
      body: { policy: { ...policy, bindings } },
    });
  }).pipe(
    Effect.retry({
      while: (error) => error._tag === "Conflict",
      times: 5,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

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
    if (changed) {
      current = yield* pubsub
        .patchProjectsTopics({
          name,
          body: {
            topic: { name, labels: desired },
            updateMask: "labels",
          },
        })
        .pipe(Effect.catchTag("Conflict", () => Effect.succeed(current)));
    }
    yield* grantCloudSupportPublisher(name);
    return current;
  });

export const deleteManagedTopic = (name: string | undefined) => {
  if (name === undefined || name.length === 0) return Effect.void;
  return pubsub
    .deleteProjectsTopics({ topic: name })
    .pipe(Effect.catchTag("NotFound", () => Effect.void));
};

export const ownershipLabels = (id: string) =>
  Effect.gen(function* () {
    const internal = yield* createInternalLabels(id);
    return {
      ...internal,
      "alchemy-cloudsupport": sanitizeLabelValue("subscription"),
    };
  });

export const hasOwnershipLabels = (
  labels: Record<string, string | undefined> | null | undefined,
) =>
  Object.keys(labels ?? {}).some(
    (key) =>
      key.startsWith("alchemy-cloudsupport") || key.startsWith("alchemy-"),
  );

export const ownedByTopicLabels = (
  id: string,
  labels: Record<string, string | undefined> | null | undefined,
) =>
  Effect.gen(function* () {
    if (!hasOwnershipLabels(labels)) return false;
    return yield* hasAlchemyLabels(id, tagRecord(labels));
  });

export const listSubscriptions = (
  parent: string,
  options?: { showDeleted?: boolean; filter?: string },
) =>
  parent.length === 0
    ? emptyList<cloudsupport.SupportEventSubscription>()
    : cloudsupport.listOrganizationsSupportEventSubscriptions
        .pages({
          parent,
          pageSize: 200,
          showDeleted: options?.showDeleted,
          filter: options?.filter,
        })
        .pipe(
          Stream.flatMap((page) =>
            Stream.fromIterable(page.supportEventSubscriptions ?? []),
          ),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.catchTag("NotFound", () =>
            emptyList<cloudsupport.SupportEventSubscription>(),
          ),
        );

export const listOwnedSubscriptions = (parent: string) =>
  Effect.gen(function* () {
    const subscriptions = yield* listSubscriptions(parent);
    const owned: cloudsupport.SupportEventSubscription[] = [];
    for (const subscription of subscriptions) {
      if (isDeleted(subscription)) continue;
      const topic = subscription.pubSubTopic;
      if (topic === undefined || topic.length === 0) continue;
      const observed = yield* getTopic(topic);
      if (hasOwnershipLabels(observed?.labels)) {
        owned.push(subscription);
      }
    }
    return owned;
  });

export const findOwnedSubscription = (
  parent: string,
  id: string,
  name: string | undefined,
  topicName: string | undefined,
) =>
  Effect.gen(function* () {
    const existing = yield* getByName(name ?? "");
    if (existing !== undefined) return existing;
    const deleted = yield* getDeletedByName(name ?? "");
    const listed = yield* listSubscriptions(parent, {
      showDeleted: true,
      filter:
        topicName !== undefined && topicName.length > 0
          ? `pub_sub_topic="${topicName}"`
          : undefined,
    });
    const candidates = [...(deleted !== undefined ? [deleted] : []), ...listed];
    const seen = new Set<string>();
    for (const subscription of candidates) {
      const key = subscription.name ?? "";
      if (key.length > 0) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      if (name !== undefined && name.length > 0 && subscription.name === name) {
        return subscription;
      }
      if (
        topicName !== undefined &&
        sameTopic(subscription.pubSubTopic, topicName)
      ) {
        const topic = yield* getTopic(subscription.pubSubTopic ?? "");
        if (yield* ownedByTopicLabels(id, topic?.labels)) {
          return subscription;
        }
      }
    }
    const all = yield* listSubscriptions(parent, { showDeleted: true });
    for (const subscription of all) {
      const topic = yield* getTopic(subscription.pubSubTopic ?? "");
      if (yield* ownedByTopicLabels(id, topic?.labels)) {
        return subscription;
      }
    }
    return undefined;
  });

export const undeleteSubscription = (name: string) =>
  cloudsupport
    .undeleteOrganizationsSupportEventSubscriptions({ name, body: {} })
    .pipe(
      // Already live or already gone: observe instead.
      Effect.catchTag(["NotFound", "Conflict"], () => getDeletedByName(name)),
    );
