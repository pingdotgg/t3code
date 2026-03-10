import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ProviderSession } from "@t3tools/contracts";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { derivePendingUserInputs } from "@t3tools/shared/pendingUserInput";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { ColdStartLifecycle } from "../Services/ColdStartLifecycle.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ColdStartLifecycleLive } from "./ColdStartLifecycle.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";

const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);

describe("ColdStartLifecycle", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    OrchestrationEngineService | ColdStartLifecycle,
    unknown
  > | null = null;
  const createdStateDirs = new Set<string>();

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    for (const stateDir of createdStateDirs) {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
    createdStateDirs.clear();
  });

  async function createHarness(input?: {
    readonly stateDir?: string;
    readonly sessions?: ReadonlyArray<ProviderSession>;
  }) {
    const now = new Date().toISOString();
    const stateDir =
      input?.stateDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "t3code-cold-start-"));
    createdStateDirs.add(stateDir);
    const sessions = [...(input?.sessions ?? [])];

    const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
    const providerService: ProviderServiceShape = {
      startSession: () => unsupported(),
      sendTurn: () => unsupported(),
      interruptTurn: () => unsupported(),
      respondToRequest: () => unsupported(),
      respondToUserInput: () => unsupported(),
      stopSession: () => unsupported(),
      listSessions: () => Effect.succeed(sessions),
      getCapabilities: () => unsupported(),
      rollbackConversation: () => unsupported(),
      streamEvents: unsupported(),
    };

    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(SqlitePersistenceMemory),
    );
    const layer = ColdStartLifecycleLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(Layer.succeed(ProviderService, providerService)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), stateDir)),
      Layer.provideMerge(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const coldStartLifecycle = await runtime.runPromise(Effect.service(ColdStartLifecycle));

    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-create"),
        projectId: asProjectId("project-1"),
        title: "Provider Project",
        workspaceRoot: "/tmp/provider-project",
        defaultModel: "gpt-5-codex",
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Thread",
        model: "gpt-5-codex",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );

    return {
      engine,
      coldStartLifecycle,
    };
  }

  it("expires stale pending user-input requests on cold boot", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const testRuntime = runtime;
    if (!testRuntime) {
      throw new Error("Expected runtime to be initialized");
    }

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe("cmd-user-input-requested"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        activity: {
          id: EventId.makeUnsafe("evt-user-input-requested"),
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            requestId: "user-input-request-1",
            questions: [
              {
                id: "sandbox_mode",
                header: "Sandbox",
                question: "Which mode should be used?",
                options: [
                  {
                    label: "workspace-write",
                    description: "Allow workspace writes only",
                  },
                ],
              },
            ],
          },
          turnId: asTurnId("turn-1"),
          createdAt: now,
        },
        createdAt: now,
      }),
    );

    await testRuntime.runPromise(harness.coldStartLifecycle.run);

    const readModel = await testRuntime.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    const expiredActivity = thread?.activities.find(
      (activity) => activity.kind === "user-input.expired",
    );

    expect(expiredActivity?.summary).toBe("Pending question expired after app restart");
    expect(expiredActivity?.turnId).toBe("turn-1");
    expect(expiredActivity?.payload).toMatchObject({
      requestId: "user-input-request-1",
      reason: "server-restart",
    });
    expect(derivePendingUserInputs(thread?.activities ?? [])).toEqual([]);
  });

  it("skips cold-start stale-input expiration when live provider sessions already exist", async () => {
    const harness = await createHarness({
      sessions: [
        {
          provider: "codex",
          status: "running",
          runtimeMode: "approval-required",
          threadId: ThreadId.makeUnsafe("thread-1"),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    });
    const now = new Date().toISOString();
    const testRuntime = runtime;
    if (!testRuntime) {
      throw new Error("Expected runtime to be initialized");
    }

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe("cmd-user-input-requested-live-session"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        activity: {
          id: EventId.makeUnsafe("evt-user-input-requested-live-session"),
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            requestId: "user-input-request-live-session",
            questions: [
              {
                id: "sandbox_mode",
                header: "Sandbox",
                question: "Which mode should be used?",
                options: [
                  {
                    label: "workspace-write",
                    description: "Allow workspace writes only",
                  },
                ],
              },
            ],
          },
          turnId: asTurnId("turn-live"),
          createdAt: now,
        },
        createdAt: now,
      }),
    );

    await testRuntime.runPromise(harness.coldStartLifecycle.run);

    const readModel = await testRuntime.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));

    expect(thread?.activities.some((activity) => activity.kind === "user-input.expired")).toBe(
      false,
    );
    expect(derivePendingUserInputs(thread?.activities ?? [])).toEqual([
      expect.objectContaining({
        requestId: "user-input-request-live-session",
      }),
    ]);
  });
});
