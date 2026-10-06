import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import type { NativeThreadRef, T3ThreadRef, UsageAttributionIndex } from "./usageThreadIndex.ts";

export class UsageAttributionError extends Schema.TaggedError<UsageAttributionError>()(
  "UsageAttributionError",
  {
    /** Which read failed. */
    stage: Schema.Literals(["providerThreads", "subagents", "threads", "projects"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not read ${this.stage} for usage attribution.`;
  }
}

const failedAt =
  (stage: UsageAttributionError["stage"]) =>
  <A, E, R>(read: Effect.Effect<A, E, R>) =>
    read.pipe(Effect.mapError((cause) => new UsageAttributionError({ stage, cause })));

const NativeRow = Schema.Struct({
  driver: Schema.String,
  nativeId: Schema.String,
  threadId: ThreadId,
  instanceId: Schema.NullOr(Schema.String),
});

const ThreadRow = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.NullOr(Schema.String),
  parentThreadId: Schema.NullOr(ThreadId),
});

/**
 * Reads which T3 thread each provider session and provider sub-agent belongs
 * to, with thread lineage and every project, including archived and deleted
 * ones so their past usage keeps its place.
 */
export class UsageAttribution extends Context.Service<
  UsageAttribution,
  { readonly read: Effect.Effect<UsageAttributionIndex, UsageAttributionError> }
>()("t3/usage/UsageAttribution") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projectStore = yield* ProjectStore.ProjectStoreV2;

  const selectNativeThreads = SqlSchema.findAll({
    Request: Schema.Void,
    Result: NativeRow,
    execute: () => sql`
      SELECT
        driver,
        json_extract(payload_json, '$.nativeThreadRef.nativeId') AS "nativeId",
        thread_id AS "threadId",
        provider_instance_id AS "instanceId"
      FROM orchestration_v2_projection_provider_threads
      WHERE thread_id IS NOT NULL
        AND driver IS NOT NULL
        AND json_extract(payload_json, '$.nativeThreadRef.nativeId') IS NOT NULL
    `,
  });

  const selectNativeSubagents = SqlSchema.findAll({
    Request: Schema.Void,
    Result: NativeRow,
    execute: () => sql`
      SELECT
        driver,
        json_extract(payload_json, '$.nativeTaskRef.nativeId') AS "nativeId",
        child_thread_id AS "threadId",
        provider_instance_id AS "instanceId"
      FROM orchestration_v2_projection_subagents
      WHERE child_thread_id IS NOT NULL
        AND driver IS NOT NULL
        AND json_extract(payload_json, '$.nativeTaskRef.nativeId') IS NOT NULL
    `,
  });

  const selectThreads = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ThreadRow,
    execute: () => sql`
      SELECT
        thread_id AS "threadId",
        project_id AS "projectId",
        title,
        json_extract(payload_json, '$.lineage.parentThreadId') AS "parentThreadId"
      FROM orchestration_v2_projection_threads
    `,
  });

  const byNativeId = (rows: ReadonlyArray<typeof NativeRow.Type>) => {
    const map = new Map<string, NativeThreadRef>();
    for (const row of rows) {
      map.set(`${row.driver}\u0000${row.nativeId}`, {
        threadId: row.threadId,
        instanceId: row.instanceId,
      });
    }
    return map;
  };

  const read = Effect.all(
    [
      selectNativeThreads(undefined).pipe(failedAt("providerThreads")),
      selectNativeSubagents(undefined).pipe(failedAt("subagents")),
      selectThreads(undefined).pipe(failedAt("threads")),
      projectStore.list({ includeDeleted: true }).pipe(failedAt("projects")),
    ],
    { concurrency: 1 },
  ).pipe(
    Effect.map(([nativeThreads, nativeSubagents, threads, projects]) => ({
      nativeThreads: byNativeId(nativeThreads),
      nativeSubagents: byNativeId(nativeSubagents),
      threads: new Map<string, T3ThreadRef>(
        threads.map((row) => [
          row.threadId,
          {
            projectId: row.projectId,
            title: row.title?.trim() || null,
            parentThreadId: row.parentThreadId,
          },
        ]),
      ),
      projects: projects.map((project) => ({
        projectId: project.projectId,
        title: project.title,
        workspaceRoot: project.workspaceRoot,
        deleted: project.deletedAt !== null,
      })),
    })),
    Effect.withSpan("UsageAttribution.read"),
  );

  return UsageAttribution.of({ read });
});

export const layer = Layer.effect(UsageAttribution, make);
