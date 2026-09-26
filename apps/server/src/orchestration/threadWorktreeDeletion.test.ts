import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  OrchestrationDispatchCommandError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ServerConfig } from "../config.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { removeUnusedWorktree, withThreadWorktreeDeletion } from "./threadWorktreeDeletion.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";

const TestLayer = Layer.merge(
  Git.layer,
  Layer.mock(OrchestrationEngineService)({ withWorktreeCleanup: (_paths, effect) => effect }),
).pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-delete-test-" })),
  Layer.provideMerge(NodeServices.layer),
);
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* Git.GitVcsDriver;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-delete-worktree-" });
  const cwd = path.join(root, "repo");
  const worktree = path.join(root, "worktree");
  yield* fs.makeDirectory(cwd);
  const run = (args: string[], directory = cwd) =>
    git.execute({ operation: "test", cwd: directory, args });
  yield* run(["init", "--initial-branch=main"]);
  yield* run(["config", "user.name", "Test"]);
  yield* run(["config", "user.email", "test@example.com"]);
  yield* fs.writeFileString(path.join(cwd, "tracked"), "original");
  yield* fs.writeFileString(path.join(cwd, ".gitignore"), "ignored\n");
  yield* run(["add", "."]);
  yield* run(["commit", "-m", "initial"]);
  yield* run(["worktree", "add", "-b", "test", worktree]);
  yield* fs.writeFileString(path.join(worktree, "tracked"), "staged");
  yield* run(["add", "tracked"], worktree);
  yield* fs.writeFileString(path.join(worktree, "tracked"), "unstaged");
  yield* fs.writeFileString(path.join(worktree, "untracked"), "untracked contents");
  yield* fs.writeFileString(path.join(worktree, "ignored"), "ignored contents");
  let snapshot = createEmptyReadModel("2026-09-17T00:00:00.000Z");
  const threadId = ThreadId.make("thread");
  const projectId = ProjectId.make("project");
  const commands: OrchestrationCommand[] = [
    {
      type: "project.create",
      commandId: CommandId.make("project"),
      projectId,
      title: "Test",
      workspaceRoot: cwd,
      createdAt: snapshot.updatedAt,
    },
    {
      type: "thread.create",
      commandId: CommandId.make("thread"),
      projectId,
      threadId,
      title: "Test",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "test",
      worktreePath: worktree,
      createdAt: snapshot.updatedAt,
    },
  ];
  for (const command of commands) {
    const decided = yield* decideOrchestrationCommand({ command, readModel: snapshot });
    for (const event of Array.isArray(decided) ? decided : [decided])
      snapshot = yield* projectEvent(snapshot, {
        ...event,
        sequence: snapshot.snapshotSequence + 1,
      });
  }
  const command = {
    type: "thread.delete",
    commandId: CommandId.make("delete"),
    threadId,
    deleteWorktreePath: worktree,
  } as const;
  const crypto = yield* Crypto.Crypto;
  let snapshotError: PersistenceSqlError | null = null;
  const snapshots = Layer.mock(ProjectionSnapshotQuery)({
    getCommandReadModel: () =>
      snapshotError ? Effect.fail(snapshotError) : Effect.succeed(snapshot),
  });
  const execute = <E, AfterError = never>(
    commit: Effect.Effect<{ sequence: number }, E>,
    afterCommit: Effect.Effect<void, AfterError> = Effect.void,
  ) =>
    withThreadWorktreeDeletion(command, (staged) =>
      Effect.gen(function* () {
        const result = yield* commit;
        const decided = yield* decideOrchestrationCommand({
          command: staged ? command : { ...command, deleteWorktreePath: undefined },
          readModel: snapshot,
        });
        for (const event of Array.isArray(decided) ? decided : [decided]) {
          snapshot = yield* projectEvent(snapshot, {
            ...event,
            sequence: snapshot.snapshotSequence + 1,
          });
        }
        yield* afterCommit;
        return result;
      }).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.mapError((error) =>
          Schema.is(OrchestrationDispatchCommandError)(error)
            ? error
            : new OrchestrationDispatchCommandError({
                message: "test commit failed",
                cause: error,
              }),
        ),
      ),
    ).pipe(Effect.provide(snapshots));

  return {
    fs,
    path,
    git,
    run,
    cwd,
    root,
    worktree,
    command,
    execute,
    retryCleanup: (target: string) => {
      const input = { cwd, path: target, force: true };
      return removeUnusedWorktree(input, git.removeWorktree(input)).pipe(Effect.provide(snapshots));
    },
    snapshot,
    getSnapshot: () => snapshot,
    failSnapshotRead: () => {
      snapshotError = new PersistenceSqlError({ operation: "test snapshot read" });
    },
    setSnapshot: (next: typeof snapshot) => {
      snapshot = next;
    },
  };
});

it.layer(TestLayer)("recoverable worktree deletion", (it) => {
  it.effect(
    "restores staged, unstaged, untracked and ignored contents when thread deletion fails",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        let committed = false;
        const failure = new OrchestrationDispatchCommandError({
          message: "database rejected deletion",
        });
        const result = yield* f
          .execute(
            Effect.gen(function* () {
              expect(yield* f.fs.exists(f.worktree)).toBe(false);
              committed = true;
              return yield* failure;
            }),
          )
          .pipe(Effect.flip);
        expect(result).toBe(failure);
        expect(committed).toBe(true);
        expect(yield* f.fs.readFileString(f.path.join(f.worktree, "tracked"))).toBe("unstaged");
        expect((yield* f.run(["show", ":tracked"], f.worktree)).stdout).toBe("staged");
        expect(yield* f.fs.readFileString(f.path.join(f.worktree, "untracked"))).toBe(
          "untracked contents",
        );
        expect(yield* f.fs.readFileString(f.path.join(f.worktree, "ignored"))).toBe(
          "ignored contents",
        );
        expect(
          (yield* f.run(["rev-parse", "--abbrev-ref", "HEAD"], f.worktree)).stdout.trim(),
        ).toBe("test");
        expect((yield* f.execute(Effect.succeed({ sequence: 3 }))).sequence).toBe(3);
        expect(yield* f.fs.exists(f.worktree)).toBe(false);
        expect(yield* f.fs.readDirectory(f.root)).toEqual(["repo"]);
      }),
  );

  it.effect("does not delete the thread or change files when the worktree is locked", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.run(["worktree", "lock", f.worktree]);
      let committed = false;
      yield* f
        .execute(
          Effect.sync(() => {
            committed = true;
            return { sequence: 3 };
          }),
        )
        .pipe(Effect.flip);
      expect(committed).toBe(false);
      expect(yield* f.fs.readFileString(f.path.join(f.worktree, "tracked"))).toBe("unstaged");
      expect(yield* f.fs.readDirectory(f.root)).toEqual(["repo", "worktree"]);
    }),
  );

  it.effect("keeps recovery files when rollback is blocked, then restores them on retry", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f
        .execute(
          Effect.gen(function* () {
            yield* f.fs.makeDirectory(f.worktree);
            yield* f.fs.writeFileString(f.path.join(f.worktree, "replacement"), "do not overwrite");
            return yield* new OrchestrationDispatchCommandError({ message: "commit failed" });
          }),
        )
        .pipe(Effect.flip);
      const staged = (yield* f.fs.readDirectory(f.root)).find((name) =>
        name.startsWith(".t3-delete-"),
      )!;
      expect(yield* f.fs.readFileString(f.path.join(f.root, staged, "ignored"))).toBe(
        "ignored contents",
      );
      expect(yield* f.fs.readFileString(f.path.join(f.worktree, "replacement"))).toBe(
        "do not overwrite",
      );
      yield* f.fs.remove(f.worktree, { recursive: true });
      // Same on-disk state as a server exiting after staging and before committing.
      yield* f
        .execute(Effect.fail(new OrchestrationDispatchCommandError({ message: "still offline" })))
        .pipe(Effect.flip);
      expect(yield* f.fs.readFileString(f.path.join(f.worktree, "ignored"))).toBe(
        "ignored contents",
      );
      expect((yield* f.run(["show", ":tracked"], f.worktree)).stdout).toBe("staged");
    }),
  );

  it.effect("keeps a worktree used by an archived thread", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const thread = f.snapshot.threads[0]!;
      f.setSnapshot({
        ...f.snapshot,
        threads: [
          ...f.snapshot.threads,
          { ...thread, id: ThreadId.make("archived"), archivedAt: thread.createdAt },
        ],
      });
      yield* f.execute(Effect.succeed({ sequence: 3 }));
      expect(yield* f.fs.exists(f.worktree)).toBe(true);
    }),
  );

  it.effect("rolls back when another thread starts sharing the worktree during staging", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const thread = f.snapshot.threads[0]!;
      const result = yield* f
        .execute(
          Effect.sync(() => {
            f.setSnapshot({
              ...f.snapshot,
              threads: [...f.snapshot.threads, { ...thread, id: ThreadId.make("new-sharer") }],
            });
            return { sequence: 3 };
          }),
        )
        .pipe(Effect.flip);
      expect(result.message).toBe("test commit failed");
      expect(yield* f.fs.readFileString(f.path.join(f.worktree, "ignored"))).toBe(
        "ignored contents",
      );
      expect((yield* f.run(["show", ":tracked"], f.worktree)).stdout).toBe("staged");
    }),
  );

  it.effect("rolls back when the target changes worktrees during staging", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f
        .execute(
          Effect.sync(() => {
            f.setSnapshot({
              ...f.snapshot,
              threads: f.snapshot.threads.map((thread) => ({
                ...thread,
                worktreePath: f.path.join(f.root, "other"),
              })),
            });
            return { sequence: 3 };
          }),
        )
        .pipe(Effect.flip);
      expect(yield* f.fs.readFileString(f.path.join(f.worktree, "ignored"))).toBe(
        "ignored contents",
      );
    }),
  );

  it.effect("returns a cleanup retry path when final removal fails after the thread commits", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const result = yield* f.execute(
        Effect.gen(function* () {
          const staged = (yield* f.fs.readDirectory(f.root)).find((name) =>
            name.startsWith(".t3-delete-"),
          )!;
          yield* f.run(["worktree", "lock", f.path.join(f.root, staged)]);
          return { sequence: 3 };
        }),
      );
      expect(result.sequence).toBe(3);
      expect(result.worktreeCleanupPending?.cwd).toBe(f.cwd);
      const staged = result.worktreeCleanupPending!.path;
      expect(yield* f.fs.readFileString(f.path.join(staged, "ignored"))).toBe("ignored contents");
      yield* f.run(["worktree", "unlock", staged]);
      const snapshot = f.getSnapshot();
      for (const archivedAt of [null, "2026-09-17T00:00:00.000Z"]) {
        f.setSnapshot({
          ...snapshot,
          threads: [
            ...snapshot.threads,
            {
              ...f.snapshot.threads[0]!,
              id: ThreadId.make("new-user"),
              worktreePath: staged,
              archivedAt,
            },
          ],
        });
        const failure = yield* f.retryCleanup(staged).pipe(Effect.flip);
        expect(failure.message).toContain("still used by a thread");
        expect(yield* f.fs.readFileString(f.path.join(staged, "ignored"))).toBe("ignored contents");
        expect((yield* f.run(["show", ":tracked"], staged)).stdout).toBe("staged");
      }
      f.setSnapshot(snapshot);
      yield* f.retryCleanup(staged);
      expect(yield* f.fs.exists(staged)).toBe(false);
    }),
  );

  it.effect("keeps files if cleanup retry cannot read current references", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.failSnapshotRead();
      const failure = yield* f.retryCleanup(f.worktree).pipe(Effect.flip);
      expect(failure.message).toContain("Could not verify worktree references");
      expect(yield* f.fs.readFileString(f.path.join(f.worktree, "ignored"))).toBe(
        "ignored contents",
      );
    }),
  );

  it.effect("restores files if a deduplicated receipt did not delete the current thread", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* withThreadWorktreeDeletion(f.command, () => Effect.succeed({ sequence: 1 })).pipe(
        Effect.provide(
          Layer.mock(ProjectionSnapshotQuery)({
            getCommandReadModel: () => Effect.succeed(f.snapshot),
          }),
        ),
        Effect.flip,
      );
      expect(yield* f.fs.readFileString(f.path.join(f.worktree, "ignored"))).toBe(
        "ignored contents",
      );
      expect((yield* f.run(["show", ":tracked"], f.worktree)).stdout).toBe("staged");
      expect(yield* f.fs.readDirectory(f.root)).toEqual(["repo", "worktree"]);
    }),
  );

  it.effect("reports cleanup uncertainty as success after a committed deletion", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const result = yield* f.execute(
        Effect.succeed({ sequence: 3 }),
        Effect.sync(f.failSnapshotRead),
      );
      expect(result.sequence).toBe(3);
      expect(
        f
          .getSnapshot()
          .threads.some((thread) => thread.id === f.command.threadId && thread.deletedAt === null),
      ).toBe(false);
      expect(result.worktreeCleanupPending?.retryable).toBe(false);
      expect(
        yield* f.fs.readFileString(f.path.join(result.worktreeCleanupPending!.path, "ignored")),
      ).toBe("ignored contents");
    }),
  );

  it.effect("keeps a staged worktree newly used by another thread without offering cleanup", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const originalThread = f.snapshot.threads[0]!;
      let survivorPath = "";
      const result = yield* f.execute(
        Effect.succeed({ sequence: 3 }),
        Effect.gen(function* () {
          const directory = (yield* f.fs.readDirectory(f.root)).find((name) =>
            name.startsWith(".t3-delete-"),
          )!;
          survivorPath = f.path.join(f.root, directory);
          const snapshot = f.getSnapshot();
          f.setSnapshot({
            ...snapshot,
            threads: [
              ...snapshot.threads,
              {
                ...originalThread,
                id: ThreadId.make("staged-survivor"),
                worktreePath: survivorPath,
              },
            ],
          });
        }),
      );
      expect(result.worktreeCleanupPending).toBeUndefined();
      expect(yield* f.fs.exists(f.worktree)).toBe(false);
      expect(yield* f.fs.readFileString(f.path.join(survivorPath, "ignored"))).toBe(
        "ignored contents",
      );
      expect((yield* f.run(["show", ":tracked"], survivorPath)).stdout).toBe("staged");
    }),
  );
});
