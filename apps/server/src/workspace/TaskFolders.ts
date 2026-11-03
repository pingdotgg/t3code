import { IsoDateTime, ProjectId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

// KnownWorkspaces reads this store, so keep the containment check local to avoid an import cycle.
const isWithinRoot = (path: Path.Path, candidate: string, root: string) => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
};

/**
 * One repo of a task folder. `home` is the project's own repo; `repository` rows are tracked Git
 * folders. Rows are written when the folder is created and change only when a repo's branch does.
 */
export const TaskFolderRepositoryRow = Schema.Struct({
  kind: Schema.Literals(["home", "repository"]),
  name: Schema.String,
  /** The home folder or the project's tracked path. */
  originalPath: Schema.String,
  worktreePath: Schema.String,
  /** From the home worktree (the agent cwd), with `/` separators. Empty for home. */
  relativePath: Schema.String,
  baseRef: Schema.String,
  branch: Schema.NullOr(Schema.String),
});
export type TaskFolderRepositoryRow = typeof TaskFolderRepositoryRow.Type;

export const TaskFolderRecord = Schema.Struct({
  root: Schema.String,
  projectId: ProjectId,
  homeWorktreePath: Schema.String,
  /** Home first, then tracked repos in creation order. Remove in reverse. */
  repositories: Schema.Array(TaskFolderRepositoryRow),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type TaskFolderRecord = typeof TaskFolderRecord.Type;

export class TaskFolderStoreError extends Schema.TaggedError<TaskFolderStoreError>()(
  "TaskFolderStoreError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Task folder store operation '${this.operation}' failed.`;
  }
}

export class TaskFolderStore extends Context.Service<
  TaskFolderStore,
  {
    readonly get: (
      root: string,
    ) => Effect.Effect<Option.Option<TaskFolderRecord>, TaskFolderStoreError>;
    /** The record whose root contains `path`. Callers pass resolved paths. */
    readonly findContaining: (
      path: string,
    ) => Effect.Effect<Option.Option<TaskFolderRecord>, TaskFolderStoreError>;
    readonly list: (options?: {
      readonly projectId?: ProjectId;
    }) => Effect.Effect<ReadonlyArray<TaskFolderRecord>, TaskFolderStoreError>;
    readonly upsert: (record: TaskFolderRecord) => Effect.Effect<void, TaskFolderStoreError>;
    readonly remove: (root: string) => Effect.Effect<void, TaskFolderStoreError>;
  }
>()("t3/workspace/TaskFolders/TaskFolderStore") {}

const TaskFolderDbRow = Schema.Struct({
  root: Schema.String,
  projectId: ProjectId,
  homeWorktreePath: Schema.String,
  repositories: Schema.fromJsonString(Schema.Array(TaskFolderRepositoryRow)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

/** @public */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const path = yield* Path.Path;
  const encodeRow = Schema.encodeEffect(TaskFolderDbRow);

  const selectRows = SqlSchema.findAll({
    Request: Schema.Struct({
      root: Schema.optional(Schema.String),
      projectId: Schema.optional(ProjectId),
    }),
    Result: TaskFolderDbRow,
    execute: (request) => sql`
      SELECT
        root,
        project_id AS "projectId",
        home_worktree_path AS "homeWorktreePath",
        repositories_json AS "repositories",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM task_folders
      WHERE ${sql.and([
        ...(request.root === undefined ? [] : [sql`root = ${request.root}`]),
        ...(request.projectId === undefined ? [] : [sql`project_id = ${request.projectId}`]),
      ])}
      ORDER BY created_at ASC, root ASC
    `,
  });

  const mapError =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError((cause) => new TaskFolderStoreError({ operation, cause })));

  const list: TaskFolderStore["Service"]["list"] = (options) =>
    selectRows(options?.projectId === undefined ? {} : { projectId: options.projectId }).pipe(
      NodeSqliteClient.readOnly,
      mapError("list"),
    );

  return TaskFolderStore.of({
    get: Effect.fn("TaskFolderStore.get")(function (root) {
      return selectRows({ root }).pipe(
        NodeSqliteClient.readOnly,
        Effect.map((rows) => Option.fromUndefinedOr(rows[0])),
        mapError("get"),
      );
    }),
    findContaining: Effect.fn("TaskFolderStore.findContaining")(function (candidate) {
      return list().pipe(
        Effect.map((records) =>
          Option.fromUndefinedOr(
            records.find((record) => isWithinRoot(path, candidate, record.root)),
          ),
        ),
      );
    }),
    list,
    upsert: Effect.fn("TaskFolderStore.upsert")(function (record) {
      return encodeRow(record).pipe(
        Effect.flatMap(
          (encoded) => sql`
            INSERT INTO task_folders (
              root,
              project_id,
              home_worktree_path,
              repositories_json,
              created_at,
              updated_at
            )
            VALUES (
              ${encoded.root},
              ${encoded.projectId},
              ${encoded.homeWorktreePath},
              ${encoded.repositories},
              ${encoded.createdAt},
              ${encoded.updatedAt}
            )
            ON CONFLICT (root)
            DO UPDATE SET
              project_id = excluded.project_id,
              home_worktree_path = excluded.home_worktree_path,
              repositories_json = excluded.repositories_json,
              updated_at = excluded.updated_at
          `,
        ),
        mapError("upsert"),
      );
    }),
    remove: Effect.fn("TaskFolderStore.remove")(function (root) {
      return sql`DELETE FROM task_folders WHERE root = ${root}`.pipe(mapError("remove"));
    }),
  });
});

export const layer = Layer.effect(TaskFolderStore, make);
