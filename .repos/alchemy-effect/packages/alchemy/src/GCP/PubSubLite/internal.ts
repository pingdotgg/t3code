import * as pubsublite from "@distilled.cloud/gcp/pubsublite_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

// Zonal default is left fixed: zones are not derivable from `GcpEnvironment.region` without assuming a suffix.
export const DEFAULT_ZONE = "us-central1-a";
export const MAX_ID_LENGTH = 255;
export const DEFAULT_THROUGHPUT_CAPACITY = "4";
export const DEFAULT_PARTITION_COUNT = "1";
export const DEFAULT_PUBLISH_MIB = 4;
export const DEFAULT_SUBSCRIBE_MIB = 4;
/** 30 GiB — Pub/Sub Lite minimum storage per partition. */
export const DEFAULT_PER_PARTITION_BYTES = "32212254720";

export const LIST_LOCATIONS = [
  "us-central1",
  "us-central1-a",
  "us-central1-b",
  "us-central1-c",
  "us-central1-f",
] as const;

const OWNERSHIP_MARKER = "+alc.";

export class ResourceNotResolved extends Data.TaggedError(
  "GCP.PubSubLite.NotResolved",
)<{
  name: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const normalizeLocation = (
  location: string | undefined,
  fallback: string,
) => lastSegment(location ?? fallback).toLowerCase();

export const regionOf = (location: string) => {
  const parts = location.split("-").filter((part) => part.length > 0);
  const tail = parts[parts.length - 1] ?? "";
  if (/^[a-z]$/.test(tail) && parts.length > 1) {
    return parts.slice(0, -1).join("-");
  }
  return location;
};

export const parentOf = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

export const resourceName = (
  project: string,
  location: string,
  collection: string,
  id: string,
) => `${parentOf(project, location)}/${collection}/${id}`;

export const parseName = (name: string, collection: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const collectionAt = parts.lastIndexOf(collection);
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1] ? parts[locationsAt + 1]! : "",
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

export const expandName = (
  value: string,
  project: string,
  location: string,
  collection: string,
) => {
  const trimmed = value.replace(/\/+$/, "");
  if (trimmed.includes(`/${collection}/`)) return trimmed;
  if (trimmed.startsWith("projects/")) return trimmed;
  return resourceName(project, location, collection, lastSegment(trimmed));
};

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const sameRef = (left: string | undefined, right: string | undefined) =>
  lastSegment(left ?? "") === lastSegment(right ?? "");

export const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const fieldMask = (fields: Array<string | false | undefined>) =>
  fields
    .filter((field): field is string => typeof field === "string")
    .join(",");

const sanitizeId = (value: string, maxLength: number) => {
  let next = value.replace(/[^a-zA-Z0-9._~+%:-]/g, "-").replace(/-+/g, "-");
  next = next.replace(/^[^a-zA-Z]+/, "");
  if (next.length === 0) next = "topic";
  if (!/^[a-zA-Z]/.test(next)) next = `p${next}`;
  return next.slice(0, maxLength).replace(/[^a-zA-Z0-9._~+%:-]+$/g, "");
};

export const stripOwnershipId = (id: string) => {
  const index = id.lastIndexOf(OWNERSHIP_MARKER);
  return index >= 0 ? id.slice(0, index) : id;
};

export const parseOwnershipId = (
  id: string | undefined,
): Record<string, string> => {
  if (!id) return {};
  const index = id.lastIndexOf(OWNERSHIP_MARKER);
  if (index < 0) return {};
  const [stack, stage, ...idParts] = id
    .slice(index + OWNERSHIP_MARKER.length)
    .split(".");
  const labels: Record<string, string> = {};
  if (stack) labels[alchemyLabelKeys.stack] = stack;
  if (stage) labels[alchemyLabelKeys.stage] = stage;
  if (idParts.length > 0) {
    labels[alchemyLabelKeys.id] = idParts.join(".");
  }
  return labels;
};

export const hasOwnershipMarker = (id: string | undefined) =>
  Object.keys(parseOwnershipId(id)).some((key) => key.startsWith("alchemy-"));

const fitMarker = (labels: Record<string, string>, maxLength: number) => {
  let stack = labels[alchemyLabelKeys.stack] ?? "x";
  let stage = labels[alchemyLabelKeys.stage] ?? "x";
  let id = labels[alchemyLabelKeys.id] ?? "x";
  let marker = `${OWNERSHIP_MARKER}${stack}.${stage}.${id}`;
  while (
    marker.length > maxLength &&
    (stack.length > 1 || stage.length > 1 || id.length > 1)
  ) {
    if (id.length >= stack.length && id.length >= stage.length) {
      id = id.slice(0, -1);
    } else if (stack.length >= stage.length) {
      stack = stack.slice(0, -1);
    } else {
      stage = stage.slice(0, -1);
    }
    marker = `${OWNERSHIP_MARKER}${stack}.${stage}.${id}`;
  }
  return marker.slice(0, maxLength);
};

export const encodeResourceId = (
  labels: Record<string, string>,
  base: string,
  maxLength = MAX_ID_LENGTH,
) => {
  const stripped = sanitizeId(stripOwnershipId(base), maxLength);
  const minMarker = `${OWNERSHIP_MARKER}x.x.x`.length;
  const marker = fitMarker(
    labels,
    Math.max(minMarker, Math.min(120, maxLength - 8)),
  );
  const room = Math.max(1, maxLength - marker.length);
  return sanitizeId(`${stripped.slice(0, room)}${marker}`, maxLength);
};

const prefixMatch = (expected: string, observed: string) =>
  expected === observed ||
  expected.startsWith(observed) ||
  observed.startsWith(expected);

export const ownedByAlchemy = (logicalId: string, resourceId: string) =>
  Effect.gen(function* () {
    if (!hasOwnershipMarker(resourceId)) return false;
    const expected = yield* createInternalLabels(logicalId);
    const labels = parseOwnershipId(resourceId);
    const exact = yield* hasAlchemyLabels(logicalId, labels);
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

export const toResourceId = (
  logicalId: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    const labels = yield* createInternalLabels(logicalId);
    if (requested !== undefined && requested.length > 0) {
      return encodeResourceId(labels, lastSegment(requested));
    }
    if (existing !== undefined && existing.length > 0) {
      return existing;
    }
    const generated = yield* createPhysicalName({
      id: logicalId,
      maxLength: 120,
      lowercase: true,
      forbiddenPrefixes: ["goog"],
    });
    return encodeResourceId(labels, generated);
  });

export const replaceOnIdentity = (input: {
  previousId?: string;
  nextId?: string;
  previousLocation?: string;
  nextLocation?: string;
  extra?: boolean;
}) => {
  const previousId =
    input.previousId !== undefined
      ? stripOwnershipId(lastSegment(input.previousId))
      : undefined;
  const nextId =
    input.nextId !== undefined
      ? stripOwnershipId(lastSegment(input.nextId))
      : undefined;
  const idChanged =
    previousId !== undefined && nextId !== undefined && previousId !== nextId;
  const locationChanged =
    input.previousLocation !== undefined &&
    input.nextLocation !== undefined &&
    input.previousLocation !== input.nextLocation;
  if (!idChanged && !locationChanged && input.extra !== true) {
    return undefined;
  }
  const samePhysical = !idChanged && !locationChanged;
  return {
    action: "replace" as const,
    deleteFirst: samePhysical,
  };
};

export const countOf = (value: number | string | undefined) => {
  if (value === undefined || value === "")
    return Number(DEFAULT_PARTITION_COUNT);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number(DEFAULT_PARTITION_COUNT);
};

export const partitionBody = (input: {
  count?: number | string;
  capacity?: {
    publishMibPerSec?: number;
    subscribeMibPerSec?: number;
  };
}): pubsublite.PartitionConfig => ({
  count: String(countOf(input.count)),
  capacity: {
    publishMibPerSec: input.capacity?.publishMibPerSec ?? DEFAULT_PUBLISH_MIB,
    subscribeMibPerSec:
      input.capacity?.subscribeMibPerSec ?? DEFAULT_SUBSCRIBE_MIB,
  },
});

export const retentionBody = (input: {
  perPartitionBytes?: string;
  period?: string;
}): pubsublite.RetentionConfig => {
  const body: pubsublite.RetentionConfig = {
    perPartitionBytes: input.perPartitionBytes ?? DEFAULT_PER_PARTITION_BYTES,
  };
  if (input.period !== undefined) body.period = input.period;
  return body;
};

export const partitionKey = (config: pubsublite.PartitionConfig | undefined) =>
  JSON.stringify({
    count: String(countOf(config?.count)),
    publish: config?.capacity?.publishMibPerSec ?? DEFAULT_PUBLISH_MIB,
    subscribe: config?.capacity?.subscribeMibPerSec ?? DEFAULT_SUBSCRIBE_MIB,
  });

export const retentionKey = (config: pubsublite.RetentionConfig | undefined) =>
  JSON.stringify({
    perPartitionBytes: config?.perPartitionBytes ?? DEFAULT_PER_PARTITION_BYTES,
    period: config?.period ?? "",
  });

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

/**
 * Retry while a delete is blocked by a dependent (a reservation still
 * referenced by a topic, a topic with attached subscriptions): `409`.
 */
export const retryInUse = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (error) => error._tag === "Conflict",
      times: 8,
      schedule: Schedule.exponential("300 millis"),
    }),
  );

export class DeleteNotConfirmed extends Data.TaggedError(
  "GCP.PubSubLite.DeleteNotConfirmed",
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

const emptyList = <A>() => Effect.succeed([] as A[]);

const collectPages = <Page, Item, E extends { readonly _tag: string }, R>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly Item[] | null | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk) as Item[]),
    Effect.catchIf(
      (error): error is E & { readonly _tag: "NotFound" } =>
        error._tag === "NotFound",
      () => emptyList<Item>(),
    ),
  );

const listParents = (project: string, region: string) =>
  [...new Set<string>([region, ...LIST_LOCATIONS])].map((location) =>
    parentOf(project, location),
  );

const listAcross = <Item, E, R>(
  listAt: (parent: string) => Effect.Effect<readonly Item[], E, R>,
) =>
  Effect.gen(function* () {
    const env = yield* GcpEnvironment.current;
    const pages = yield* Effect.forEach(
      listParents(env.project, env.region),
      (parent) => listAt(parent),
      { concurrency: 4 },
    );
    const seen = new Set<string>();
    const found: Item[] = [];
    for (const page of pages) {
      for (const item of page) {
        const key =
          typeof item === "object" &&
          item !== null &&
          "name" in item &&
          typeof (item as { name?: unknown }).name === "string"
            ? ((item as { name: string }).name ?? "")
            : JSON.stringify(item);
        if (seen.has(key)) continue;
        seen.add(key);
        found.push(item as Item);
      }
    }
    return found;
  });

export const getReservation = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(pubsublite.getAdminProjectsLocationsReservations({ name }));

export const getTopic = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(pubsublite.getAdminProjectsLocationsTopics({ name }));

export const getSubscription = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(pubsublite.getAdminProjectsLocationsSubscriptions({ name }));

export const listReservationsAt = (parent: string) =>
  collectPages(
    pubsublite.listAdminProjectsLocationsReservations.pages({
      parent,
      pageSize: 1000,
    }),
    (page) => page.reservations,
  );

export const listTopicsAt = (parent: string) =>
  collectPages(
    pubsublite.listAdminProjectsLocationsTopics.pages({
      parent,
      pageSize: 1000,
    }),
    (page) => page.topics,
  );

export const listSubscriptionsAt = (parent: string) =>
  collectPages(
    pubsublite.listAdminProjectsLocationsSubscriptions.pages({
      parent,
      pageSize: 1000,
    }),
    (page) => page.subscriptions,
  );

export const listOwnedReservations = () =>
  listAcross(listReservationsAt).pipe(
    Effect.map((items) =>
      items.filter((item) => hasOwnershipMarker(lastSegment(item.name ?? ""))),
    ),
  );

export const listOwnedTopics = () =>
  listAcross(listTopicsAt).pipe(
    Effect.map((items) =>
      items.filter((item) => hasOwnershipMarker(lastSegment(item.name ?? ""))),
    ),
  );

export const listOwnedSubscriptions = () =>
  listAcross(listSubscriptionsAt).pipe(
    Effect.map((items) =>
      items.filter((item) => hasOwnershipMarker(lastSegment(item.name ?? ""))),
    ),
  );
