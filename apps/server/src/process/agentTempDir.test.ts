import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { type OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { make, removeThreadTempDirectories } from "./agentTempDir.ts";

/** A state directory and a linked worktree (`.git` is a file) under one temp root. */
const setup = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-agent-tmp-" });
  const worktree = path.join(root, "worktree");
  const plain = path.join(root, "plain");
  yield* fileSystem.makeDirectory(worktree);
  yield* fileSystem.makeDirectory(plain);
  yield* fileSystem.writeFileString(path.join(worktree, ".git"), "gitdir: elsewhere\n");
  const config = yield* ServerConfig.ServerConfig.pipe(
    Effect.provide(ServerConfig.layerTest(root, path.join(root, "home"))),
  );
  const tempDir = yield* make.pipe(
    Effect.provideService(ServerConfig.ServerConfig, config),
    Effect.provideService(HostProcess.Platform, "linux"),
  );
  return { fileSystem, path, worktree, plain, config, tempDir };
});

const projectionWithWorktree = (worktreePath: string | null) =>
  Layer.mock(ProjectionStoreV2)({
    getThreadShell: () => Effect.succeed({ worktreePath } as OrchestrationV2ThreadShell),
  });

describe("AgentTempDir", () => {
  it.effect("gives a worktree thread its own folder inside the worktree, ignored by git", () =>
    Effect.gen(function* () {
      const { fileSystem, path, worktree, tempDir } = yield* setup;
      const environment = yield* tempDir.environment({ threadId: "thread-a", cwd: worktree });

      const expected = path.join(worktree, ".t3", "tmp", "thread-a");
      assert.deepStrictEqual(environment, { TMPDIR: expected, CLAUDE_CODE_TMPDIR: expected });
      assert.isTrue(yield* fileSystem.exists(expected));
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(worktree, ".t3", "tmp", ".gitignore")),
        "*\n",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("uses the state directory for a thread outside a linked worktree", () =>
    Effect.gen(function* () {
      const { fileSystem, path, plain, config, tempDir } = yield* setup;
      const environment = yield* tempDir.environment({ threadId: "thread-b", cwd: plain });

      const expected = path.join(config.stateDir, "tmp", "thread-b");
      assert.strictEqual(environment.TMPDIR, expected);
      assert.isTrue(yield* fileSystem.exists(expected));
      assert.isFalse(yield* fileSystem.exists(path.join(plain, ".t3")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("settling removes only that thread's folders", () =>
    Effect.gen(function* () {
      const { fileSystem, worktree, plain, config, tempDir } = yield* setup;
      const settled = yield* tempDir.environment({ threadId: "thread-a", cwd: worktree });
      const sibling = yield* tempDir.environment({ threadId: "thread-c", cwd: worktree });
      const elsewhere = yield* tempDir.environment({ threadId: "thread-a", cwd: plain });

      yield* removeThreadTempDirectories(ThreadId.make("thread-a")).pipe(
        Effect.provide(projectionWithWorktree(worktree)),
        Effect.provideService(ServerConfig.ServerConfig, config),
      );

      assert.isFalse(yield* fileSystem.exists(settled.TMPDIR!));
      assert.isFalse(yield* fileSystem.exists(elsewhere.TMPDIR!));
      assert.isTrue(yield* fileSystem.exists(sibling.TMPDIR!));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps colons out of the folder and still cleans up old colon folders", () =>
    Effect.gen(function* () {
      const { fileSystem, path, worktree, config, tempDir } = yield* setup;
      const threadId = "thread:delegated-task:a%2Fb";
      const environment = yield* tempDir.environment({ threadId, cwd: worktree });
      const folder = path.basename(environment.TMPDIR!);
      assert.match(folder, /^[A-Za-z0-9._-]+$/);
      assert.notStrictEqual(
        folder,
        path.basename(
          (yield* tempDir.environment({ threadId: "thread-delegated-task-a-2Fb", cwd: worktree }))
            .TMPDIR!,
        ),
      );

      const legacy = path.join(config.stateDir, "tmp", threadId);
      yield* fileSystem.makeDirectory(legacy, { recursive: true });
      yield* removeThreadTempDirectories(ThreadId.make(threadId)).pipe(
        Effect.provide(projectionWithWorktree(worktree)),
        Effect.provideService(ServerConfig.ServerConfig, config),
      );
      assert.isFalse(yield* fileSystem.exists(environment.TMPDIR!));
      assert.isFalse(yield* fileSystem.exists(legacy));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("recreates a settled thread's folder on its next launch", () =>
    Effect.gen(function* () {
      const { fileSystem, worktree, config, tempDir } = yield* setup;
      const first = yield* tempDir.environment({ threadId: "thread-a", cwd: worktree });
      yield* removeThreadTempDirectories(ThreadId.make("thread-a")).pipe(
        Effect.provide(projectionWithWorktree(worktree)),
        Effect.provideService(ServerConfig.ServerConfig, config),
      );
      const again = yield* tempDir.environment({ threadId: "thread-a", cwd: worktree });

      assert.strictEqual(again.TMPDIR, first.TMPDIR);
      assert.isTrue(yield* fileSystem.exists(again.TMPDIR!));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
