import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ClaudeSettings,
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as ClaudeAdapterV2 from "./Adapters/ClaudeAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const sessionId = "permission-denial-session";
const settings = Schema.decodeSync(ClaudeSettings)({});
const modelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet-4-6",
};
const workflowTaskId = "task-denied-workflow";
const workflowToolUseId = "toolu-denied-workflow";

function frame(value: unknown): SDKMessage {
  return { session_id: sessionId, ...(value as object) } as SDKMessage;
}

const workflowProgress = (uuid: string, state: "start" | "done") =>
  frame({
    type: "system",
    subtype: "task_progress",
    task_id: workflowTaskId,
    tool_use_id: workflowToolUseId,
    description: "Alpha: alpha:one",
    workflow_progress: [
      { type: "workflow_phase", index: 1, title: "Alpha" },
      {
        type: "workflow_agent",
        index: 1,
        label: "alpha:one",
        agentId: "a1",
        state,
        phaseIndex: 1,
        phaseTitle: "Alpha",
        promptPreview: "Reply with exactly: A1",
        ...(state === "done" ? { resultPreview: "A1" } : {}),
      },
    ],
    uuid,
  });

it.effect("keeps a workflow live and ingested after a CLI permission denial fails its run", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("claude-permission-denial");
      const sdkMessages = yield* Queue.unbounded<SDKMessage>();
      const stopped: Array<string> = [];
      const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
        instanceId: modelSelection.instanceId,
        settings,
        environment: {},
        attachmentsDir: cwd,
        fileSystem: yield* FileSystem.FileSystem,
        path: yield* Path.Path,
        crypto: yield* Crypto.Crypto,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        queryRunner: {
          allocateSessionId: Effect.succeed(sessionId),
          open: () =>
            Effect.succeed({
              messages: Stream.fromQueue(sdkMessages),
              offer: () => Effect.void,
              setModel: () => Effect.void,
              applyFlagSettings: () => Effect.void,
              setPermissionMode: () => Effect.void,
              backgroundTasks: () => Effect.succeed(false),
              stopTask: (taskId) => Effect.sync(() => void stopped.push(taskId)),
              interrupt: Effect.void,
              close: Effect.void,
            }),
          forkSession: () => Effect.die("unused"),
          subagentLaunchToolUseId: () => Effect.succeed(null),
          assertComplete: Effect.void,
        },
      });
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = ThreadId.make("thread:permission-denial");
        const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
        const workflowMember = (status: string) =>
          watch(
            (event) =>
              event.type === "subagent.updated" &&
              event.payload.nativeTaskRef?.nativeId?.endsWith(":agent:1") === true &&
              event.payload.status === status,
          );
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId: ProjectId.make("project:permission-denial"),
          title: "Permission denial",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        const running = yield* watch(
          (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
        );
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("first"),
          threadId,
          messageId: MessageId.make("first"),
          text: "Run the workflow, then the probe.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        yield* Fiber.join(running);

        const memberRunning = yield* workflowMember("running");
        yield* Queue.offerAll(sdkMessages, [
          frame({
            type: "assistant",
            uuid: "workflow-tool",
            parent_tool_use_id: null,
            message: {
              model: modelSelection.model,
              content: [
                {
                  type: "tool_use",
                  id: workflowToolUseId,
                  name: "Workflow",
                  input: { script: "alpha.js" },
                },
              ],
            },
          }),
          frame({
            type: "system",
            subtype: "task_started",
            task_id: workflowTaskId,
            tool_use_id: workflowToolUseId,
            description: "Run the alpha workflow",
            task_type: "local_workflow",
            workflow_name: "probe-wf",
            uuid: "workflow-started",
          }),
          frame({
            type: "user",
            uuid: "workflow-ack",
            parent_tool_use_id: null,
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: workflowToolUseId,
                  content: [{ type: "text", text: "Workflow launched." }],
                },
              ],
            },
            tool_use_result: { taskType: "local_workflow", runId: "wf_probe", transcriptDir: cwd },
          }),
          workflowProgress("workflow-start", "start"),
        ]);
        yield* Fiber.join(memberRunning);

        const parent = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
        const failed = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === parent.id &&
            event.payload.status === "failed",
        );
        yield* Queue.offer(
          sdkMessages,
          frame({
            type: "result",
            subtype: "success",
            uuid: "denied-result",
            is_error: false,
            num_turns: 1,
            result: "Launched; the probe was denied.",
            stop_reason: "end_turn",
            terminal_reason: "completed",
            permission_denials: [
              {
                tool_name: "Bash",
                tool_use_id: "tool-denied",
                tool_input: { command: "printf T3_DENIAL_PROBE" },
              },
            ],
            duration_ms: 1,
            duration_api_ms: 1,
            total_cost_usd: 0,
            usage: { input_tokens: 1, output_tokens: 1 },
            modelUsage: {},
          }),
        );
        yield* Fiber.join(failed);
        yield* worker.drain();

        const afterDenial = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(afterDenial.runs[0]?.status, "failed");
        assert.isNotEmpty(afterDenial.subagents);
        assert.deepEqual(
          afterDenial.subagents.map((subagent) => subagent.status),
          afterDenial.subagents.map(() => "running"),
          "the failed run must not fail the workflow the CLI is still running",
        );
        assert.deepEqual(stopped, []);

        const memberCompleted = yield* workflowMember("completed");
        yield* Queue.offerAll(sdkMessages, [
          workflowProgress("workflow-done", "done"),
          frame({
            type: "system",
            subtype: "task_notification",
            task_id: workflowTaskId,
            tool_use_id: workflowToolUseId,
            status: "completed",
            summary: "Workflow finished.",
            output_file: "/tmp/workflow.output",
            uuid: "workflow-notification",
          }),
        ]);
        // Domain events stream only after commit, so this proves the failed
        // run's ingestion stayed open for the workflow's later progress.
        yield* Fiber.join(memberCompleted);
        yield* worker.drain();

        const afterWorkflow = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(afterWorkflow.runs[0]?.status, "failed");
        assert.notInclude(
          afterWorkflow.subagents.map((subagent) => subagent.status),
          "failed",
        );
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: "claude-permission-denial" },
            ProviderAdapterRegistry.layerSingle(adapter),
            { runEffectWorker: false },
          ),
        ),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  ),
);
