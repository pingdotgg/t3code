import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { CommandId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as ServerConfig from "./config.ts";
import * as ServerSettings from "./serverSettings.ts";
import { seedLogfireTitleDemo } from "./logfireTitleDemo.ts";
import { OrchestrationEngineLive } from "./orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "./orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "./orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "./persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "./persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";

const corpus = `[{"id":"reconnect","previous_title":"Old title","baseline_title":"Tests passed successfully","messages":[{"role":"user","text":"Fix desktop reconnects"},{"role":"assistant","text":"The fix passes tests"}]}]`;
const unrelatedProjectId = ProjectId.make("unrelated");
const projectId = ProjectId.make("logfire-title-demo");
const threadId = ThreadId.make("logfire-title-reconnect");

function runtimeLayer(cwd: string, baseDir = `${cwd}/.t3`) {
  return Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
    ServerSettings.layerTest({
      projectSettingsOverrides: {
        [unrelatedProjectId]: { defaultAutoPull: true },
        [projectId]: { defaultAutoPull: true },
      },
    }),
  ).pipe(
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(cwd, baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );
}

it.layer(NodeServices.layer)("Logfire title demo seeder", (it) => {
  it.effect(
    "imports once, preserves corrected titles and unrelated settings, and starts no turns",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "title-demo-test-" });
        const corpusPath = `${cwd}/demos/logfire-titles/corpus.json`;
        yield* fs.makeDirectory(`${cwd}/demos/logfire-titles`, { recursive: true });
        yield* fs.makeDirectory(`${cwd}/apps/server`, { recursive: true });
        yield* fs.writeFileString(corpusPath, corpus);
        yield* Effect.gen(function* () {
          const engine = yield* OrchestrationEngineService;
          const query = yield* ProjectionSnapshotQuery;
          yield* seedLogfireTitleDemo(corpusPath);
          expect(
            (yield* query.getShellSnapshot()).projects.find((project) => project.id === projectId)
              ?.workspaceRoot,
          ).toBe(cwd);
          const first = Option.getOrThrow(yield* query.getThreadDetailById(threadId));
          expect(first.title).toBe("Tests passed successfully");
          expect(first.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
          expect(first.latestTurn).toBeNull();
          yield* engine.dispatch({
            type: "thread.meta.update",
            commandId: CommandId.make("correct-title"),
            threadId,
            title: "Fix Desktop Reconnects",
          });
          yield* seedLogfireTitleDemo(corpusPath);
          const second = Option.getOrThrow(yield* query.getThreadDetailById(threadId));
          expect(second.title).toBe("Fix Desktop Reconnects");
          expect(second.messages).toHaveLength(2);
          const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
          expect(settings.projectSettingsOverrides[unrelatedProjectId]?.defaultAutoPull).toBe(true);
          expect(settings.projectSettingsOverrides[projectId]?.defaultAutoPull).toBe(true);
          expect(
            settings.projectSettingsOverrides[projectId]?.textGenerationModelSelection?.model,
          ).toBe("gpt-6-luna");
          const events = yield* Stream.runCollect(engine.readEvents(0));
          expect(events.some((event) => event.type === "thread.turn-start-requested")).toBe(false);
        }).pipe(Effect.provide(runtimeLayer(`${cwd}/apps/server`, `${cwd}/.t3`)));
      }).pipe(Effect.scoped),
  );

  it.effect("resumes an interrupted seed after thread creation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "title-demo-test-" });
      const corpusPath = `${cwd}/demos/logfire-titles/corpus.json`;
      yield* fs.makeDirectory(`${cwd}/demos/logfire-titles`, { recursive: true });
      yield* fs.writeFileString(corpusPath, corpus);
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const createdAt = "2026-09-24T12:00:00.000Z";
        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("logfire-title-demo:project"),
          projectId,
          title: "Demo",
          workspaceRoot: cwd,
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${threadId}:create`),
          threadId,
          projectId,
          title: "Partially seeded title",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
          historyImport: true,
        });
        yield* seedLogfireTitleDemo(corpusPath);
        const thread = Option.getOrThrow(
          yield* (yield* ProjectionSnapshotQuery).getThreadDetailById(threadId),
        );
        expect(thread.title).toBe("Partially seeded title");
        expect(thread.messages).toHaveLength(2);
        expect(thread.latestTurn).toBeNull();
      }).pipe(Effect.provide(runtimeLayer(cwd)));
    }).pipe(Effect.scoped),
  );

  it.effect("rejects a .t3 symlink to another state directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "title-demo-test-" });
      yield* fs.makeDirectory(`${cwd}/external`);
      yield* fs.symlink(`${cwd}/external`, `${cwd}/.t3`);
      yield* Effect.gen(function* () {
        const result = yield* seedLogfireTitleDemo(`${cwd}/demos/logfire-titles/missing.json`).pipe(
          Effect.exit,
        );
        expect(result._tag).toBe("Failure");
        expect((yield* (yield* ProjectionSnapshotQuery).getShellSnapshot()).projects).toHaveLength(
          0,
        );
      }).pipe(Effect.provide(runtimeLayer(cwd)));
    }).pipe(Effect.scoped),
  );

  it.effect("rejects shared state before importing anything", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "title-demo-test-" });
      yield* Effect.gen(function* () {
        const result = yield* seedLogfireTitleDemo(
          `${cwd}/demos/logfire-titles/does-not-exist.json`,
        ).pipe(Effect.exit);
        expect(result._tag).toBe("Failure");
        expect((yield* (yield* ProjectionSnapshotQuery).getShellSnapshot()).projects).toHaveLength(
          0,
        );
      }).pipe(Effect.provide(runtimeLayer(cwd, `${cwd}/shared`)));
    }).pipe(Effect.scoped),
  );
});
