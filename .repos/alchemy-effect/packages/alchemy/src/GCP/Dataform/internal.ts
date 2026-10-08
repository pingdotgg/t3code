import * as dataform from "@distilled.cloud/gcp/dataform_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { waitForOperation as waitForGcpOperation } from "../Operation.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
  stripInternalLabels,
} from "../Labels.ts";
import { isTransientGcpError } from "../Errors.ts";

export const MAX_ID_LENGTH = 63;
export const MAX_DISPLAY_NAME_LENGTH = 63;

export class DataformPending extends Data.TaggedError("GCP.Dataform.Pending")<{
  name: string;
}> {}

export class DataformStillExists extends Data.TaggedError(
  "GCP.Dataform.StillExists",
)<{
  name: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const locationParent = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

export const normalizeLocation = (
  location: string | undefined,
  defaultLocation: string,
) => lastSegment(location ?? defaultLocation).toLowerCase();

export const parseResourceName = (
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

export const expandParent = (
  value: string,
  project: string,
  location: string,
  collection: string,
) => {
  if (value.includes("/")) return value.replace(/\/+$/, "");
  return `${locationParent(project, location)}/${collection}/${value}`;
};

export const expandRepository = (
  value: string,
  project: string,
  location: string,
) => expandParent(value, project, location, "repositories");

export const rfc1035 = (name: string, maxLength = MAX_ID_LENGTH): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `d${next}`;
  next = next.slice(0, maxLength).replace(/-+$/g, "");
  if (next.length === 0) return "dataform";
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
      yield* createPhysicalName({
        id,
        maxLength,
        lowercase: true,
      }),
      maxLength,
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

export const sameJson = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const updateMaskOf = (...fields: Array<string | undefined>) =>
  fields.filter((field): field is string => field !== undefined).join(",");

export const replaceOnIdentity = (input: {
  previousId?: string;
  nextId?: string;
  previousLocation?: string;
  nextLocation?: string;
  previousParent?: string;
  nextParent?: string;
  extra?: boolean;
}) => {
  const locationChanged =
    (input.previousLocation ?? "") !== "" &&
    (input.nextLocation ?? "") !== "" &&
    lastSegment(input.previousLocation ?? "").toLowerCase() !==
      lastSegment(input.nextLocation ?? "").toLowerCase();
  const parentChanged =
    (input.previousParent ?? "") !== "" &&
    (input.nextParent ?? "") !== "" &&
    (input.previousParent ?? "") !== (input.nextParent ?? "");
  const idChanged =
    input.previousId !== undefined &&
    input.nextId !== undefined &&
    input.previousId !== input.nextId;
  if (input.extra === true || locationChanged || parentChanged || idChanged) {
    const samePhysical =
      !locationChanged &&
      !parentChanged &&
      input.previousId !== undefined &&
      input.nextId === input.previousId;
    return {
      action: "replace" as const,
      deleteFirst: samePhysical,
    };
  }
  return undefined;
};

const markerOf = (stack: string, stage: string, id: string) =>
  `[alchemy ${alchemyLabelKeys.stack}=${stack} ${alchemyLabelKeys.stage}=${stage} ${alchemyLabelKeys.id}=${id}]`;

const compactMarkerOf = (stack: string, stage: string, id: string) =>
  `[alc ${stack} ${stage} ${id}]`;

const shrinkMarker = (
  labels: Record<string, string>,
  maxLength: number,
  build: (stack: string, stage: string, id: string) => string,
) => {
  let stack = labels[alchemyLabelKeys.stack] ?? "x";
  let stage = labels[alchemyLabelKeys.stage] ?? "x";
  let id = labels[alchemyLabelKeys.id] ?? "x";
  let marker = build(stack, stage, id);
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
    marker = build(stack, stage, id);
  }
  return marker.slice(0, maxLength);
};

export const encodeOwnershipLine = (
  labels: Record<string, string>,
  text: string | undefined,
  maxLength = MAX_DISPLAY_NAME_LENGTH,
): string => {
  const trimmed = text?.replace(/[\r\n]+/g, " ").trim();
  const reserved =
    trimmed && trimmed.length > 0
      ? Math.min(trimmed.length + 1, Math.max(0, maxLength - 24))
      : 0;
  const budget = Math.max(16, maxLength - reserved);
  const marker =
    budget < 54
      ? shrinkMarker(labels, budget, compactMarkerOf)
      : shrinkMarker(labels, budget, markerOf);
  if (!trimmed) return marker.slice(0, maxLength);
  return `${marker} ${trimmed}`.slice(0, maxLength);
};

export const parseOwnership = (
  text: string | undefined,
): {
  labels: Record<string, string>;
  text: string | undefined;
} => {
  if (text?.startsWith("[alc ")) {
    const end = text.indexOf("]");
    if (end < 0) return { labels: {}, text };
    const parts = text.slice("[alc ".length, end).trim().split(/\s+/);
    const labels: Record<string, string> = {};
    if (parts[0]) labels[alchemyLabelKeys.stack] = parts[0]!;
    if (parts[1]) labels[alchemyLabelKeys.stage] = parts[1]!;
    if (parts[2]) labels[alchemyLabelKeys.id] = parts[2]!;
    const rest = text.slice(end + 1).replace(/^[\s\n]+/, "");
    return { labels, text: rest.length > 0 ? rest : undefined };
  }
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

export const mergeOwnedVars = (
  vars: Record<string, string> | undefined,
  ownership: Record<string, string>,
): Record<string, string> => ({ ...vars, ...ownership });

export const retryTransient = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: isTransientGcpError,
      times: 8,
      schedule: Schedule.exponential("250 millis"),
    }),
  );

export class DeleteNotConfirmed extends Data.TaggedError(
  "GCP.Dataform.DeleteNotConfirmed",
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

export const waitUntilExists = <A, E extends { readonly _tag: string }, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
) =>
  get.pipe(
    Effect.flatMap((value) =>
      value !== undefined
        ? Effect.succeed(value)
        : Effect.fail(new DataformPending({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Dataform.Pending",
      times: 8,
      schedule: Schedule.exponential("250 millis"),
    }),
  );

/**
 * Wait for a Dataform operation (folder tree deletes, repository moves).
 * An operation that finished with `ALREADY_EXISTS` (6) is a lost create
 * race; `notFoundOk` also accepts `NOT_FOUND` (5).
 */
export const waitForOperation = (
  operation: dataform.Operation,
  options?: { notFoundOk?: boolean },
) =>
  waitForGcpOperation(
    operation,
    (name) =>
      dataform
        .getProjectsLocationsOperations({ name })
        .pipe(
          Effect.catchTag("NotFound", (error) =>
            options?.notFoundOk === true
              ? Effect.succeed<dataform.Operation>({ name, done: true })
              : Effect.fail(error),
          ),
        ),
    { budget: "10 minutes" },
  ).pipe(
    Effect.catchIf(
      (error) =>
        error._tag === "GCP.OperationFailed" &&
        (error.code === 6 ||
          (options?.notFoundOk === true && error.code === 5)),
      () => Effect.void,
    ),
    Effect.asVoid,
  );

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
    Effect.map((chunk) => Array.from(chunk)),
  );

const emptyList = <A>() => Effect.succeed<A[]>([]);

const emptyOnMissing = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A[], E, R>,
) =>
  effect.pipe(
    Effect.catchIf(
      (error) => error._tag === "NotFound",
      () => emptyList<A>(),
    ),
  );

export const listRepositories = (project: string, location: string) =>
  emptyOnMissing(
    collectPages(
      dataform.listProjectsLocationsRepositories.pages({
        parent: locationParent(project, location),
        pageSize: 1000,
      }),
      (page) => page.repositories ?? [],
    ).pipe(
      Effect.catchIf(
        () => true,
        () =>
          collectPages(
            dataform.listProjectsLocationsRepositories.pages({
              parent: `projects/${project}/locations/-`,
              pageSize: 1000,
            }),
            (page) => page.repositories ?? [],
          ),
      ),
    ),
  );

export const listOwnedRepositories = (project: string, location: string) =>
  listRepositories(project, location).pipe(
    Effect.map((repos) =>
      repos.filter((repo) => hasAlchemyLabelMap(repo.labels)),
    ),
  );

export const listTeamFolders = (project: string, location: string) =>
  emptyOnMissing(
    collectPages(
      dataform.searchProjectsLocationsTeamFolders.pages({
        location: locationParent(project, location),
        pageSize: 1000,
      }),
      (page) =>
        (page.results ?? []).flatMap((result) =>
          result.teamFolder ? [result.teamFolder] : [],
        ),
    ),
  );

export const listFolders = (project: string, location: string) =>
  Effect.gen(function* () {
    const parent = locationParent(project, location);
    const seen = new Set<string>();
    const folders: dataform.Folder[] = [];
    const queue: string[] = [];

    const ingest = (folder: dataform.Folder | undefined) => {
      const name = folder?.name;
      if (folder === undefined || name === undefined || seen.has(name)) {
        return;
      }
      seen.add(name);
      folders.push(folder);
      queue.push(name);
    };

    const root = yield* emptyOnMissing(
      collectPages(
        dataform.queryUserRootContentsProjectsLocations.pages({
          location: parent,
          pageSize: 1000,
        }),
        (page) => page.entries ?? [],
      ),
    );
    for (const entry of root) ingest(entry.folder);

    const teams = yield* listTeamFolders(project, location);
    for (const team of teams) {
      if (team.name) queue.push(team.name);
    }

    let steps = 0;
    while (queue.length > 0 && steps < 50) {
      steps += 1;
      const name = queue.shift()!;
      const entries = name.includes("/teamFolders/")
        ? yield* emptyOnMissing(
            collectPages(
              dataform.queryContentsProjectsLocationsTeamFolders.pages({
                teamFolder: name,
                pageSize: 1000,
              }),
              (page) => page.entries ?? [],
            ),
          )
        : yield* emptyOnMissing(
            collectPages(
              dataform.queryFolderContentsProjectsLocationsFolders.pages({
                folder: name,
                pageSize: 1000,
              }),
              (page) => page.entries ?? [],
            ),
          );
      for (const entry of entries) ingest(entry.folder);
    }

    return folders;
  });

export const listReleaseConfigs = (parent: string) =>
  parent.length === 0
    ? emptyList<dataform.ReleaseConfig>()
    : emptyOnMissing(
        collectPages(
          dataform.listProjectsLocationsRepositoriesReleaseConfigs.pages({
            parent,
            pageSize: 1000,
          }),
          (page) => page.releaseConfigs ?? [],
        ),
      );

export const listWorkflowConfigs = (parent: string) =>
  parent.length === 0
    ? emptyList<dataform.WorkflowConfig>()
    : emptyOnMissing(
        collectPages(
          dataform.listProjectsLocationsRepositoriesWorkflowConfigs.pages({
            parent,
            pageSize: 1000,
          }),
          (page) => page.workflowConfigs ?? [],
        ),
      );

export const listWorkspaces = (parent: string) =>
  parent.length === 0
    ? emptyList<dataform.Workspace>()
    : emptyOnMissing(
        collectPages(
          dataform.listProjectsLocationsRepositoriesWorkspaces.pages({
            parent,
            pageSize: 1000,
          }),
          (page) => page.workspaces ?? [],
        ),
      );

export const listWorkflowInvocations = (parent: string) =>
  parent.length === 0
    ? emptyList<dataform.WorkflowInvocation>()
    : emptyOnMissing(
        collectPages(
          dataform.listProjectsLocationsRepositoriesWorkflowInvocations.pages({
            parent,
            pageSize: 1000,
          }),
          (page) => page.workflowInvocations ?? [],
        ),
      );

export const forEachOwnedRepository = <A, E, R>(
  project: string,
  location: string,
  fn: (repo: dataform.Repository) => Effect.Effect<readonly A[], E, R>,
) =>
  listOwnedRepositories(project, location).pipe(
    Effect.flatMap((repos) =>
      Effect.forEach(repos, fn, { concurrency: 4 }).pipe(
        Effect.map((chunks) => chunks.flat()),
      ),
    ),
  );

export const deleteFolderTree = (name: string) =>
  dataform.deleteProjectsLocationsFolders({ name }).pipe(
    Effect.catchTag("Conflict", () =>
      dataform
        .deleteTreeProjectsLocationsFolders({
          name,
          body: { force: true },
        })
        .pipe(
          Effect.flatMap((operation) =>
            waitForOperation(operation, { notFoundOk: true }),
          ),
        ),
    ),
    Effect.catchTag("NotFound", () => Effect.void),
    Effect.asVoid,
  );

export const deleteTeamFolderTree = (name: string) =>
  dataform.deleteProjectsLocationsTeamFolders({ name }).pipe(
    Effect.catchTag("Conflict", () =>
      dataform
        .deleteTreeProjectsLocationsTeamFolders({
          name,
          body: { force: true },
        })
        .pipe(
          Effect.flatMap((operation) =>
            waitForOperation(operation, { notFoundOk: true }),
          ),
        ),
    ),
    Effect.catchTag("NotFound", () => Effect.void),
    Effect.asVoid,
  );
