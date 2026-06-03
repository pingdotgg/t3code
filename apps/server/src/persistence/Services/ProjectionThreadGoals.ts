import { OrchestrationThreadGoal, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { ServerConfig } from "../../config.ts";
import { toPersistenceSqlError, type ProjectionRepositoryError } from "../Errors.ts";
import { makeRuntimeSqliteLayer } from "../Layers/Sqlite.ts";
import { ensureGoalTable } from "../GoalTable.ts";
import { runForkMigrations } from "../ForkMigrations.ts";

export interface ProjectionThreadGoalRepositoryShape {
  readonly getByThreadId: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<
    Option.Option<Schema.Schema.Type<typeof OrchestrationThreadGoal>>,
    ProjectionRepositoryError
  >;
  readonly getByThreadIds: (input: {
    readonly threadIds: ReadonlyArray<ThreadId>;
  }) => Effect.Effect<
    ReadonlyMap<ThreadId, Schema.Schema.Type<typeof OrchestrationThreadGoal>>,
    ProjectionRepositoryError
  >;
  readonly upsert: (input: {
    readonly threadId: ThreadId;
    readonly goal: Schema.Schema.Type<typeof OrchestrationThreadGoal>;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly deleteByThreadId: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionThreadGoalRepository extends Context.Service<
  ProjectionThreadGoalRepository,
  ProjectionThreadGoalRepositoryShape
>()("t3/persistence/Services/ProjectionThreadGoals/ProjectionThreadGoalRepository") {}

const ProjectionThreadGoalDbRow = Schema.Struct({
  threadId: ThreadId,
  goal: Schema.fromJsonString(OrchestrationThreadGoal),
});

const ProjectionThreadGoalJson = Schema.fromJsonString(OrchestrationThreadGoal);
const encodeProjectionThreadGoalJson = Schema.encodeUnknownEffect(ProjectionThreadGoalJson);
const decodeProjectionThreadGoalJson = Schema.decodeUnknownEffect(ProjectionThreadGoalJson);

const LegacyGoalRow = Schema.Struct({
  threadId: ThreadId,
  goalJson: Schema.String,
});

const ListProjectionThreadGoalsInput = Schema.Struct({
  threadIds: Schema.Array(ThreadId),
});

const buildForkClientLayer = (forkDbPath: string) =>
  makeRuntimeSqliteLayer({
    filename: forkDbPath,
    spanAttributes: {
      "db.name": "state-tarik02.sqlite",
      "service.name": "t3-server",
    },
  });

const upsertGoal = Effect.fn("upsertGoal")(function* (input: {
  readonly threadId: ThreadId;
  readonly goal: Schema.Schema.Type<typeof OrchestrationThreadGoal>;
}) {
  const forkSql = yield* SqlClient.SqlClient;
  const goalJson = yield* encodeProjectionThreadGoalJson(input.goal);
  yield* forkSql`
    INSERT INTO projection_thread_goals (thread_id, goal_json)
    VALUES (${input.threadId}, ${goalJson})
    ON CONFLICT(thread_id)
    DO UPDATE SET goal_json = excluded.goal_json
  `;
});

const deleteGoal = Effect.fn("deleteGoal")(function* (input: { readonly threadId: ThreadId }) {
  const forkSql = yield* SqlClient.SqlClient;
  yield* forkSql`
    DELETE FROM projection_thread_goals
    WHERE thread_id = ${input.threadId}
  `;
});

const listGoalsByThreadIds = Effect.fn("listGoalsByThreadIds")(function* (input: {
  readonly threadIds: ReadonlyArray<ThreadId>;
}) {
  const forkSql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findAll({
    Request: ListProjectionThreadGoalsInput,
    Result: ProjectionThreadGoalDbRow,
    execute: ({ threadIds }) =>
      forkSql`
        SELECT
          thread_id AS "threadId",
          goal_json AS "goal"
        FROM projection_thread_goals
        WHERE thread_id IN ${forkSql.in(threadIds)}
      `,
  })(input);
});

export const ProjectionThreadGoalRepositoryLive = Layer.effect(
  ProjectionThreadGoalRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const maybeServerConfig = yield* Effect.serviceOption(ServerConfig);
    const maybeFs = yield* Effect.serviceOption(FileSystem.FileSystem);
    const maybePath = yield* Effect.serviceOption(Path.Path);
    const forkDbPath = Option.match(maybeServerConfig, {
      onNone: () => ":memory:",
      onSome: (serverConfig) => serverConfig.forkDbPath,
    });

    if (Option.isSome(maybeFs) && Option.isSome(maybePath) && forkDbPath !== ":memory:") {
      yield* maybeFs.value.makeDirectory(maybePath.value.dirname(forkDbPath), { recursive: true });
    }

    const forkContext = yield* Layer.build(buildForkClientLayer(forkDbPath));

    const legacyGoalColumns = yield* sql<{ readonly name: string }>`
      PRAGMA table_info(projection_threads)
    `;
    const hasLegacyGoalColumn = legacyGoalColumns.some((column) => column.name === "goal_json");

    if (hasLegacyGoalColumn) {
      const legacyRows = yield* sql<Schema.Schema.Type<typeof LegacyGoalRow>>`
        SELECT
          thread_id AS "threadId",
          goal_json AS "goalJson"
        FROM projection_threads
        WHERE goal_json IS NOT NULL
      `;

      if (legacyRows.length > 0) {
        yield* ensureGoalTable().pipe(Effect.provide(forkContext));

        const decodedRows = yield* Effect.forEach(
          legacyRows,
          (row) =>
            decodeProjectionThreadGoalJson(row.goalJson).pipe(
              Effect.map((goal) => ({ threadId: row.threadId, goal })),
              Effect.mapError(
                toPersistenceSqlError("ProjectionThreadGoalRepository.backfill:decodeGoal"),
              ),
            ),
          { concurrency: "unbounded" },
        );

        yield* Effect.forEach(
          decodedRows,
          (row) => upsertGoal(row).pipe(Effect.provide(forkContext)),
          { concurrency: "unbounded" },
        );

        yield* sql`
          UPDATE projection_threads
          SET goal_json = NULL
          WHERE goal_json IS NOT NULL
        `;
      }
    }

    yield* ensureGoalTable().pipe(Effect.provide(forkContext));
    yield* runForkMigrations().pipe(Effect.provide(forkContext));

    const getByThreadId: ProjectionThreadGoalRepositoryShape["getByThreadId"] = (input) =>
      listGoalsByThreadIds({ threadIds: [input.threadId] }).pipe(
        Effect.map((rows) => Option.fromNullishOr(rows[0]?.goal)),
        Effect.mapError(
          toPersistenceSqlError("ProjectionThreadGoalRepository.getByThreadId:query"),
        ),
        Effect.provide(forkContext),
      );

    const getByThreadIds: ProjectionThreadGoalRepositoryShape["getByThreadIds"] = (input) =>
      listGoalsByThreadIds({ threadIds: input.threadIds }).pipe(
        Effect.map(
          (rows) =>
            new Map(rows.map((row) => [row.threadId, row.goal] as const)) as ReadonlyMap<
              ThreadId,
              Schema.Schema.Type<typeof OrchestrationThreadGoal>
            >,
        ),
        Effect.mapError(
          toPersistenceSqlError("ProjectionThreadGoalRepository.getByThreadIds:query"),
        ),
        Effect.provide(forkContext),
      );

    const upsert: ProjectionThreadGoalRepositoryShape["upsert"] = (input) =>
      upsertGoal(input).pipe(
        Effect.mapError(toPersistenceSqlError("ProjectionThreadGoalRepository.upsert:query")),
        Effect.provide(forkContext),
      );

    const deleteByThreadId: ProjectionThreadGoalRepositoryShape["deleteByThreadId"] = (input) =>
      deleteGoal(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionThreadGoalRepository.deleteByThreadId:query"),
        ),
        Effect.provide(forkContext),
      );

    return {
      getByThreadId,
      getByThreadIds,
      upsert,
      deleteByThreadId,
    } satisfies ProjectionThreadGoalRepositoryShape;
  }),
);
