import * as cloudasset from "@distilled.cloud/gcp/cloudasset_v1";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { alchemyLabelKeys, hasAlchemyLabels } from "../Labels.ts";

export const MAX_ID_LENGTH = 63;
export const MAX_SAVED_QUERY_DESCRIPTION = 255;
export const NO_OP_EXPRESSION = "true";
export const PUBLISHER_ROLE = "roles/pubsub.publisher";

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const parentOf = (name: string, collection: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const at = parts.lastIndexOf(collection);
  return at > 0 ? parts.slice(0, at).join("/") : parts.slice(0, -1).join("/");
};

export const projectParent = (project: string) => `projects/${project}`;

/** Cloud Asset get/delete names require a numeric project, folder, or org. */
export const scopeParent = (project: string, explicit?: string) =>
  Effect.gen(function* () {
    if (explicit !== undefined && explicit.length > 0) {
      if (!explicit.startsWith("projects/"))
        return explicit.replace(/\/+$/, "");
      const id = lastSegment(explicit);
      if (/^\d+$/.test(id)) return `projects/${id}`;
      const number = yield* projectNumberOf(id);
      return `projects/${number}`;
    }
    const number = yield* projectNumberOf(project);
    return `projects/${number}`;
  });

export const rfc1035 = (name: string, maxLength = MAX_ID_LENGTH): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `a${next}`;
  next = next.slice(0, maxLength).replace(/-+$/g, "");
  if (next.length < 4) next = `${next}feed`.slice(0, maxLength);
  if (next.length === 0) return "feed";
  if (!/[a-z0-9]$/.test(next)) next = `${next.slice(0, maxLength - 1)}0`;
  return next.slice(0, maxLength);
};

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  maxLength = MAX_ID_LENGTH,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return rfc1035(explicit, maxLength);
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({ id, maxLength, lowercase: true }),
      maxLength,
    );
  });

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const sortedStrings = (values: readonly string[] | undefined) =>
  [...(values ?? [])].slice().sort();

export const sameStringList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) =>
  JSON.stringify(sortedStrings(left)) === JSON.stringify(sortedStrings(right));

const canonical = (value: unknown): unknown => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.length === 0 ? undefined : value;
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

export const sameJson = (left: unknown, right: unknown) =>
  JSON.stringify(canonical(left) ?? null) ===
  JSON.stringify(canonical(right) ?? null);

export const updateMaskOf = (...fields: Array<string | undefined>) =>
  fields.filter((field): field is string => field !== undefined).join(",");

export const encodeDescription = (
  labels: Record<string, string>,
  description: string | undefined,
  maxLength?: number,
): string => {
  const marker = `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;
  const combined =
    description && description.length > 0
      ? `${marker}\n${description}`
      : marker;
  return maxLength !== undefined ? combined.slice(0, maxLength) : combined;
};

export const parseDescription = (
  description: string | undefined,
): {
  labels: Record<string, string>;
  description: string | undefined;
} => {
  if (!description?.startsWith("[alchemy ")) {
    return { labels: {}, description };
  }
  const end = description.indexOf("]");
  if (end < 0) return { labels: {}, description };
  const labels: Record<string, string> = {};
  for (const part of description.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = description.slice(end + 1).replace(/^\n/, "");
  return { labels, description: rest.length > 0 ? rest : undefined };
};

export const hasOwnershipMarker = (description: string | undefined) =>
  Object.keys(parseDescription(description).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

export const ownedByAlchemy = (id: string, description: string | undefined) =>
  Effect.gen(function* () {
    const { labels } = parseDescription(description);
    return yield* hasAlchemyLabels(id, labels);
  });

export const replaceOn = (
  previous: string | undefined,
  next: string | undefined,
) =>
  previous !== undefined && next !== undefined && previous !== next
    ? ({ action: "replace" as const, deleteFirst: false } as const)
    : undefined;

export const collectPages = <Page, A, E, R>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly A[] | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

export const topicResource = (topic: string, project: string) =>
  topic.includes("/") ? topic : `projects/${project}/topics/${topic}`;

export const projectNumberOf = (project: string) =>
  resourcemanager.getProjects({ name: `projects/${project}` }).pipe(
    Effect.map((resource) => {
      const number = lastSegment(resource.name ?? "");
      return /^\d+$/.test(number) ? number : project;
    }),
  );

export const grantCloudAssetPublisher = (project: string, topic: string) =>
  Effect.gen(function* () {
    const resource = topicResource(topic, project);
    const projectNumber = yield* projectNumberOf(project);
    const member = `serviceAccount:service-${projectNumber}@gcp-sa-cloudasset.iam.gserviceaccount.com`;
    const policy = yield* pubsub.getIamPolicyProjectsTopics({ resource });
    const bindings = (policy.bindings ?? []).map((binding) => ({
      ...binding,
      members: [...(binding.members ?? [])],
    }));
    const publisher = bindings.find(
      (binding) => binding.role === PUBLISHER_ROLE,
    );
    if (publisher?.members?.includes(member)) return;
    if (publisher) {
      publisher.members = [...(publisher.members ?? []), member];
    } else {
      bindings.push({ role: PUBLISHER_ROLE, members: [member] });
    }
    yield* pubsub.setIamPolicyProjectsTopics({
      resource,
      body: { policy: { ...policy, bindings } },
    });
  }).pipe(
    Effect.retry({
      while: (error) => error._tag === "Conflict",
      times: 5,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

/** `feeds.list` is unpaginated: it returns every feed under the parent. */
export const listFeeds = (parent: string) =>
  cloudasset.listFeeds({ parent }).pipe(Effect.map((page) => page.feeds ?? []));

export const listSavedQueries = (parent: string) =>
  collectPages(
    cloudasset.listSavedQueries.pages({ parent, pageSize: 100 }),
    (page) => page.savedQueries,
  );
