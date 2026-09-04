import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../src/persistence/NodeSqliteClient.ts";
import { listThreads, ThreadTransferError } from "./thread-transfer.ts";

interface FixtureInput {
  readonly stateDir: string;
  readonly projects: ReadonlyArray<{
    readonly projectId: string;
    readonly workspaceRoot: string;
    readonly deletedAt?: string;
  }>;
  readonly threads: ReadonlyArray<{
    readonly threadId: string;
    readonly projectId: string;
    readonly title: string;
    readonly updatedAt: string;
    readonly deletedAt?: string;
  }>;
}

/** Seeds the projection tables `thread:list` reads, mirroring the server's schema. */
const createFixtureDatabase = Effect.fn("createThreadListFixtureDatabase")(function* (
  input: FixtureInput,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const databasePath = path.join(input.stateDir, "state.sqlite");
  yield* fs.makeDirectory(input.stateDir, { recursive: true });
  yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE projection_projects (
      project_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      workspace_root TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )`;
    yield* sql`CREATE TABLE projection_threads (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )`;
    for (const project of input.projects) {
      yield* sql`INSERT INTO projection_projects (
        project_id, title, workspace_root, updated_at, deleted_at
      ) VALUES (
        ${project.projectId}, ${`Project ${project.projectId}`}, ${project.workspaceRoot},
        '2026-08-20T12:00:00.000Z', ${project.deletedAt ?? null}
      )`;
    }
    for (const thread of input.threads) {
      yield* sql`INSERT INTO projection_threads (
        thread_id, project_id, title, updated_at, deleted_at
      ) VALUES (
        ${thread.threadId}, ${thread.projectId}, ${thread.title}, ${thread.updatedAt},
        ${thread.deletedAt ?? null}
      )`;
    }
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath })));
  return databasePath;
});

it.layer(NodeServices.layer)("thread list", (it) => {
  it.effect("lists live projects and threads, newest thread first", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "thread-list-" });
      const workspace = path.join(root, "workspace");
      const otherWorkspace = path.join(root, "other");
      yield* createFixtureDatabase({
        stateDir: path.join(workspace, ".t3", "userdata"),
        projects: [
          { projectId: "project-b", workspaceRoot: otherWorkspace },
          { projectId: "project-a", workspaceRoot: workspace },
          {
            projectId: "project-gone",
            workspaceRoot: path.join(root, "gone"),
            deletedAt: "2026-08-21T13:00:00.000Z",
          },
        ],
        threads: [
          {
            threadId: "thread-old",
            projectId: "project-a",
            title: "Older thread",
            updatedAt: "2026-08-19T12:00:00.000Z",
          },
          {
            threadId: "thread-new",
            projectId: "project-b",
            title: "Newer\tthread",
            updatedAt: "2026-08-20T12:00:00.000Z",
          },
          {
            threadId: "thread-gone",
            projectId: "project-a",
            title: "Deleted thread",
            updatedAt: "2026-08-21T12:00:00.000Z",
            deletedAt: "2026-08-21T13:00:00.000Z",
          },
        ],
      });

      const listing = yield* listThreads({ source: workspace });
      assert.deepStrictEqual(listing, {
        projects: [
          {
            id: "project-b",
            title: "Project project-b",
            workspaceRoot: otherWorkspace,
            updatedAt: "2026-08-20T12:00:00.000Z",
          },
          {
            id: "project-a",
            title: "Project project-a",
            workspaceRoot: workspace,
            updatedAt: "2026-08-20T12:00:00.000Z",
          },
        ],
        threads: [
          {
            id: "thread-new",
            title: "Newer\tthread",
            projectId: "project-b",
            projectTitle: "Project project-b",
            workspaceRoot: otherWorkspace,
            updatedAt: "2026-08-20T12:00:00.000Z",
          },
          {
            id: "thread-old",
            title: "Older thread",
            projectId: "project-a",
            projectTitle: "Project project-a",
            workspaceRoot: workspace,
            updatedAt: "2026-08-19T12:00:00.000Z",
          },
        ],
      });
    }),
  );

  it.effect("resolves the base directory, a direct state directory, and --state dev", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "thread-list-state-" });
      const baseDir = path.join(root, ".t3");
      const thread = { title: "Thread", updatedAt: "2026-08-20T12:00:00.000Z" };
      yield* createFixtureDatabase({
        stateDir: path.join(baseDir, "userdata"),
        projects: [{ projectId: "project-userdata", workspaceRoot: root }],
        threads: [{ threadId: "thread-userdata", projectId: "project-userdata", ...thread }],
      });
      yield* createFixtureDatabase({
        stateDir: path.join(baseDir, "dev"),
        projects: [{ projectId: "project-dev", workspaceRoot: root }],
        threads: [{ threadId: "thread-dev", projectId: "project-dev", ...thread }],
      });

      const fromBase = yield* listThreads({ source: baseDir });
      assert.deepStrictEqual(
        fromBase.threads.map((entry) => entry.id),
        ["thread-userdata"],
      );
      const fromStateDir = yield* listThreads({ source: path.join(baseDir, "userdata") });
      assert.deepStrictEqual(fromStateDir, fromBase);
      const fromDev = yield* listThreads({ source: baseDir, state: "dev" });
      assert.deepStrictEqual(
        fromDev.projects.map((entry) => entry.id),
        ["project-dev"],
      );
      assert.deepStrictEqual(
        fromDev.threads.map((entry) => entry.id),
        ["thread-dev"],
      );
    }),
  );

  it.effect("reports every location it probed when no database exists", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "thread-list-missing-" });
      const error = yield* listThreads({ source: root }).pipe(Effect.flip);
      assert.instanceOf(error, ThreadTransferError);
      assert.equal(error.operation, "resolve directory");
      assert.equal(
        error.detail,
        `No T3 userdata database found at '${path.join(root, "state.sqlite")}', '${path.join(root, "userdata", "state.sqlite")}', or '${path.join(root, ".t3", "userdata", "state.sqlite")}'.`,
      );
    }),
  );
});
