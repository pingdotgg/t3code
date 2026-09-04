import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { isSqlError } from "effect/unstable/sql/SqlError";

import * as NodeSqliteClient from "../src/persistence/NodeSqliteClient.ts";

export const ThreadTransferState = Schema.Literals(["userdata", "dev"]);
export type ThreadTransferState = typeof ThreadTransferState.Type;

export class ThreadTransferError extends Schema.TaggedErrorClass<ThreadTransferError>()(
  "ThreadTransferError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `${this.operation}: ${this.detail}`;
  }
}

export interface ListThreadsInput {
  /** Workspace root, T3 base directory, or direct state directory. */
  readonly source: string;
  readonly state?: ThreadTransferState | undefined;
}

export const ListedProject = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  workspaceRoot: Schema.String,
  updatedAt: Schema.NullOr(Schema.String),
});
export type ListedProject = typeof ListedProject.Type;

export const ListedThread = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  projectId: Schema.String,
  projectTitle: Schema.String,
  workspaceRoot: Schema.String,
  updatedAt: Schema.NullOr(Schema.String),
});
export type ListedThread = typeof ListedThread.Type;

/** The live projects of a state directory and the live threads across all its projects. */
export const ThreadListing = Schema.Struct({
  projects: Schema.Array(ListedProject),
  threads: Schema.Array(ListedThread),
});
export type ThreadListing = typeof ThreadListing.Type;

interface StateLocation {
  readonly stateDir: string;
  readonly databasePath: string;
  readonly workspaceRoot: string | null;
}

interface ProjectRow {
  readonly projectId: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly updatedAt: string | null;
  readonly deletedAt: string | null;
}

interface ListedThreadRow {
  readonly threadId: string;
  readonly projectId: string;
  readonly title: string;
  readonly updatedAt: string | null;
}

const transferError = (operation: string, detail: string, cause?: unknown): ThreadTransferError =>
  new ThreadTransferError({ operation, detail, ...(cause === undefined ? {} : { cause }) });

/** Runs `effect` against the state database, reporting SQL failures as `operation` errors. */
const withThreadDatabase =
  (location: StateLocation, operation: string, access: "read" | "update") =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(SqlClient.SafeIntegers, access === "read"),
      Effect.provide(
        NodeSqliteClient.layer({ filename: location.databasePath, readonly: access === "read" }),
      ),
      Effect.mapError((cause) =>
        isSqlError(cause)
          ? transferError(operation, `Could not ${access} '${location.databasePath}'.`, cause)
          : cause,
      ),
    );

/** Accepts a state directory, a T3 base directory, or a workspace root holding `.t3/`. */
const resolveStateLocation = Effect.fn("resolveThreadTransferStateLocation")(function* (
  directory: string,
  state: ThreadTransferState = "userdata",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(directory);
  const candidates = [
    { stateDir: root, workspaceRoot: null },
    { stateDir: path.join(root, state), workspaceRoot: null },
    { stateDir: path.join(root, ".t3", state), workspaceRoot: root },
  ].map(
    (candidate): StateLocation => ({
      ...candidate,
      databasePath: path.join(candidate.stateDir, "state.sqlite"),
    }),
  );
  for (const candidate of candidates) {
    const exists = yield* fs.exists(candidate.databasePath).pipe(Effect.orElseSucceed(() => false));
    if (exists) return candidate;
  }
  const [direct, base, nested] = candidates.map((candidate) => `'${candidate.databasePath}'`);
  return yield* transferError(
    "resolve directory",
    `No T3 ${state} database found at ${direct}, ${base}, or ${nested}.`,
  );
});

export const listThreads = Effect.fn("listThreads")(function* (input: ListThreadsInput) {
  const location = yield* resolveStateLocation(input.source, input.state);
  return yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projects = yield* sql<ProjectRow>`
      SELECT
        project_id AS "projectId",
        title,
        workspace_root AS "workspaceRoot",
        updated_at AS "updatedAt",
        deleted_at AS "deletedAt"
      FROM projection_projects`;
    const projectsById = new Map(projects.map((project) => [project.projectId, project]));
    const threads = yield* sql<ListedThreadRow>`
      SELECT thread_id AS "threadId", project_id AS "projectId", title, updated_at AS "updatedAt"
      FROM projection_threads
      WHERE deleted_at IS NULL`;
    const listing: ThreadListing = {
      projects: projects
        .filter((project) => project.deletedAt === null)
        .map((project) => ({
          id: project.projectId,
          title: project.title,
          workspaceRoot: project.workspaceRoot,
          updatedAt: project.updatedAt,
        }))
        .sort((left, right) => left.workspaceRoot.localeCompare(right.workspaceRoot)),
      threads: threads
        .map((thread): ListedThread => {
          const project = projectsById.get(thread.projectId);
          return {
            id: thread.threadId,
            title: thread.title,
            projectId: thread.projectId,
            projectTitle: project?.title ?? thread.projectId,
            workspaceRoot: project?.workspaceRoot ?? "",
            updatedAt: thread.updatedAt,
          };
        })
        .sort((left, right) => {
          const updated = (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "");
          return updated !== 0 ? updated : left.id.localeCompare(right.id);
        }),
    };
    return listing;
  }).pipe(withThreadDatabase(location, "list threads", "read"));
});
