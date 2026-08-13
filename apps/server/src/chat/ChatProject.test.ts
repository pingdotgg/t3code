import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Path from "effect/Path";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils.ts";
import { ServerConfig } from "../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  chatScratchWorkspaceRoot,
  getOrCreateChatProject,
  prepareChatScratchCreateThread,
} from "./ChatProject.ts";

async function createChatProjectSystem() {
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-chat-project-test-",
  });
  const orchestrationLayer = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(orchestrationLayer);
  return {
    run: runtime.runPromise,
    dispose: () => runtime.dispose(),
  };
}

describe("ChatProject", () => {
  it("creates the synthetic chat project once and is idempotent under concurrency", async () => {
    const system = await createChatProjectSystem();
    try {
      const [first, second, concurrent] = await system.run(
        Effect.gen(function* () {
          const created = yield* getOrCreateChatProject();
          const again = yield* getOrCreateChatProject();
          const [left, right] = yield* Effect.all(
            [getOrCreateChatProject(), getOrCreateChatProject()],
            { concurrency: "unbounded" },
          );
          return [created, again, [left, right]] as const;
        }),
      );

      expect(first.kind).toBe("chat");
      expect(first.title).toBe("Chats");
      expect(second.id).toBe(first.id);
      expect(concurrent[0].id).toBe(first.id);
      expect(concurrent[1].id).toBe(first.id);

      const exists = await system.run(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          return yield* fileSystem.exists(first.workspaceRoot);
        }),
      );
      expect(exists).toBe(true);
    } finally {
      await system.dispose();
    }
  });

  it("heals a missing scratch directory on read", async () => {
    const system = await createChatProjectSystem();
    try {
      const healed = await system.run(
        Effect.gen(function* () {
          const created = yield* getOrCreateChatProject();
          const fileSystem = yield* FileSystem.FileSystem;
          yield* fileSystem.remove(created.workspaceRoot, { recursive: true });
          const missing = yield* fileSystem.exists(created.workspaceRoot);
          const restored = yield* getOrCreateChatProject();
          const exists = yield* fileSystem.exists(restored.workspaceRoot);
          return { missing, exists, sameId: created.id === restored.id };
        }),
      );

      expect(healed.missing).toBe(false);
      expect(healed.exists).toBe(true);
      expect(healed.sameId).toBe(true);
    } finally {
      await system.dispose();
    }
  });

  it("prepares a chat-scratch createThread under the synthetic project", async () => {
    const system = await createChatProjectSystem();
    try {
      const threadId = ThreadId.make("11111111-1111-4111-8111-111111111111");
      const result = await system.run(
        Effect.gen(function* () {
          const prepared = yield* prepareChatScratchCreateThread({
            threadId,
            createThread: {
              projectId: ProjectId.make("ignored"),
              title: "Hello",
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-5.4",
              },
              runtimeMode: DEFAULT_RUNTIME_MODE,
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              branch: "main",
              worktreePath: "/tmp/should-not-keep",
              createdAt: "2026-08-13T00:00:00.000Z",
              createInChatScratch: true,
            },
          });
          const engine = yield* OrchestrationEngineService;
          yield* engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make("22222222-2222-4222-8222-222222222222"),
            threadId,
            projectId: prepared.createThread.projectId,
            title: prepared.createThread.title,
            modelSelection: prepared.createThread.modelSelection,
            runtimeMode: prepared.createThread.runtimeMode,
            interactionMode: prepared.createThread.interactionMode,
            branch: prepared.createThread.branch,
            worktreePath: prepared.createThread.worktreePath,
            createdAt: prepared.createThread.createdAt,
          });
          const snapshotQuery = yield* ProjectionSnapshotQuery;
          const shell = yield* snapshotQuery.getShellSnapshot();
          const commandModel = yield* snapshotQuery.getCommandReadModel();
          const workspaceRoot = yield* chatScratchWorkspaceRoot();
          const path = yield* Path.Path;
          const fileSystem = yield* FileSystem.FileSystem;
          const worktreePath = prepared.createThread.worktreePath;
          const dirExists = worktreePath ? yield* fileSystem.exists(worktreePath) : false;
          return {
            prepared,
            shell,
            commandModel,
            workspaceRoot,
            expectedWorktreePath: path.join(workspaceRoot, threadId),
            dirExists,
          };
        }),
      );

      expect(result.prepared.skipPrepareWorktree).toBe(true);
      expect(result.prepared.createThread.branch).toBeNull();
      expect(result.prepared.createThread.worktreePath).toBe(result.expectedWorktreePath);
      expect(result.dirExists).toBe(true);
      expect(result.shell.projects.some((project) => project.kind === "chat")).toBe(false);
      expect(result.shell.projects.some((project) => project.title === "Chats")).toBe(false);
      expect(result.shell.threads.some((thread) => thread.id === threadId)).toBe(true);
      expect(
        result.commandModel.projects.some(
          (project) =>
            project.kind === "chat" && project.id === result.prepared.createThread.projectId,
        ),
      ).toBe(true);

      const cwd = resolveThreadWorkspaceCwd({
        thread: {
          projectId: result.prepared.createThread.projectId,
          worktreePath: result.prepared.createThread.worktreePath,
        },
        projects: result.commandModel.projects,
      });
      expect(cwd).toBe(result.expectedWorktreePath);
    } finally {
      await system.dispose();
    }
  });
});
