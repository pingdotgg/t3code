import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, ProjectId, ThreadId } from "@t3tools/contracts";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationLayerLive } from "../../orchestration/runtimeLayer.ts";
import { CodexImport } from "../Services/CodexImport.ts";
import { CodexImportLive } from "./CodexImport.ts";

async function createCodexImportSystem() {
  const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-codex-import-test-",
  });
  const layer = Layer.mergeAll(
    CodexImportLive.pipe(Layer.provide(OrchestrationLayerLive)),
    OrchestrationLayerLive,
  ).pipe(
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolverLive),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(serverConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(layer);
  return {
    codexImport: await runtime.runPromise(Effect.service(CodexImport)),
    engine: await runtime.runPromise(Effect.service(OrchestrationEngineService)),
    snapshotQuery: await runtime.runPromise(Effect.service(ProjectionSnapshotQuery)),
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    dispose: () => runtime.dispose(),
  };
}

async function createCodexHome(sessionId: string, rawTranscript: string) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "t3-codex-import-"));
  const sessionsRoot = path.join(tempRoot, "sessions");
  await fs.mkdir(sessionsRoot, { recursive: true });
  await fs.writeFile(path.join(sessionsRoot, `rollout-${sessionId}.jsonl`), rawTranscript, "utf8");
  return tempRoot;
}

describe("CodexImportLive", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanupPaths
        .splice(0, cleanupPaths.length)
        .map((target) => fs.rm(target, { recursive: true, force: true })),
    );
  });

  it("imports a Codex transcript into a durable thread and marks repeat imports as existing", async () => {
    const sessionId = "codex-session-1";
    const codexHome = await createCodexHome(
      sessionId,
      [
        JSON.stringify({
          type: "turn_context",
          payload: {
            model: "gpt-5-codex",
            sandbox_policy: { type: "danger-full-access" },
            collaboration_mode: { mode: "plan" },
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-01T10:00:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Please debug the release checklist." }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-01T10:00:02.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "I found the flaky checklist step." }],
          },
        }),
      ].join("\n"),
    );
    cleanupPaths.push(codexHome);

    const system = await createCodexImportSystem();
    try {
      const projectId = ProjectId.make("project-codex-import");
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make(crypto.randomUUID()),
          projectId,
          title: "Codex Import Project",
          workspaceRoot: "/tmp/codex-import-project",
          defaultModelSelection: null,
          createdAt: "2026-04-01T09:59:00.000Z",
        }),
      );

      const sessionsBefore = await system.run(
        system.codexImport.listSessions({
          homePath: codexHome,
          kind: "all",
        }),
      );
      expect(sessionsBefore).toHaveLength(1);
      expect(sessionsBefore[0]).toMatchObject({
        sessionId,
        alreadyImported: false,
        importedThreadId: null,
      });

      const firstImport = await system.run(
        system.codexImport.importSessions({
          homePath: codexHome,
          targetProjectId: projectId,
          sessionIds: [sessionId],
        }),
      );
      expect(firstImport.results).toHaveLength(1);
      expect(firstImport.results[0]?.status).toBe("imported");
      expect(firstImport.results[0]?.projectId).toBe(projectId);

      const importedThreadId = firstImport.results[0]?.threadId;
      expect(importedThreadId).not.toBeNull();

      const importedThread = await system.run(
        system.snapshotQuery.getThreadDetailById(importedThreadId as ThreadId),
      );
      expect(importedThread._tag).toBe("Some");
      if (importedThread._tag === "Some") {
        expect(importedThread.value.title).toBe("Please debug the release checklist.");
        expect(importedThread.value.runtimeMode).toBe("full-access");
        expect(importedThread.value.interactionMode).toBe("plan");
        expect(importedThread.value.messages.map((message) => message.text)).toEqual([
          "Please debug the release checklist.",
          "I found the flaky checklist step.",
        ]);
        expect(
          importedThread.value.activities.some(
            (activity) => activity.kind === "codex-import.imported",
          ),
        ).toBe(true);
      }

      const sessionsAfter = await system.run(
        system.codexImport.listSessions({
          homePath: codexHome,
          kind: "all",
        }),
      );
      expect(sessionsAfter[0]).toMatchObject({
        sessionId,
        alreadyImported: true,
        importedThreadId,
      });

      const secondImport = await system.run(
        system.codexImport.importSessions({
          homePath: codexHome,
          targetProjectId: projectId,
          sessionIds: [sessionId],
        }),
      );
      expect(secondImport.results).toEqual([
        {
          sessionId,
          status: "skipped-existing",
          threadId: importedThreadId,
          projectId,
          error: null,
        },
      ]);
    } finally {
      await system.dispose();
    }
  });
});
