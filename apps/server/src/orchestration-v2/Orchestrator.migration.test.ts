import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { shouldPrepareLegacyImportHandoff } from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

it("reissues imported context until a V2 run completes", () => {
  assert.isTrue(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: false,
      legacyImportItemCount: 2,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: false,
      legacyImportItemCount: 2,
      hasNativeHistory: true,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: true,
      legacyImportItemCount: 2,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: undefined,
      hasCompletedRun: false,
      legacyImportItemCount: 2,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: false,
      legacyImportItemCount: 0,
    }),
  );
});

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const adapter = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("The effect worker does not run in this test"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "orchestrator-migration" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

it.layer(layerTest)("agent session imports", (it) => {
  it.effect("the first message resumes the imported native session without a text handoff", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("import:codex:native-session");
      const providerThreadId = ProviderThreadId.make("provider-thread:imported-native-session");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-imported"),
        threadId,
        projectId: ProjectId.make("project:imported"),
        title: "Remember the code word PELICAN.",
        modelSelection: { instanceId, model: "gpt-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "system",
        creationSource: "server",
      });
      const now = yield* DateTime.now;
      const { thread } = yield* orchestrator.getThreadProjection(threadId);
      const importedItem = (index: number, role: "user" | "assistant", text: string) => ({
        id: EventId.make(`imported-item:${index}`),
        type: "turn-item.updated" as const,
        threadId,
        occurredAt: now,
        payload: {
          id: TurnItemId.make(`imported-item:${index}`),
          threadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: index + 1,
          status: "completed" as const,
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          ...(role === "user"
            ? {
                type: "user_message" as const,
                createdBy: "user" as const,
                creationSource: "web" as const,
                inputIntent: "turn_start" as const,
                messageId: MessageId.make(`imported-message:${index}`),
                text,
                attachments: [],
              }
            : {
                type: "assistant_message" as const,
                messageId: MessageId.make(`imported-message:${index}`),
                text,
                streaming: false,
              }),
        },
      });
      // The Welcome page's agent session import binds the thread to the strong native session it read.
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("imported-thread"),
            type: "thread.metadata-updated",
            threadId,
            occurredAt: now,
            payload: {
              ...thread,
              historyOrigin: "v1_import",
              activeProviderThreadId: providerThreadId,
            },
          },
          importedItem(0, "user", "Remember the code word PELICAN."),
          importedItem(1, "assistant", "OK"),
          {
            id: EventId.make("imported-provider-thread"),
            type: "provider-thread.updated",
            threadId,
            driver,
            providerInstanceId: instanceId,
            occurredAt: now,
            payload: {
              id: providerThreadId,
              driver,
              providerInstanceId: instanceId,
              providerSessionId: null,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: "native-session", strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              pendingBackgroundTasks: [],
              createdAt: now,
              updatedAt: now,
            },
          },
        ],
      });

      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("first-message"),
        threadId,
        messageId: MessageId.make("first-message"),
        text: "What was the code word?",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });

      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.deepStrictEqual(
        projection.providerThreads.map((providerThread) => providerThread.id),
        [providerThreadId],
      );
      assert.deepStrictEqual(
        projection.contextHandoffs.map((handoff) => handoff.strategy),
        [],
      );
    }),
  );
});
