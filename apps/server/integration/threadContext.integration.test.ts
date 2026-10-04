import * as NodeServices from "@effect/platform-node/NodeServices";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadContextId,
  ThreadId,
  type OrchestrationMessageContext,
} from "@t3tools/contracts";
import { Effect, Layer, Schema, Sink, Stream } from "effect";

import { makeOrchestrationIntegrationHarness } from "./OrchestrationEngineHarness.integration.ts";
import { ProjectionSnapshotQuery } from "../src/orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionThreadMessageRepositoryLive } from "../src/persistence/Layers/ProjectionThreadMessages.ts";
import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";
import { McpInvocationContext, type McpCapability } from "../src/mcp/McpInvocationContext.ts";
import { ThreadContextToolkitHandlersLive } from "../src/mcp/toolkits/threadContext/handlers.ts";
import {
  T3ThreadReadResult,
  ThreadContextToolkit,
} from "../src/mcp/toolkits/threadContext/tools.ts";

const environmentId = EnvironmentId.make("env-integration-harness");
const projectId = ProjectId.make("thread-context-project");
const sourceId = ThreadId.make("thread-context-source");
const destinationId = ThreadId.make("thread-context-destination");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const referenceText = "Compare [Login reference](t3-context://v1/thread/login_reference)";
const historyText = "The login retry budget is three attempts. This is reference material.";
const decodeHistory = Schema.decodeUnknownSync(T3ThreadReadResult);

// Failure modes: transport drops the records, the reactor sends raw links, eager history
// expansion, foreign-environment binding, and MCP paging reads a fixture instead of storage.
it.live(
  "dispatches reference-only context to the provider and reads persisted source history",
  () =>
    Effect.acquireUseRelease(
      makeOrchestrationIntegrationHarness(),
      (harness) =>
        Effect.gen(function* () {
          const destinationWorkspace = path.join(harness.rootDir, "destination-workspace");
          execFileSync(
            "git",
            ["worktree", "add", "-b", "context-destination", destinationWorkspace],
            {
              cwd: harness.workspaceDir,
              stdio: "pipe",
            },
          );
          yield* harness.engine.dispatch({
            type: "project.create",
            commandId: CommandId.make("context-project-create"),
            projectId,
            title: "Thread context integration",
            workspaceRoot: harness.rootDir,
            defaultModelSelection: modelSelection,
            createdAt: new Date().toISOString(),
          });
          for (const threadId of [sourceId, destinationId]) {
            yield* harness.engine.dispatch({
              type: "thread.create",
              commandId: CommandId.make(`context-create-${threadId}`),
              threadId,
              projectId,
              title: threadId === sourceId ? "Login reference" : "Compare login",
              modelSelection,
              runtimeMode: "approval-required",
              interactionMode: "default",
              branch: null,
              worktreePath: threadId === sourceId ? harness.workspaceDir : destinationWorkspace,
              createdAt: new Date().toISOString(),
            });
          }
          const adapter = harness.adapterHarness!;
          // Only the external provider is replaced. All dispatch, projection, prompt
          // composition, SQL history reads, and toolkit execution are production code.
          yield* adapter.queueTurnResponseForNextSession({ events: [] });
          yield* harness.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make("context-source-start"),
            threadId: sourceId,
            message: {
              messageId: MessageId.make("context-source-message"),
              role: "user",
              text: historyText,
              attachments: [],
            },
            runtimeMode: "approval-required",
            interactionMode: "default",
            createdAt: new Date().toISOString(),
          });
          yield* harness.waitForThread(
            sourceId,
            (thread) =>
              thread.session?.status === "ready" && thread.latestTurn?.state === "completed",
          );

          const context: OrchestrationMessageContext = {
            version: 1,
            records: [
              {
                version: 1,
                kind: "thread",
                contextId: ThreadContextId.make("login_reference"),
                label: "Login reference",
                environmentId,
                threadId: sourceId,
                title: "Login reference",
              },
            ],
          };
          yield* adapter.queueTurnResponseForNextSession({ events: [] });
          yield* harness.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make("context-destination-start"),
            threadId: destinationId,
            message: {
              messageId: MessageId.make("context-destination-message"),
              role: "user",
              text: referenceText,
              attachments: [],
              context,
            },
            runtimeMode: "approval-required",
            interactionMode: "default",
            createdAt: new Date().toISOString(),
          });
          const destination = yield* harness.waitForThread(
            destinationId,
            (thread) =>
              thread.session?.status === "ready" && thread.latestTurn?.state === "completed",
          );
          assert.deepEqual(destination.messages[0]?.context, context);
          assert.strictEqual(destination.messages[0]?.text, referenceText);
          const providerSnapshot = yield* adapter.adapter.readThread(destinationId);
          const providerInput = JSON.stringify(providerSnapshot.turns[0]?.items);
          assert.include(providerInput, "t3_thread_read");
          assert.include(providerInput, sourceId);
          assert.notInclude(providerInput, "t3-context://");
          assert.notInclude(providerInput, historyText);
          const sourceSnapshot = yield* adapter.adapter.readThread(sourceId);
          assert.strictEqual(sourceSnapshot.turns.length, 1);

          const historyOutcome = yield* Effect.gen(function* () {
            const toolkit = yield* ThreadContextToolkit;
            return yield* toolkit
              .handle("t3_thread_read", { threadId: sourceId, limit: 1 })
              .pipe(Stream.unwrap, Stream.run(Sink.last()), Effect.flatMap(Effect.fromOption));
          }).pipe(
            Effect.provide(ThreadContextToolkitHandlersLive),
            Effect.provideService(ProjectionSnapshotQuery, harness.snapshotQuery),
            Effect.provideService(McpInvocationContext, {
              environmentId,
              threadId: destinationId,
              providerSessionId: "integration-provider-session",
              providerInstanceId: modelSelection.instanceId,
              capabilities: new Set<McpCapability>(),
              issuedAt: Date.now(),
            }),
            Effect.provide(
              ProjectionThreadMessageRepositoryLive.pipe(
                Layer.provide(makeSqlitePersistenceLive(harness.dbPath)),
              ),
            ),
          );
          assert.isFalse(historyOutcome.isFailure);
          const history = decodeHistory(historyOutcome.result);
          assert.strictEqual(history.threadId, sourceId);
          assert.strictEqual(history.messages[0]?.text, historyText);
          assert.strictEqual(history.hasMore, false);
        }),
      (harness) => harness.dispose,
    ).pipe(Effect.provide(NodeServices.layer)),
);
