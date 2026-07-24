import { ProjectId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import { SidebarState, SidebarStateLive } from "./sidebarState.ts";

const layer = it.layer(SidebarStateLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

layer("SidebarState", (it) => {
  it.effect("shares ordered pins between independent subscribers", () =>
    Effect.gen(function* () {
      const sidebarState = yield* SidebarState;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("project-1");
      const thread1 = ThreadId.make("thread-1");
      const thread2 = ThreadId.make("thread-2");

      const firstClient = yield* sidebarState.changes.pipe(
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );
      const secondClient = yield* sidebarState.changes.pipe(
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;

      yield* sidebarState.update({
        mutationId: "pin-thread-1",
        type: "set-pinned",
        projectKey: projectId,
        threadKey: thread1,
        pinned: true,
      });
      const updated = yield* sidebarState.update({
        mutationId: "pin-thread-2",
        type: "set-pinned",
        projectKey: projectId,
        threadKey: thread2,
        pinned: true,
      });

      assert.deepStrictEqual(updated.pinnedThreadKeysByProjectKey[projectId], [thread2, thread1]);
      assert.strictEqual(updated.revision, 2);
      const [firstSnapshots, secondSnapshots] = yield* Effect.all([
        Fiber.join(firstClient),
        Fiber.join(secondClient),
      ]);
      assert.deepStrictEqual(Array.from(firstSnapshots), Array.from(secondSnapshots));
      assert.deepStrictEqual(Array.from(firstSnapshots).at(-1), updated);

      const rows = yield* sql<{ readonly threadKey: string; readonly position: number }>`
        SELECT thread_key AS "threadKey", position
        FROM sidebar_pinned_threads
        WHERE project_key = ${projectId}
        ORDER BY position ASC
      `;
      assert.deepStrictEqual(rows, [
        { threadKey: thread2, position: 0 },
        { threadKey: thread1, position: 1 },
      ]);
    }),
  );

  it.effect("merges concurrent legacy imports without dropping either profile's pins", () =>
    Effect.gen(function* () {
      const sidebarState = yield* SidebarState;
      const projectId = ProjectId.make("project-import");
      const alphaThread = ThreadId.make("thread-alpha");
      const devThread = ThreadId.make("thread-dev");

      yield* Effect.all(
        [
          sidebarState.update({
            mutationId: "import-alpha",
            type: "import-pins",
            pinnedThreadKeysByProjectKey: { [projectId]: [alphaThread] },
          }),
          sidebarState.update({
            mutationId: "import-dev",
            type: "import-pins",
            pinnedThreadKeysByProjectKey: { [projectId]: [devThread] },
          }),
        ],
        { concurrency: "unbounded" },
      );

      const snapshot = yield* sidebarState.get;
      assert.deepStrictEqual(
        new Set(snapshot.pinnedThreadKeysByProjectKey[projectId]),
        new Set([alphaThread, devThread]),
      );
    }),
  );

  it.effect("deduplicates a retried reorder after its response is lost", () =>
    Effect.gen(function* () {
      const sidebarState = yield* SidebarState;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("project-reorder");
      const thread1 = ThreadId.make("thread-1");
      const thread2 = ThreadId.make("thread-2");
      const thread3 = ThreadId.make("thread-3");

      for (const [index, threadKey] of [thread1, thread2, thread3].entries()) {
        yield* sidebarState.update({
          mutationId: `pin-reorder-${index}`,
          type: "set-pinned",
          projectKey: projectId,
          threadKey,
          pinned: true,
        });
      }

      const mutation = {
        mutationId: "reorder-once",
        type: "reorder-pinned",
        projectKey: projectId,
        draggedThreadKey: thread3,
        targetThreadKey: thread1,
      } as const;
      const first = yield* sidebarState.update(mutation);
      const retried = yield* sidebarState.update(mutation);

      assert.deepStrictEqual(first.pinnedThreadKeysByProjectKey[projectId], [
        thread2,
        thread1,
        thread3,
      ]);
      assert.deepStrictEqual(retried, first);
      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM sidebar_applied_mutations
        WHERE mutation_id = ${mutation.mutationId}
      `;
      assert.deepStrictEqual(rows, [{ count: 1 }]);
    }),
  );
});
