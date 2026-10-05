import * as artifactregistry from "@distilled.cloud/gcp/artifactregistry_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import {
  alchemyLabelKeys,
  hasAlchemyLabels,
  stripInternalLabels,
} from "../Labels.ts";
import {
  waitForOperation as waitForLongRunning,
  type LongRunningOperation,
} from "../Operation.ts";

export const MAX_NAME_LENGTH = 63;
export const PAGE_SIZE = 1000;

export class ResourceNotResolved extends Data.TaggedError(
  "GCP.ArtifactRegistry.ResourceNotResolved",
)<{
  name: string;
}> {}

export class ResourceStillExists extends Data.TaggedError(
  "GCP.ArtifactRegistry.ResourceStillExists",
)<{
  name: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const rfc1035 = (name: string, fallback = "artifact"): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `${fallback[0] ?? "a"}${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/g, "");
  if (next.length === 0) next = fallback;
  if (!/[a-z0-9]$/.test(next)) {
    next = `${next.slice(0, MAX_NAME_LENGTH - 1)}0`;
  }
  return next.slice(0, MAX_NAME_LENGTH);
};

export const normalizeLocation = (
  location: string | undefined,
  fallback: string,
) => lastSegment(location ?? fallback).toLowerCase();

export const parseName = (
  name: string,
  collection: string,
  fallbackLocation: string,
) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const collectionAt = parts.lastIndexOf(collection);
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : fallbackLocation,
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

export const expandRepository = (
  value: string,
  project: string,
  location: string,
) => {
  const next = value.replace(/\/+$/, "");
  if (next.includes("/repositories/")) return next;
  if (next.includes("/")) return next;
  return `projects/${project}/locations/${location}/repositories/${next}`;
};

export const locationFromRepository = (
  repository: string | undefined,
  fallback: string,
) => {
  if (repository === undefined || !repository.includes("/locations/")) {
    return fallback;
  }
  return parseName(repository, "repositories", fallback).location;
};

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  fallback = "artifact",
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }),
      fallback,
    );
  });

export const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

export const hasAlchemyLabelMap = (
  labels: Record<string, string | undefined> | null | undefined,
) => Object.keys(labels ?? {}).some((key) => key.startsWith("alchemy-"));

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const fingerprint = (value: unknown): string =>
  JSON.stringify(value ?? null);

export const sameJson = (left: unknown, right: unknown) =>
  fingerprint(left) === fingerprint(right);

export const sortedStrings = (values: readonly string[] | undefined) =>
  [...(values ?? [])].slice().sort();

export const fieldMask = (fields: Array<string | false | undefined>) =>
  fields
    .filter((field): field is string => typeof field === "string")
    .join(",");

export const replaceOnIdentity = (input: {
  previousId: string | undefined;
  nextId: string | undefined;
  previousLocation: string;
  nextLocation: string;
  extra?: boolean;
  previousParent?: string;
  nextParent?: string;
}) => {
  const parentChanged =
    (input.previousParent ?? "") !== "" &&
    (input.nextParent ?? "") !== "" &&
    lastSegment(input.previousParent ?? "") !==
      lastSegment(input.nextParent ?? "");
  const replace =
    (input.extra ?? false) ||
    parentChanged ||
    (input.previousId !== undefined &&
      input.nextId !== undefined &&
      input.nextId !== input.previousId) ||
    input.previousLocation !== input.nextLocation;
  if (!replace) return undefined;
  const samePhysical =
    input.previousLocation === input.nextLocation &&
    !parentChanged &&
    input.previousId !== undefined &&
    input.nextId === input.previousId;
  return {
    action: "replace" as const,
    deleteFirst: samePhysical,
  };
};

const markerOf = (stack: string, stage: string, id: string) =>
  `[alchemy ${alchemyLabelKeys.stack}=${stack} ${alchemyLabelKeys.stage}=${stage} ${alchemyLabelKeys.id}=${id}]`;

export const encodeOwnership = (
  labels: Record<string, string>,
  text: string | undefined,
): string => {
  const marker = markerOf(
    labels[alchemyLabelKeys.stack] ?? "x",
    labels[alchemyLabelKeys.stage] ?? "x",
    labels[alchemyLabelKeys.id] ?? "x",
  );
  return text && text.length > 0 ? `${marker}\n${text}` : marker;
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
  const rest = text.slice(end + 1).replace(/^\n/, "");
  return { labels, text: rest.length > 0 ? rest : undefined };
};

export const hasOwnershipMarker = (text: string | undefined) =>
  Object.keys(parseOwnership(text).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

export const ownedByAlchemy = (id: string, text: string | undefined) =>
  Effect.gen(function* () {
    const { labels } = parseOwnership(text);
    return yield* hasAlchemyLabels(id, labels);
  });

export const waitUntilExists = <A, E, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
) =>
  get.pipe(
    Effect.flatMap((value) =>
      value
        ? Effect.succeed(value)
        : Effect.fail(new ResourceNotResolved({ name })),
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
) =>
  get.pipe(
    Effect.flatMap((value) =>
      value === undefined
        ? Effect.void
        : Effect.fail(new ResourceStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error instanceof ResourceStillExists,
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
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
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk) as Item[]),
    Effect.catchIf(
      (error): error is E & { readonly _tag: "NotFound" } =>
        error._tag === "NotFound",
      () => emptyList<Item>(),
    ),
  );

export const listChildResources = <A, E, R>(
  parents: readonly { name?: string }[],
  list: (name: string) => Effect.Effect<A[], E, R>,
) =>
  Effect.forEach(
    parents.filter((parent) => (parent.name ?? "").length > 0),
    (parent) => list(parent.name!),
    { concurrency: 4 },
  ).pipe(Effect.map((groups) => groups.flat()));

export const listAlchemyRepositories = (project: string) =>
  collectPages(
    artifactregistry.listProjectsLocationsRepositories.pages({
      parent: `projects/${project}/locations/-`,
      pageSize: PAGE_SIZE,
    }),
    (page) => page.repositories,
  ).pipe(
    Effect.map((repos) =>
      repos.filter((repo) => hasAlchemyLabelMap(repo.labels)),
    ),
  );

export const listPackages = (parent: string) =>
  parent.length === 0
    ? emptyList<artifactregistry.Package>()
    : collectPages(
        artifactregistry.listProjectsLocationsRepositoriesPackages.pages({
          parent,
          pageSize: PAGE_SIZE,
        }),
        (page) => page.packages,
      );

export const listTags = (parent: string) =>
  parent.length === 0
    ? emptyList<artifactregistry.Tag>()
    : collectPages(
        artifactregistry.listProjectsLocationsRepositoriesPackagesTags.pages({
          parent,
          pageSize: PAGE_SIZE,
        }),
        (page) => page.tags,
      );

export const listRules = (parent: string) =>
  parent.length === 0
    ? emptyList<artifactregistry.GoogleDevtoolsArtifactregistryV1Rule>()
    : collectPages(
        artifactregistry.listProjectsLocationsRepositoriesRules.pages({
          parent,
          pageSize: PAGE_SIZE,
        }),
        (page) => page.rules,
      );

export const listAttachments = (parent: string) =>
  parent.length === 0
    ? emptyList<artifactregistry.Attachment>()
    : collectPages(
        artifactregistry.listProjectsLocationsRepositoriesAttachments.pages({
          parent,
          pageSize: PAGE_SIZE,
        }),
        (page) => page.attachments,
      );

export const missingGet =
  <A, E extends { readonly _tag: string }, R>(
    effect: (input: { name: string }) => Effect.Effect<A, E, R>,
  ) =>
  (name: string) =>
    name.length === 0
      ? Effect.succeed(undefined)
      : effect({ name }).pipe(
          Effect.catchIf(
            (error): error is E & { readonly _tag: "NotFound" } =>
              error._tag === "NotFound",
            () => Effect.succeed(undefined),
          ),
        );

/** Repository and package operations finish within a few minutes. */
const OPERATION_BUDGET = "10 minutes";

/**
 * Wait for a long-running operation. ALREADY_EXISTS (code 6) means a
 * concurrent create won the race; reconcile observes the resource next.
 */
export const waitForOperation = (operation: LongRunningOperation) =>
  waitForLongRunning(
    operation,
    (name) => artifactregistry.getProjectsLocationsOperations({ name }),
    {
      budget: OPERATION_BUDGET,
    },
  ).pipe(
    Effect.catchIf(
      (error) => error._tag === "GCP.OperationFailed" && error.code === 6,
      () => Effect.succeed(operation),
    ),
  );

/**
 * Wait for a delete operation. A vanished operation or NOT_FOUND (code 5)
 * means the resource is already gone.
 */
export const waitForDeleteOperation = (operation: LongRunningOperation) =>
  waitForOperation(operation).pipe(
    Effect.catchIf(
      (error) =>
        error._tag === "NotFound" ||
        (error._tag === "GCP.OperationFailed" && error.code === 5),
      () => Effect.succeed(operation),
    ),
  );
