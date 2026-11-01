import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { GcpEnvironment } from "../Environment.ts";
import { waitForOperation as waitForGcpOperation } from "../Operation.ts";

export const FOLDER_DISPLAY_MAX = 30;
export const PROJECT_ID_MIN = 6;
export const PROJECT_ID_MAX = 30;
export const PROJECT_DISPLAY_MIN = 4;
export const PROJECT_DISPLAY_MAX = 30;
export const LIEN_REASON_MAX = 200;
export const LIEN_ORIGIN_MAX = 200;
export const DEFAULT_LIEN_ORIGIN = "alchemy.effect";
export const DEFAULT_LIEN_RESTRICTIONS = [
  "resourcemanager.projects.delete",
] as const;

export class ParentRequired extends Data.TaggedError(
  "GCP.ResourceManager.ParentRequired",
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

export const folderParent = (value: string) =>
  value.startsWith("folders/") ? value : `folders/${lastSegment(value)}`;

export const projectParent = (value: string) =>
  value.startsWith("projects/") ? value : `projects/${lastSegment(value)}`;

export const normalizeHierarchyParent = (value: string) => {
  if (
    value.startsWith("organizations/") ||
    value.startsWith("folders/") ||
    value.startsWith("projects/")
  ) {
    return value;
  }
  if (value.startsWith("orgs/")) {
    return `organizations/${value.slice("orgs/".length)}`;
  }
  return folderParent(value);
};

export const sameHierarchyParent = (
  left: string | undefined,
  right: string | undefined,
) => {
  if (left === undefined || right === undefined) return left === right;
  if (left === right) return true;
  const leftKind = left.split("/")[0];
  const rightKind = right.split("/")[0];
  return leftKind === rightKind && lastSegment(left) === lastSegment(right);
};

export const isDeleteRequested = (state: string | undefined) =>
  state === "DELETE_REQUESTED";

export const resourceNameFromOperation = (
  operation: resourcemanager.Operation,
  prefix: string,
): string | undefined => {
  const name = operation.response?.name;
  return typeof name === "string" && name.startsWith(prefix) ? name : undefined;
};

export const projectIdFromOperation = (
  operation: resourcemanager.Operation,
): string | undefined => {
  const projectId = operation.response?.projectId;
  return typeof projectId === "string" && projectId.length > 0
    ? projectId
    : undefined;
};

const parentOf = (name: string) =>
  name.startsWith("projects/")
    ? resourcemanager.getProjects({ name }).pipe(
        Effect.map((resource) => resource.parent),
        Effect.catchTag(["NotFound", "Forbidden", "ProjectNotFound"], () =>
          Effect.succeed(undefined),
        ),
      )
    : name.startsWith("folders/")
      ? resourcemanager.getFolders({ name }).pipe(
          Effect.map((folder) => folder.parent),
          Effect.catchTag(["NotFound", "Forbidden", "FolderNotFound"], () =>
            Effect.succeed(undefined),
          ),
        )
      : Effect.succeed(undefined);

export const tryResolveParent = () =>
  Effect.gen(function* () {
    const env = yield* GcpEnvironment.current;
    return yield* parentOf(`projects/${env.project}`).pipe(
      Effect.map((parent) => {
        if (parent === undefined || parent.length === 0) return undefined;
        if (
          parent.startsWith("folders/") ||
          parent.startsWith("organizations/")
        ) {
          return parent;
        }
        return undefined;
      }),
    );
  });

export const resolveParent = (
  explicit: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined && explicit.length > 0) {
      return normalizeHierarchyParent(explicit);
    }
    if (existing !== undefined && existing.length > 0) {
      return normalizeHierarchyParent(existing);
    }
    const resolved = yield* tryResolveParent();
    if (resolved === undefined) {
      const env = yield* GcpEnvironment.current;
      return yield* new ParentRequired({ project: env.project });
    }
    return resolved;
  });

export const projectNumberOf = (project: string) =>
  resourcemanager.getProjects({ name: `projects/${project}` }).pipe(
    Effect.map((resource) => {
      const number = lastSegment(resource.name ?? "");
      return /^\d+$/.test(number) ? number : project;
    }),
    Effect.catchTag("NotFound", () => Effect.succeed(project)),
  );

export const sortedStrings = (values: readonly string[] | undefined) =>
  [...(values ?? [])].slice().sort();

export const sameStringList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) =>
  JSON.stringify(sortedStrings(left)) === JSON.stringify(sortedStrings(right));

export const collectPages = <Page, A, E, R>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly A[] | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

/**
 * Wait for a Resource Manager operation; project and folder operations
 * settle within a minute or two. With `allowAlreadyExists`, ALREADY_EXISTS
 * (code 6) counts as success (create race); with `notFoundOk`, so does
 * NOT_FOUND (code 5, delete race) and an operation that is already gone.
 */
export const waitForOperation = (
  operation: resourcemanager.Operation,
  options?: { notFoundOk?: boolean; allowAlreadyExists?: boolean },
) =>
  waitForGcpOperation(
    operation,
    (name) => resourcemanager.getOperations({ name }),
    { budget: "10 minutes" },
  ).pipe(
    Effect.catchIf(
      (error) =>
        (error._tag === "GCP.OperationFailed" &&
          ((options?.allowAlreadyExists === true && error.code === 6) ||
            (options?.notFoundOk === true && error.code === 5))) ||
        (options?.notFoundOk === true && error._tag === "NotFound"),
      () => Effect.succeed(operation),
    ),
  );

/**
 * Wait for a create operation, then re-read it for its typed `response`
 * (the created resource's name / project id).
 */
export const waitForCreate = (operation: resourcemanager.Operation) =>
  waitForOperation(operation, { allowAlreadyExists: true }).pipe(
    Effect.andThen(() =>
      operation.name === undefined || operation.name.length === 0
        ? Effect.succeed(operation)
        : resourcemanager.getOperations({ name: operation.name }),
    ),
  );
