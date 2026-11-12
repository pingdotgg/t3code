import { assert, it } from "@effect/vitest";
import {
  EventId,
  type OrchestrationProjectShell,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  ThreadFolderId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as TestClock from "effect/testing/TestClock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { liveThreadShell, idleThreadProjection } from "../mcp/McpToolAccess.testkit.ts";
import * as ThreadFolderAutoFileReactor from "./ThreadFolderAutoFileReactor.ts";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ThreadFolderService from "./ThreadFolderService.ts";

const live = ThreadId.make("thread:live");
const other = ThreadId.make("thread:other");
const archived = ThreadId.make("thread:archived");
const subagent = ThreadId.make("thread:subagent");
const deleted = ThreadId.make("thread:deleted");
const reviews = ThreadFolderId.make("folder:reviews");
const fixes = ThreadFolderId.make("folder:fixes");
const web = ThreadFolderId.make("folder:web");

// Shells take their title and settled flag from the seeded row, so a test can change them with SQL.
const projectionLayer = Layer.unwrap(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const titled = (shell: OrchestrationV2ThreadShell) =>
      sql<{ readonly title: string; readonly payload_json: string }>`
        SELECT title, payload_json FROM orchestration_v2_projection_threads
        WHERE thread_id = ${shell.id}
      `.pipe(
        Effect.orDie,
        Effect.map((rows) => ({
          ...onBranch(shell),
          title: rows[0]?.title ?? shell.title,
          settledOverride: rows[0]?.payload_json === "settled" ? ("settled" as const) : null,
        })),
      );
    return Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getShellSnapshot: () =>
        sql<{ readonly thread_id: ThreadId }>`
          SELECT thread_id FROM orchestration_v2_projection_threads WHERE project_id = 'project:bulk'
        `.pipe(
          Effect.orDie,
          Effect.flatMap((bulk) =>
            Effect.forEach(
              [
                liveThreadShell(live),
                liveThreadShell(other),
                {
                  ...liveThreadShell(subagent),
                  lineage: {
                    rootThreadId: live,
                    parentThreadId: live,
                    relationshipToParent: "subagent" as const,
                  },
                },
                ...bulk.map((row) => liveThreadShell(row.thread_id)),
              ],
              titled,
            ),
          ),
          Effect.map((threads) => ({
            schemaVersion: 1,
            snapshotSequence: 0,
            threads,
            archivedThreads: [],
          })),
        ),
      getThreadShell: (threadId) =>
        Effect.succeed<OrchestrationV2ThreadShell | null>(
          threadId === deleted
            ? { ...liveThreadShell(threadId), deletedAt: liveThreadShell(threadId).createdAt }
            : threadId === archived
              ? { ...liveThreadShell(threadId), archivedAt: liveThreadShell(threadId).createdAt }
              : threadId === subagent
                ? {
                    ...liveThreadShell(threadId),
                    lineage: {
                      rootThreadId: live,
                      parentThreadId: live,
                      relationshipToParent: "subagent",
                    },
                  }
                : threadId === live || threadId === other
                  ? liveThreadShell(threadId)
                  : null,
        ).pipe(Effect.flatMap((shell) => (shell === null ? Effect.succeed(null) : titled(shell)))),
    });
  }),
);

const project = liveThreadShell(live).projectId;
const onBranch = (shell: OrchestrationV2ThreadShell) =>
  shell.id === live || shell.id === other ? { ...shell, branch: "feature/login" } : shell;
// Echoes the samples it was given so tests can assert on them.
const suggestionLayer = Layer.mergeAll(
  Layer.mock(ProjectStore.ProjectStoreV2)({
    listShells: () => Effect.succeed([{ id: project, title: "Web" } as OrchestrationProjectShell]),
  }),
  ServerSettings.layerTest(),
  Layer.mock(ServerConfig.ServerConfig)({ cwd: "/srv" } as never),
  Layer.unwrap(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return Layer.mock(TextGeneration.TextGeneration)({
        // A folder named "Racing" is renamed while the model runs.
        classifyThreadFolder: (input) =>
          (input.folderName === "Racing"
            ? sql`UPDATE thread_folders SET name = 'Renamed'`.pipe(Effect.orDie)
            : input.folderName === "Switching"
              ? sql`
                  UPDATE thread_folders
                  SET rule_json = '{"branches":["*"]}', rule_set_at = '2027-01-01T00:00:00.000Z'
                `.pipe(Effect.orDie)
              : Effect.void
          ).pipe(
            Effect.as({
              // "Web" names the threads' project, so they must be filed without the model.
              threadIds:
                input.folderName === "Web"
                  ? []
                  : [
                      ...input.threads.map((thread) => thread.id),
                      ...input.examples.map((title) => `example:${title}`),
                      "thread:invalid",
                    ],
            }),
          ),
      });
    }),
  ),
);

const layer = ThreadFolderService.layer.pipe(
  Layer.provide(Layer.merge(projectionLayer, suggestionLayer)),
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

const seedThreads = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const [threadId, deletedAt] of [
    [live, null],
    [other, null],
    [archived, null],
    [subagent, null],
    [deleted, "2026-01-02T00:00:00.000Z"],
  ] as const) {
    yield* sql`
      INSERT OR IGNORE INTO orchestration_v2_projection_threads ${sql.insert({
        thread_id: threadId,
        project_id: "project:test",
        title: threadId,
        default_provider: "codex",
        runtime_mode: "full-access",
        interaction_mode: "default",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        deleted_at: deletedAt,
        payload_json: "{}",
      })}
    `;
  }
});

it.layer(layer)("ThreadFolderService", (it) => {
  it.effect("files threads, moves them between folders, and unfiles them on delete", () =>
    Effect.gen(function* () {
      yield* seedThreads;
      const folders = yield* ThreadFolderService.ThreadFolderService;
      yield* folders.mutate({
        type: "folder.create",
        folderId: reviews,
        name: "Reviews",
        icon: { kind: "lucide", name: "eye", color: "violet" },
        threadIds: [live, other],
      });
      yield* folders.mutate({ type: "folder.create", folderId: fixes, name: "Fixes" });
      yield* folders.mutate({ type: "folder.reorder", folderId: reviews, beforeFolderId: fixes });
      yield* folders.mutate({
        type: "folder.move",
        threadIds: [other],
        folderId: fixes,
      });
      const moved = yield* folders.mutate({
        type: "folder.create",
        folderId: reviews,
        name: "Reviews",
        threadIds: [live, other, deleted],
      });
      assert.deepStrictEqual(
        moved.folders.map((folder) => [folder.id, folder.threadIds]),
        [
          [reviews, [live]],
          [fixes, [other]],
        ],
      );
      assert.deepStrictEqual(moved.folders[0]?.icon, {
        kind: "lucide",
        name: "eye",
        color: "violet",
      });

      const renamed = yield* folders.mutate({
        type: "folder.update",
        folderId: fixes,
        name: "Bug fixes",
        icon: null,
      });
      assert.deepStrictEqual(
        renamed.folders.map((folder) => [folder.name, folder.icon]),
        [
          ["Reviews", { kind: "lucide", name: "eye", color: "violet" }],
          ["Bug fixes", null],
        ],
      );

      const unfiled = yield* folders.mutate({
        type: "folder.move",
        threadIds: [live],
        folderId: null,
      });
      assert.deepStrictEqual(unfiled.folders[0]?.threadIds, []);

      const afterDelete = yield* folders.mutate({ type: "folder.delete", folderId: fixes });
      assert.deepStrictEqual(
        afterDelete.folders.map((folder) => folder.id),
        [reviews],
      );
      const refiled = yield* folders.mutate({
        type: "folder.move",
        threadIds: [other],
        folderId: reviews,
      });
      assert.deepStrictEqual(refiled.folders[0]?.threadIds, [other]);
    }),
  );

  it.effect("rejects missing folders and deleted or unknown threads without partial writes", () =>
    Effect.gen(function* () {
      const folders = yield* ThreadFolderService.ThreadFolderService;
      const before = yield* folders.list();
      const missingFolder = yield* folders
        .mutate({ type: "folder.move", threadIds: [live], folderId: ThreadFolderId.make("gone") })
        .pipe(Effect.flip);
      assert.match(missingFolder.message, /does not exist/);
      const deletedThread = yield* folders
        .mutate({
          type: "folder.create",
          folderId: ThreadFolderId.make("folder:partial"),
          name: "Partial",
          threadIds: [live, deleted],
        })
        .pipe(Effect.flip);
      assert.match(deletedThread.message, /does not exist/);
      const unknownUpdate = yield* folders
        .mutate({ type: "folder.update", folderId: ThreadFolderId.make("gone"), name: "x" })
        .pipe(Effect.flip);
      assert.match(unknownUpdate.message, /does not exist/);
      assert.deepStrictEqual(yield* folders.list(), before);
    }),
  );

  it.effect("re-emits the folder list to subscribers after each change", () =>
    Effect.gen(function* () {
      const folders = yield* ThreadFolderService.ThreadFolderService;
      const subscribed = yield* Deferred.make<void>();
      const fiber = yield* folders.subscribeList().pipe(
        Stream.tap(() => Deferred.succeed(subscribed, undefined)),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(subscribed);
      yield* folders.mutate({
        type: "folder.create",
        folderId: ThreadFolderId.make("folder:stream"),
        name: "Stream",
      });
      const emitted = Array.from(yield* Fiber.join(fiber));
      assert.isTrue(emitted[1]?.folders.some((folder) => folder.id === "folder:stream") ?? false);
    }),
  );
});

it.effect("orders folders and validates, defaults, and clears rules", () =>
  Effect.gen(function* () {
    const folders = yield* ThreadFolderService.ThreadFolderService;
    yield* folders.mutate({
      type: "folder.create",
      folderId: reviews,
      name: "Reviews",
      rule: { branches: ["main"] },
    });
    const created = yield* folders.mutate({
      type: "folder.create",
      folderId: fixes,
      name: "Fixes",
    });
    assert.deepStrictEqual(
      created.folders.map((f) => f.id),
      [fixes, reviews],
    );
    assert.isFalse(created.folders[1]!.autoFile);
    assert.isNotNull(created.folders[1]!.ruleSetAt);
    const reordered = yield* folders.mutate({
      type: "folder.reorder",
      folderId: reviews,
      beforeFolderId: fixes,
    });
    assert.deepStrictEqual(
      reordered.folders.map((f) => f.id),
      [reviews, fixes],
    );
    const repeated = yield* folders.mutate({
      type: "folder.reorder",
      folderId: reviews,
      beforeFolderId: fixes,
    });
    assert.deepStrictEqual(repeated, reordered);
    const ended = yield* folders.mutate({
      type: "folder.reorder",
      folderId: reviews,
      beforeFolderId: null,
    });
    assert.deepStrictEqual(
      ended.folders.map((f) => f.id),
      [fixes, reviews],
    );
    for (const mutation of [
      {
        type: "folder.create",
        folderId: ThreadFolderId.make("invalid-rule"),
        name: "Invalid",
        rule: {},
      },
      {
        type: "folder.create",
        folderId: ThreadFolderId.make("invalid-auto"),
        name: "Invalid",
        autoFile: true,
      },
      { type: "folder.update", folderId: fixes, rule: {} },
      { type: "folder.update", folderId: fixes, autoFile: true },
      { type: "folder.reorder", folderId: fixes, beforeFolderId: ThreadFolderId.make("missing") },
    ] as const) {
      const error = yield* folders.mutate(mutation).pipe(Effect.flip);
      assert.isUndefined(error.cause);
    }
    yield* folders.mutate({ type: "folder.update", folderId: reviews, autoFile: false });
    assert.isFalse((yield* folders.list()).folders[1]!.autoFile);
    yield* folders.mutate({ type: "folder.update", folderId: reviews, autoFile: true });
    assert.isTrue((yield* folders.list()).folders[1]!.autoFile);
    const cleared = yield* folders.mutate({ type: "folder.update", folderId: reviews, rule: null });
    assert.deepStrictEqual(
      [cleared.folders[1]!.rule, cleared.folders[1]!.autoFile, cleared.folders[1]!.ruleSetAt],
      [null, false, null],
    );
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE thread_folders SET rule_json = 'invalid' WHERE folder_id = ${reviews}`;
    assert.isNull((yield* folders.list()).folders[1]!.rule);
  }).pipe(Effect.provide(layer)),
);

const autoFileEvents = ["thread.created", "thread.provider-switched"] as const;
it.effect.each(autoFileEvents)("auto-files on %s", (eventType) =>
  Effect.gen(function* () {
    yield* seedThreads;
    const folders = yield* ThreadFolderService.ThreadFolderService;
    yield* TestClock.setTime(DateTime.toEpochMillis(liveThreadShell(live).createdAt) - 1);
    yield* folders.mutate({
      type: "folder.create",
      folderId: reviews,
      name: "Reviews",
      rule: { titleKeywords: ["thread"] },
      autoFile: true,
    });
    yield* folders.mutate({
      type: "folder.create",
      folderId: fixes,
      name: "Fixes",
      rule: { titleKeywords: ["thread"] },
      autoFile: true,
    });
    assert.deepStrictEqual((yield* folders.list()).folders[0]!.rule, {
      titleKeywords: ["thread"],
    });
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const processed = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      yield* Queue.offer(events, {
        type: eventType,
        id: EventId.make("event:folder-created"),
        threadId: live,
        occurredAt: liveThreadShell(live).createdAt,
        payload: idleThreadProjection(liveThreadShell(live)).thread,
      });
      yield* Deferred.await(processed);
    }).pipe(
      Effect.provide(
        ThreadFolderAutoFileReactor.layer.pipe(
          Layer.provide(
            Layer.mock(Orchestrator.OrchestratorV2)({
              streamDomainEvents: Stream.fromQueue(events).pipe(
                Stream.take(1),
                Stream.ensuring(Deferred.succeed(processed, undefined)),
              ),
            }),
          ),
        ),
      ),
    );
    assert.deepStrictEqual(
      (yield* folders.list()).folders.map((f) => f.threadIds),
      [[live], []],
    );
    yield* folders.mutate({ type: "folder.move", threadIds: [live], folderId: null });
    yield* folders.autoFile(live);
    assert.deepStrictEqual(
      (yield* folders.list()).folders.map((f) => f.threadIds),
      [[], []],
    );
    yield* folders.autoFile(archived);
    yield* folders.autoFile(subagent);
    yield* folders.autoFile(deleted);
    yield* TestClock.setTime(DateTime.toEpochMillis(liveThreadShell(live).createdAt) + 1);
    yield* folders.mutate({
      type: "folder.update",
      folderId: fixes,
      rule: { titleKeywords: ["thread"] },
      autoFile: true,
    });
    yield* folders.mutate({ type: "folder.update", folderId: reviews, rule: null });
    yield* folders.autoFile(other);
    yield* folders.autoFile(deleted);
    assert.deepStrictEqual(
      (yield* folders.list()).folders.map((f) => f.threadIds),
      [[], []],
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("applies a folder rule to existing unfiled threads", () =>
  Effect.gen(function* () {
    yield* seedThreads;
    const folders = yield* ThreadFolderService.ThreadFolderService;
    yield* folders.mutate({
      type: "folder.create",
      folderId: fixes,
      name: "Fixes",
      threadIds: [live],
    });
    yield* folders.mutate({
      type: "folder.create",
      folderId: reviews,
      name: "Reviews",
      rule: { titleKeywords: ["thread"] },
      autoFile: true,
    });
    const applied = yield* folders.mutate({ type: "folder.applyRule", folderId: reviews });
    assert.deepStrictEqual(
      applied.folders.map((f) => [f.id, f.threadIds]),
      [
        [reviews, [other]],
        [fixes, [live]],
      ],
    );
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "collects the branch a folder is named for, and adds related threads without a rule",
  () =>
    Effect.gen(function* () {
      yield* seedThreads;
      const folders = yield* ThreadFolderService.ThreadFolderService;
      yield* folders.mutate({
        type: "folder.create",
        folderId: fixes,
        name: "Fixes",
        threadIds: [live],
      });
      assert.deepStrictEqual((yield* folders.list()).folders[0]!.icon, {
        kind: "lucide",
        name: "bug",
        color: "red",
      });
      assert.isNull((yield* folders.list()).folders[0]!.rule);
      yield* folders.mutate(
        { type: "folder.update", folderId: fixes, name: "Login" },
        { inferRules: false },
      );
      yield* folders.mutate({
        type: "folder.update",
        folderId: fixes,
        name: "Login",
        autoFile: false,
      });
      assert.isNull((yield* folders.list()).folders[0]!.rule);
      yield* folders.mutate({ type: "folder.update", folderId: fixes, name: "Login" });
      const named = (yield* folders.list()).folders[0]!;
      assert.deepStrictEqual(
        [named.rule, named.autoFile, named.icon],
        [{ branches: ["feature/login"] }, true, { kind: "lucide", name: "folder", color: "gray" }],
      );
      yield* folders.mutate({ type: "folder.update", folderId: fixes, autoFile: false });
      const added = yield* folders.mutate({ type: "folder.applyRule", folderId: fixes });
      assert.deepStrictEqual(added.folders[0]!.threadIds, [live, other]);
      assert.isFalse(added.folders[0]!.autoFile);
      yield* folders.mutate({ type: "folder.create", folderId: reviews, name: "Reviews" });
      yield* folders.mutate({ type: "folder.move", threadIds: [other], folderId: reviews });
      assert.isNull((yield* folders.list()).folders[0]!.rule);
      yield* folders.mutate({ type: "folder.move", threadIds: [live], folderId: null });
      const smart = yield* folders.mutate({ type: "folder.applyRule", folderId: reviews });
      assert.deepStrictEqual(smart.folders[0]!.threadIds, [other, live]);
      yield* folders.mutate({ type: "folder.move", threadIds: [live, other], folderId: null });
      yield* folders.mutate({ type: "folder.create", folderId: web, name: "Web" });
      const byName = yield* folders.mutate({ type: "folder.applyRule", folderId: web });
      assert.deepStrictEqual(byName.folders[0]!.threadIds, [live, other]);
    }).pipe(Effect.provide(layer)),
);

it.effect("re-files an auto-filed thread when it stops matching, never a hand-moved one", () =>
  Effect.gen(function* () {
    yield* seedThreads;
    const sql = yield* SqlClient.SqlClient;
    const folders = yield* ThreadFolderService.ThreadFolderService;
    const rename = (threadId: ThreadId, title: string) =>
      sql`UPDATE orchestration_v2_projection_threads SET title = ${title} WHERE thread_id = ${threadId}`;
    const members = Effect.map(folders.list(), (result) => result.folders.map((f) => f.threadIds));
    yield* TestClock.setTime(DateTime.toEpochMillis(liveThreadShell(live).createdAt) - 1);
    yield* folders.mutate({
      type: "folder.create",
      folderId: reviews,
      name: "Reviews",
      rule: { titleKeywords: ["review"] },
      autoFile: true,
    });
    yield* folders.mutate({
      type: "folder.create",
      folderId: fixes,
      name: "Fixes",
      rule: { titleKeywords: ["fix"] },
      autoFile: true,
    });
    yield* rename(live, "Preview the review");
    yield* rename(other, "Review docs");
    yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = 'settled' WHERE thread_id = ${live}`;
    yield* folders.autoFile(live);
    assert.deepStrictEqual(yield* members, [[], []]);
    yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = '{}' WHERE thread_id = ${live}`;
    yield* folders.autoFile(live);
    yield* folders.mutate({ type: "folder.move", threadIds: [other], folderId: reviews });
    assert.deepStrictEqual(yield* members, [[], [live, other]]);
    yield* rename(live, "Fix the preview");
    yield* rename(other, "Docs");
    yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = 'settled' WHERE thread_id = ${live}`;
    yield* folders.autoFile(live);
    assert.deepStrictEqual(yield* members, [[], [live, other]]);
    yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = '{}' WHERE thread_id = ${live}`;
    yield* folders.autoFile(live);
    yield* folders.autoFile(other);
    assert.deepStrictEqual(yield* members, [[live], [other]]);
    yield* rename(live, "Docs");
    yield* folders.autoFile(live);
    assert.deepStrictEqual(yield* members, [[], [other]]);
    const docs = ThreadFolderId.make("folder:docs");
    yield* TestClock.setTime(DateTime.toEpochMillis(liveThreadShell(live).createdAt) + 1);
    yield* folders.mutate({
      type: "folder.create",
      folderId: docs,
      name: "Docs",
      rule: { titleKeywords: ["docs"] },
      autoFile: true,
    });
    yield* folders.mutate({ type: "folder.applyRule", folderId: docs });
    assert.deepStrictEqual(yield* members, [[live], [], [other]]);
    yield* rename(live, "Misc");
    yield* folders.autoFile(live);
    assert.deepStrictEqual(yield* members, [[], [], [other]]);
  }).pipe(Effect.provide(layer)),
);

it.effect("files validated title picks and batches only eligible smart threads", () =>
  Effect.gen(function* () {
    yield* seedThreads;
    const folders = yield* ThreadFolderService.ThreadFolderService;
    yield* TestClock.setTime(DateTime.toEpochMillis(liveThreadShell(live).createdAt) - 1);
    yield* folders.mutate({
      type: "folder.create",
      folderId: reviews,
      name: "Reviews",
      rule: { smart: true },
      autoFile: true,
    });
    assert.deepStrictEqual(yield* folders.smartCandidates(live), [
      { id: reviews, name: "Reviews", examples: [] },
    ]);
    assert.deepStrictEqual(yield* folders.smartCandidates(subagent), []);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = 'settled' WHERE thread_id = ${live}`;
    yield* folders.applySmartPick(live, reviews);
    assert.deepStrictEqual((yield* folders.list()).folders[0]!.threadIds, []);
    yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = '{}' WHERE thread_id = ${live}`;
    yield* folders.applySmartPick(live, "folder:invalid");
    assert.deepStrictEqual((yield* folders.list()).folders[0]!.threadIds, []);
    yield* folders.mutate({
      type: "folder.update",
      folderId: reviews,
      rule: { smart: true, titleKeywords: ["billing"] },
    });
    assert.deepStrictEqual(yield* folders.smartCandidates(live), []);
    yield* folders.applySmartPick(live, reviews);
    assert.deepStrictEqual((yield* folders.list()).folders[0]!.threadIds, []);
    yield* folders.mutate({ type: "folder.update", folderId: reviews, rule: { smart: true } });
    yield* folders.applySmartPick(live, reviews);
    assert.deepStrictEqual((yield* folders.list()).folders[0]!.threadIds, [live]);
    assert.deepStrictEqual(yield* folders.smartCandidates(live), []);
    yield* folders.autoFile(live);
    assert.deepStrictEqual((yield* folders.list()).folders[0]!.threadIds, [live]);
    yield* folders.mutate({ type: "folder.move", threadIds: [other], folderId: null });
    assert.deepStrictEqual(yield* folders.smartCandidates(other), []);
    yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = 'settled' WHERE thread_id = ${other}`;
    yield* folders.mutate({ type: "folder.applyRule", folderId: reviews });
    assert.deepStrictEqual((yield* folders.list()).folders[0]!.threadIds, [live]);
    yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = '{}' WHERE thread_id = ${other}`;
    yield* folders.mutate({ type: "folder.applyRule", folderId: reviews });
    assert.deepStrictEqual((yield* folders.list()).folders[0]!.threadIds, [live, other]);
    yield* sql`UPDATE orchestration_v2_projection_threads SET title = 'Review PR 12' WHERE thread_id = ${live}`;
    yield* folders.mutate({ type: "folder.move", threadIds: [live], folderId: reviews });
    yield* folders.mutate({ type: "folder.move", threadIds: [other], folderId: null });
    yield* sql`DELETE FROM thread_folder_explicit_moves WHERE thread_id = ${other}`;
    assert.deepStrictEqual(yield* folders.smartCandidates(other), [
      { id: reviews, name: "Reviews", examples: ["Review PR 12"] },
    ]);
    for (let index = 0; index < 100; index++) {
      yield* sql`
        INSERT INTO orchestration_v2_projection_threads ${sql.insert({
          thread_id: `thread:bulk-${index}`,
          project_id: "project:bulk",
          title: "Bulk",
          default_provider: "codex",
          runtime_mode: "full-access",
          interaction_mode: "default",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
          payload_json: "{}",
        })}
      `;
    }
    yield* folders.mutate({ type: "folder.applyRule", folderId: reviews });
    assert.strictEqual((yield* folders.list()).folders[0]!.threadIds.length, 102);
    yield* folders.mutate({ type: "folder.update", folderId: reviews, name: "Racing" });
    yield* folders.mutate({ type: "folder.move", threadIds: [other], folderId: null });
    yield* sql`DELETE FROM thread_folder_explicit_moves WHERE thread_id = ${other}`;
    const stale = yield* folders
      .mutate({ type: "folder.applyRule", folderId: reviews })
      .pipe(Effect.flip);
    assert.match(stale.message, /changed while threads were sorted/);
    assert.notInclude((yield* folders.list()).folders[0]!.threadIds, other);
    yield* folders.mutate({ type: "folder.update", folderId: reviews, name: "Switching" });
    const switched = yield* folders
      .mutate({ type: "folder.applyRule", folderId: reviews })
      .pipe(Effect.flip);
    assert.match(switched.message, /changed while threads were sorted/);
    assert.notInclude((yield* folders.list()).folders[0]!.threadIds, other);
  }).pipe(Effect.provide(layer)),
);
