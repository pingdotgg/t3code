import * as ssm from "@distilled.cloud/gcp/securesourcemanager_v1";
import * as Data from "effect/Data";
import type { GcpOpContext } from "@distilled.cloud/gcp/Protocol";
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
import { waitForOperation as waitForLongRunningOperation } from "../Operation.ts";

export const MAX_NAME_LENGTH = 63;
export const PAGE_SIZE = 100;

export class ResourceNotResolved extends Data.TaggedError(
  "GCP.SecureSourceManager.ResourceNotResolved",
)<{
  name: string;
}> {}

export class ResourceStillExists extends Data.TaggedError(
  "GCP.SecureSourceManager.ResourceStillExists",
)<{
  name: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const rfc1035 = (name: string, fallback = "ssm"): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `${fallback[0] ?? "s"}${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/g, "");
  if (next.length === 0) next = fallback;
  if (!/[a-z0-9]$/.test(next)) {
    next = `${next.slice(0, MAX_NAME_LENGTH - 1)}0`;
  }
  return next.slice(0, MAX_NAME_LENGTH);
};

export const normalizeLocation = (
  location: string | undefined,
  defaultLocation: string,
) => lastSegment(location ?? defaultLocation).toLowerCase();

export const parseName = (
  name: string,
  collection: string,
  defaultLocation: string,
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
        : defaultLocation,
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
  const next = value.replace(/\/+$/, "");
  if (next.includes("/")) return next;
  return `projects/${project}/locations/${location}/${collection}/${next}`;
};

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  fallback = "ssm",
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return rfc1035(explicit, fallback);
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

const ALCHEMY_QUERY_PREFIX = "alchemy-";

export const stripAlchemyQuery = (uri: string): string => {
  const hashIndex = uri.indexOf("#");
  const hash = hashIndex >= 0 ? uri.slice(hashIndex) : "";
  const withoutHash = hashIndex >= 0 ? uri.slice(0, hashIndex) : uri;
  const queryIndex = withoutHash.indexOf("?");
  if (queryIndex < 0) return `${withoutHash}${hash}`;
  const base = withoutHash.slice(0, queryIndex);
  const kept = withoutHash
    .slice(queryIndex + 1)
    .split("&")
    .filter((part) => {
      const key = decodeURIComponent(
        (part.split("=")[0] ?? "").replace(/\+/g, " "),
      );
      return key.length > 0 && !key.startsWith(ALCHEMY_QUERY_PREFIX);
    });
  if (kept.length === 0) return `${base}${hash}`;
  return `${base}?${kept.join("&")}${hash}`;
};

export const encodeTargetUri = (
  uri: string,
  labels: Record<string, string>,
): string => {
  const stripped = stripAlchemyQuery(uri);
  const params = [
    `${alchemyLabelKeys.stack}=${encodeURIComponent(labels[alchemyLabelKeys.stack] ?? "x")}`,
    `${alchemyLabelKeys.stage}=${encodeURIComponent(labels[alchemyLabelKeys.stage] ?? "x")}`,
    `${alchemyLabelKeys.id}=${encodeURIComponent(labels[alchemyLabelKeys.id] ?? "x")}`,
  ].join("&");
  const hashIndex = stripped.indexOf("#");
  const hash = hashIndex >= 0 ? stripped.slice(hashIndex) : "";
  const withoutHash = hashIndex >= 0 ? stripped.slice(0, hashIndex) : stripped;
  return withoutHash.includes("?")
    ? `${withoutHash}&${params}${hash}`
    : `${withoutHash}?${params}${hash}`;
};

export const parseTargetUriOwnership = (
  uri: string | undefined,
): Record<string, string> => {
  if (uri === undefined) return {};
  const withoutHash = uri.split("#")[0] ?? uri;
  const queryIndex = withoutHash.indexOf("?");
  if (queryIndex < 0) return {};
  const labels: Record<string, string> = {};
  for (const part of withoutHash.slice(queryIndex + 1).split("&")) {
    const eq = part.indexOf("=");
    const key = decodeURIComponent(
      (eq >= 0 ? part.slice(0, eq) : part).replace(/\+/g, " "),
    );
    if (!key.startsWith(ALCHEMY_QUERY_PREFIX)) continue;
    const value = decodeURIComponent(
      (eq >= 0 ? part.slice(eq + 1) : "").replace(/\+/g, " "),
    );
    labels[key] = value;
  }
  return labels;
};

export const hasTargetUriOwnership = (uri: string | undefined) =>
  Object.keys(parseTargetUriOwnership(uri)).some((key) =>
    key.startsWith(ALCHEMY_QUERY_PREFIX),
  );

export const nameFromOperation = (
  operation: ssm.Operation,
): string | undefined => {
  const from = (value: unknown): string | undefined => {
    if (value && typeof value === "object" && "name" in value) {
      const name = (value as { name?: unknown }).name;
      if (typeof name === "string" && name.length > 0) return name;
    }
    if (value && typeof value === "object" && "target" in value) {
      const target = (value as { target?: unknown }).target;
      if (typeof target === "string" && target.length > 0) return target;
    }
    return undefined;
  };
  return from(operation.response) ?? from(operation.metadata);
};

/**
 * Wait on a Secure Source Manager long-running operation. Instance creation takes 20–40 minutes; repository children finish in seconds.
 * `ALREADY_EXISTS` (a create race) counts as success; so does `NOT_FOUND`
 * when `notFoundOk` (deletes). Returns the final operation.
 */
export const waitForOperation = (
  operation: ssm.Operation,
  options?: { notFoundOk?: boolean },
) =>
  Effect.suspend(() => {
    let latest = operation;
    return waitForLongRunningOperation(
      operation,
      (name) => {
        const get = ssm.getProjectsLocationsOperations({ name }).pipe(
          Effect.tap((current) =>
            Effect.sync(() => {
              latest = current;
            }),
          ),
        );
        const observe: Effect.Effect<
          ssm.Operation,
          ssm.GetProjectsLocationsOperationsError,
          GcpOpContext
        > =
          options?.notFoundOk === true
            ? get.pipe(
                Effect.catchTag("NotFound", () =>
                  Effect.succeed<ssm.Operation>({ name, done: true }),
                ),
              )
            : get.pipe(
                // A just-returned operation can briefly 404 on read.
                Effect.retry({
                  while: (error) => error._tag === "NotFound",
                  times: 5,
                  schedule: Schedule.exponential("250 millis"),
                }),
              );
        return observe;
      },
      { budget: "45 minutes", interval: "10 seconds" },
    ).pipe(
      Effect.map(() => latest),
      // google.rpc.Code ALREADY_EXISTS = 6, NOT_FOUND = 5.
      Effect.catchTag("GCP.OperationFailed", (error) =>
        error.code === 6 || (options?.notFoundOk === true && error.code === 5)
          ? Effect.succeed(latest)
          : Effect.fail(error),
      ),
    );
  });

export const waitUntilExists = <A, E extends { readonly _tag: string }, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
): Effect.Effect<NonNullable<A>, E | ResourceNotResolved, R> =>
  get.pipe(
    Effect.filterOrFail(
      (value): value is NonNullable<A> => value != null,
      () => new ResourceNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.SecureSourceManager.ResourceNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const waitUntilGone = <A, E extends { readonly _tag: string }, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
): Effect.Effect<void, E | ResourceStillExists, R> =>
  get.pipe(
    Effect.filterOrFail(
      (value) => value === undefined,
      () => new ResourceStillExists({ name }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.SecureSourceManager.ResourceStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
    Effect.asVoid,
  );

export const collectPages = <Page, Item, E, R>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly Item[] | null | undefined,
): Effect.Effect<Item[], E, R> =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.runFold(
      (): Item[] => [],
      (acc, item) => {
        acc.push(item);
        return acc;
      },
    ),
  );

const listInstancePages = (parent: string) =>
  ssm.listProjectsLocationsInstances
    .pages({ parent, pageSize: PAGE_SIZE })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.instances ?? [])),
      Stream.runFold(
        (): ssm.Instance[] => [],
        (acc, item) => {
          acc.push(item);
          return acc;
        },
      ),
    );

export const listInstances = (project: string, region: string) =>
  listInstancePages(`projects/${project}/locations/${region}`);

type ListRepositoriesError =
  | ssm.ListProjectsLocationsInstancesError
  | ssm.ListProjectsLocationsRepositoriesError;

export const listRepositories = (
  project: string,
  region: string,
): Effect.Effect<
  Array<ssm.Repository & { name: string }>,
  ListRepositoriesError,
  ssm.GcpOpContext
> =>
  Effect.gen(function* () {
    const instances = yield* listInstances(project, region);
    const named = instances.filter(
      (instance): instance is ssm.Instance & { name: string } =>
        (instance.name ?? "").length > 0,
    );
    const pages = yield* Effect.forEach(
      named,
      (instance) => {
        const location = parseName(instance.name, "instances", region).location;
        return collectPages(
          ssm.listProjectsLocationsRepositories.pages({
            parent: `projects/${project}/locations/${location}`,
            instance: instance.name,
            pageSize: PAGE_SIZE,
          }),
          (page) => page.repositories,
        );
      },
      { concurrency: 4 },
    );
    return pages
      .flat()
      .filter(
        (repo): repo is ssm.Repository & { name: string } =>
          (repo.name ?? "").length > 0,
      );
  });

export const forEachRepository = <A, E, R>(
  project: string,
  region: string,
  fn: (repository: string) => Effect.Effect<readonly A[], E, R>,
): Effect.Effect<A[], E | ListRepositoriesError, R | ssm.GcpOpContext> =>
  Effect.gen(function* () {
    const repos = yield* listRepositories(project, region);
    const pages = yield* Effect.forEach(repos, (repo) => fn(repo.name), {
      concurrency: 4,
    });
    return pages.flat();
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

export const retryConflict = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (error) => error._tag === "Conflict",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const desiredAnnotations = (
  annotations: Record<string, string> | undefined,
  ownership: Record<string, string>,
): Record<string, string> => ({
  ...(annotations ?? {}),
  ...ownership,
});
