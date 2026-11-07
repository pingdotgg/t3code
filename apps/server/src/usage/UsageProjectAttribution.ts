import { ProjectId, type UsageProject } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

export class UsageProjectAttributionReadError extends Schema.TaggedError<UsageProjectAttributionReadError>()(
  "UsageProjectAttributionReadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read provider session projects for usage.";
  }
}

const SessionProjectRow = Schema.Struct({
  driver: Schema.String,
  nativeId: Schema.String,
  projectId: ProjectId,
  title: Schema.String,
  workspaceRoot: Schema.String,
});

export const sessionKey = (driver: string, nativeId: string) => `${driver}\u0000${nativeId}`;

export class UsageProjectAttribution extends Context.Service<
  UsageProjectAttribution,
  {
    /** Keyed by `sessionKey`; deleted projects keep their past usage. */
    readonly read: Effect.Effect<
      ReadonlyMap<string, UsageProject>,
      UsageProjectAttributionReadError
    >;
  }
>()("t3/usage/UsageProjectAttribution") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Worktree threads keep their project's id, so their sessions land on the project.
  const selectSessionProjects = SqlSchema.findAll({
    Request: Schema.Void,
    Result: SessionProjectRow,
    execute: () => sql`
      SELECT
        provider_thread.driver AS "driver",
        json_extract(provider_thread.payload_json, '$.nativeThreadRef.nativeId') AS "nativeId",
        project.project_id AS "projectId",
        project.title AS "title",
        project.workspace_root AS "workspaceRoot"
      FROM orchestration_v2_projection_provider_threads AS provider_thread
      JOIN orchestration_v2_projection_threads AS thread
        ON thread.thread_id = provider_thread.thread_id
      JOIN projection_projects AS project
        ON project.project_id = thread.project_id
      WHERE provider_thread.driver IS NOT NULL
        AND json_extract(provider_thread.payload_json, '$.nativeThreadRef.nativeId') IS NOT NULL
    `,
  });

  const read = selectSessionProjects(undefined).pipe(
    NodeSqliteClient.readOnly,
    Effect.mapError((cause) => new UsageProjectAttributionReadError({ cause })),
    Effect.map((rows) => {
      const projects = new Map<string, UsageProject | null>();
      for (const row of rows) {
        const key = sessionKey(row.driver, row.nativeId);
        const existing = projects.get(key);
        // A session claimed by threads in different projects belongs to neither.
        if (existing !== undefined) {
          if (existing?.projectId !== row.projectId) projects.set(key, null);
          continue;
        }
        const title =
          row.title.trim() ||
          row.workspaceRoot.split(/[\\/]/).findLast((part) => part.length > 0) ||
          "Untitled project";
        projects.set(key, { projectId: row.projectId, title });
      }
      const resolved = new Map<string, UsageProject>();
      for (const [key, project] of projects) if (project !== null) resolved.set(key, project);
      return resolved;
    }),
    Effect.withSpan("UsageProjectAttribution.read"),
  );

  return UsageProjectAttribution.of({ read });
});

export const layer = Layer.effect(UsageProjectAttribution, make);
