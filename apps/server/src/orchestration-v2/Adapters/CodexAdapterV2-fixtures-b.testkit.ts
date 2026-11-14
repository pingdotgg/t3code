import { historyResponseItems } from "@t3tools/provider-core/server/handoffBudget";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import {
  makeProviderTextDeltaCoalescer,
  type ProviderTextDeltaUpdate,
} from "./ProviderTextDeltaCoalescer.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  CheckpointId,
  CodexSettings,
  EnvironmentId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  ProjectId,
  type ProviderApprovalDecision,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderSetupError,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as CodexError from "effect-codex-app-server/errors";
import type * as CodexSchema from "effect-codex-app-server/schema";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as FileSystem from "effect/FileSystem";
import { MCP_APP_OUTPUT_KEY, readMcpAppReference } from "@t3tools/shared/mcpApp";
import { toolOutputImages } from "@t3tools/shared/toolOutput";
import { resolveAttachmentPathById } from "../../attachmentStore.ts";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as PlatformError from "effect/PlatformError";
import { TestClock } from "effect/testing";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import packageJson from "../../../package.json" with { type: "json" };
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as EffectWorker from "../EffectWorker.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProviderReplayHarness from "../testkit/ProviderReplayHarness.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ModelManifest from "../../provider/ModelManifest.ts";
import * as PortScanner from "../../preview/PortScanner.ts";
import { resolveProviderCompatibility } from "../../provider/providerCompatibility.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import { withCodexReplayChildMetadata } from "./CodexAdapterV2.testkit.ts";
import * as CodexAdapterV2Testkit from "./CodexAdapterV2.testkit.ts";

import {
  makeCodexReplayTranscript,
  makeCodexReplayTurn,
  codexReplayPreamble,
} from "./CodexAdapterV2-fixtures-base.testkit.ts";
import {
  INTERRUPT_CHILD_NATIVE_THREAD,
  INTERRUPT_LATE_CHILD_NATIVE_TURN,
  INTERRUPT_NATIVE_THREAD,
  INTERRUPT_PROMPT,
  interruptSubagentCommandTranscript,
} from "./CodexAdapterV2-fixtures-a.testkit.ts";

export const assertChildProviderTerminalBeforeRoot = (
  events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
  rootThreadId: ThreadId,
) => {
  const terminalIndex = events.findIndex((event) => event.type === "turn.terminal");
  const childProviderTurnIndex = events.findIndex(
    (event) =>
      event.type === "provider_turn.updated" &&
      event.threadId !== rootThreadId &&
      event.providerTurn.status === "interrupted",
  );
  const childProviderThreadIndex = events.findIndex(
    (event) =>
      event.type === "provider_thread.updated" &&
      event.providerThread.appThreadId !== rootThreadId &&
      event.providerThread.status === "idle",
  );
  assert.isAtLeast(childProviderTurnIndex, 0, "child provider turn must terminalize");
  assert.isAtLeast(childProviderThreadIndex, 0, "child provider thread must become idle");
  assert.isAbove(
    terminalIndex,
    childProviderTurnIndex,
    "child provider turn must terminalize before the root run",
  );
  assert.isAbove(
    terminalIndex,
    childProviderThreadIndex,
    "child provider thread must become idle before the root run",
  );
};

export const rootCompletionIndex = interruptSubagentCommandTranscript.entries.findIndex(
  (entry) => entry.type === "emit_inbound" && entry.label === "turn/completed/root",
);

export const interruptLateSubagentTurnTranscript = makeCodexReplayTranscript({
  scenario: "codex-interrupt-late-subagent-turn",
  entries: [
    ...interruptSubagentCommandTranscript.entries.slice(0, rootCompletionIndex),
    {
      type: "emit_inbound",
      label: "turn/started/late-child",
      frame: {
        method: "turn/started",
        params: {
          threadId: INTERRUPT_CHILD_NATIVE_THREAD,
          turn: makeCodexReplayTurn({
            id: INTERRUPT_LATE_CHILD_NATIVE_TURN,
            status: "inProgress",
          }),
        },
      },
    },
    ...interruptSubagentCommandTranscript.entries.slice(rootCompletionIndex, -1),
    {
      type: "expect_outbound",
      label: "turn/interrupt/late-child",
      frame: {
        id: 7,
        method: "turn/interrupt",
        params: {
          threadId: INTERRUPT_CHILD_NATIVE_THREAD,
          turnId: INTERRUPT_LATE_CHILD_NATIVE_TURN,
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/interrupt/late-child",
      frame: { id: 7, result: {} },
    },
    { type: "runtime_exit", status: "success" },
  ],
});

export const interruptSubagentTurnAfterStopTranscript = makeCodexReplayTranscript({
  scenario: "codex-interrupt-subagent-turn-after-stop",
  entries: [
    ...interruptSubagentCommandTranscript.entries.slice(0, -1),
    {
      type: "emit_inbound",
      label: "turn/started/child-after-stop",
      frame: {
        method: "turn/started",
        params: {
          threadId: INTERRUPT_CHILD_NATIVE_THREAD,
          turn: makeCodexReplayTurn({
            id: INTERRUPT_LATE_CHILD_NATIVE_TURN,
            status: "inProgress",
          }),
        },
      },
    },
    {
      type: "expect_outbound",
      label: "turn/interrupt/child-after-stop",
      frame: {
        id: 7,
        method: "turn/interrupt",
        params: {
          threadId: INTERRUPT_CHILD_NATIVE_THREAD,
          turnId: INTERRUPT_LATE_CHILD_NATIVE_TURN,
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/interrupt/child-after-stop",
      frame: { id: 7, result: {} },
    },
    {
      type: "emit_inbound",
      label: "thread/goal/updated/root",
      frame: {
        method: "thread/goal/updated",
        params: {
          threadId: INTERRUPT_NATIVE_THREAD,
          turnId: null,
          goal: {
            threadId: INTERRUPT_NATIVE_THREAD,
            objective: INTERRUPT_PROMPT,
            status: "paused",
            tokenBudget: null,
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: 1782622440,
            updatedAt: 1782622450,
          },
        },
      },
    },
    { type: "runtime_exit", status: "success" },
  ],
});

export const FAILED_SCENARIO = "codex-failed-mid-command";

export const FAILED_NATIVE_THREAD = "native-codex-failed-thread";

export const FAILED_NATIVE_TURN = "native-codex-failed-turn";

export const FAILED_COMMAND_ITEM = "exec-codex-failed-command";

export const FAILED_COMMAND = "sleep 30";

export const FAILED_PROMPT = "Run a command that will be abandoned when the turn fails.";

export const failedMidCommandTranscript = makeCodexReplayTranscript({
  scenario: FAILED_SCENARIO,
  entries: [
    ...codexReplayPreamble({
      nativeThreadId: FAILED_NATIVE_THREAD,
      nativeTurnId: FAILED_NATIVE_TURN,
      prompt: FAILED_PROMPT,
    }),
    {
      type: "emit_inbound",
      label: "item/started/command",
      frame: {
        method: "item/started",
        params: {
          item: {
            type: "commandExecution",
            id: FAILED_COMMAND_ITEM,
            command: FAILED_COMMAND,
            cwd: "/workspace",
            processId: "99",
            source: "unifiedExecStartup",
            status: "inProgress",
            commandActions: [{ type: "unknown", command: FAILED_COMMAND }],
            aggregatedOutput: null,
            exitCode: null,
            durationMs: null,
          },
          threadId: FAILED_NATIVE_THREAD,
          turnId: FAILED_NATIVE_TURN,
          startedAtMs: 1782622440500,
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/completed",
      frame: {
        method: "turn/completed",
        params: {
          threadId: FAILED_NATIVE_THREAD,
          turn: {
            ...makeCodexReplayTurn({
              id: FAILED_NATIVE_TURN,
              status: "failed",
            }),
            error: { message: "provider failed mid-command" },
          },
        },
      },
    },
  ],
});

export const MCP_APP_SCENARIO = "codex-mcp-app-capture";

export const MCP_APP_NATIVE_THREAD = "native-codex-mcp-app-thread";

export const MCP_APP_NATIVE_TURN = "native-codex-mcp-app-turn";

export const MCP_APP_ITEM = "mcp-weather-call";

export const MCP_APP_PROMPT = "Show the weather in Oslo.";

export const MCP_APP_RESOURCE = "ui://weather/dashboard";

export const MCP_APP_HTML = "<!doctype html><html><body><p>Weather</p><script>1</script></body></html>";

export const mcpAppToolItem = (status: "inProgress" | "completed") => ({
  type: "mcpToolCall",
  id: MCP_APP_ITEM,
  server: "weather",
  tool: "get_weather",
  status,
  arguments: { city: "Oslo" },
  mcpAppResourceUri: MCP_APP_RESOURCE,
  ...(status === "completed"
    ? { result: { content: [{ type: "text", text: "Sunny" }], structuredContent: { temp: 21 } } }
    : {}),
});

export const mcpAppTranscript = makeCodexReplayTranscript({
  scenario: MCP_APP_SCENARIO,
  entries: [
    ...codexReplayPreamble({
      nativeThreadId: MCP_APP_NATIVE_THREAD,
      nativeTurnId: MCP_APP_NATIVE_TURN,
      prompt: MCP_APP_PROMPT,
    }),
    {
      type: "emit_inbound",
      label: "item/started/app-tool",
      frame: {
        method: "item/started",
        params: {
          item: mcpAppToolItem("inProgress"),
          threadId: MCP_APP_NATIVE_THREAD,
          turnId: MCP_APP_NATIVE_TURN,
          startedAtMs: 1782622440500,
        },
      },
    },
    {
      type: "emit_inbound",
      label: "item/completed/app-tool",
      frame: {
        method: "item/completed",
        params: {
          item: mcpAppToolItem("completed"),
          threadId: MCP_APP_NATIVE_THREAD,
          turnId: MCP_APP_NATIVE_TURN,
          completedAtMs: 1782622441500,
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/completed",
      frame: {
        method: "turn/completed",
        params: {
          threadId: MCP_APP_NATIVE_THREAD,
          turn: makeCodexReplayTurn({ id: MCP_APP_NATIVE_TURN, status: "completed" }),
        },
      },
    },
    {
      type: "expect_outbound",
      label: "mcpServer/resource/read",
      frame: {
        id: 4,
        method: "mcpServer/resource/read",
        params: { threadId: MCP_APP_NATIVE_THREAD, server: "weather", uri: MCP_APP_RESOURCE },
      },
    },
    {
      type: "emit_inbound",
      label: "mcpServer/resource/read",
      frame: {
        id: 4,
        result: {
          contents: [
            {
              uri: MCP_APP_RESOURCE,
              mimeType: "text/html;profile=mcp-app",
              text: MCP_APP_HTML,
              _meta: { ui: { csp: { connectDomains: ["https://api.weather.test"] } } },
            },
          ],
        },
      },
    },
  ],
});

export const MCP_APP_DEFERRED_RESULT = {
  content: [{ type: "text", text: "An interactive form is being shown to the user." }],
  structuredContent: { status: "awaiting_user_submission" },
};

export const mcpAppDeferredTranscript = makeCodexReplayTranscript({
  scenario: MCP_APP_SCENARIO,
  entries: mcpAppTranscript.entries.map((entry) =>
    entry.type === "emit_inbound" && entry.label === "item/completed/app-tool"
      ? {
          ...entry,
          frame: {
            method: "item/completed",
            params: {
              item: {
                ...mcpAppToolItem("inProgress"),
                status: "failed",
                result: MCP_APP_DEFERRED_RESULT,
              },
              threadId: MCP_APP_NATIVE_THREAD,
              turnId: MCP_APP_NATIVE_TURN,
              completedAtMs: 1782622441500,
            },
          },
        }
      : entry,
  ),
});

export const ORPHAN_WAIT_SCENARIO = "codex-orphaned-dynamic-tool";

export const ORPHAN_WAIT_NATIVE_THREAD = "native-codex-orphan-wait-thread";

export const ORPHAN_WAIT_NATIVE_TURN = "native-codex-orphan-wait-turn";

export const ORPHAN_WAIT_ITEM = "exec-4669f3bb-78c9-4af1-b44e-daa340d2c538";

export const PERSISTENT_MONITOR_ITEM = "exec-persistent-monitor";

export const COMPLETED_WAIT_ITEM = "exec-completed-wait";

export const ORPHAN_WAIT_PROMPT = "Wait on two nested tasks, then finish.";

export const orphanedDynamicToolTranscript = makeCodexReplayTranscript({
  scenario: ORPHAN_WAIT_SCENARIO,
  entries: [
    ...codexReplayPreamble({
      nativeThreadId: ORPHAN_WAIT_NATIVE_THREAD,
      nativeTurnId: ORPHAN_WAIT_NATIVE_TURN,
      prompt: ORPHAN_WAIT_PROMPT,
    }),
    {
      type: "emit_inbound",
      label: "item/started/completed-wait",
      frame: {
        method: "item/started",
        params: {
          item: {
            type: "mcpToolCall",
            id: COMPLETED_WAIT_ITEM,
            server: "t3-code",
            tool: "t3_thread_wait",
            status: "inProgress",
            arguments: { threadId: "thread:completed-wait", timeoutMs: 30000 },
          },
          threadId: ORPHAN_WAIT_NATIVE_THREAD,
          turnId: ORPHAN_WAIT_NATIVE_TURN,
          startedAtMs: 1782622440500,
        },
      },
    },
    {
      type: "emit_inbound",
      label: "item/completed/completed-wait",
      frame: {
        method: "item/completed",
        params: {
          item: {
            type: "mcpToolCall",
            id: COMPLETED_WAIT_ITEM,
            server: "t3-code",
            tool: "t3_thread_wait",
            status: "completed",
            arguments: { threadId: "thread:completed-wait", timeoutMs: 30000 },
            result: { content: [{ type: "text", text: "idle" }] },
          },
          threadId: ORPHAN_WAIT_NATIVE_THREAD,
          turnId: ORPHAN_WAIT_NATIVE_TURN,
          completedAtMs: 1782622441500,
        },
      },
    },
    {
      type: "emit_inbound",
      label: "item/started/orphan-wait",
      frame: {
        method: "item/started",
        params: {
          item: {
            type: "mcpToolCall",
            id: ORPHAN_WAIT_ITEM,
            server: "t3-code",
            tool: "t3_thread_wait",
            status: "inProgress",
            arguments: {
              threadId:
                "thread:delegated-task:command%3Amcp%3Aaafffab1-e811-458a-ae83-558e542c61ff%3Adelegate-task%3Areview-mobile-reconnect-opus-20260815",
              timeoutMs: 30000,
            },
          },
          threadId: ORPHAN_WAIT_NATIVE_THREAD,
          turnId: ORPHAN_WAIT_NATIVE_TURN,
          startedAtMs: 1782622442500,
        },
      },
    },
    {
      type: "emit_inbound",
      label: "item/started/persistent-monitor",
      frame: {
        method: "item/started",
        params: {
          item: {
            type: "dynamicToolCall",
            id: PERSISTENT_MONITOR_ITEM,
            namespace: "grok",
            tool: "monitor",
            status: "inProgress",
            arguments: { persistent: true, command: "tail -f" },
          },
          threadId: ORPHAN_WAIT_NATIVE_THREAD,
          turnId: ORPHAN_WAIT_NATIVE_TURN,
          startedAtMs: 1782622443500,
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/completed",
      frame: {
        method: "turn/completed",
        params: {
          threadId: ORPHAN_WAIT_NATIVE_THREAD,
          turn: makeCodexReplayTurn({
            id: ORPHAN_WAIT_NATIVE_TURN,
            status: "completed",
          }),
        },
      },
    },
    {
      type: "emit_inbound",
      label: "item/completed/persistent-monitor",
      afterMs: 30_000,
      frame: {
        method: "item/completed",
        params: {
          item: {
            type: "dynamicToolCall",
            id: PERSISTENT_MONITOR_ITEM,
            namespace: "grok",
            tool: "monitor",
            status: "completed",
            arguments: { persistent: true, command: "tail -f" },
            result: { content: [{ type: "text", text: "stopped" }] },
          },
          threadId: ORPHAN_WAIT_NATIVE_THREAD,
          turnId: ORPHAN_WAIT_NATIVE_TURN,
          completedAtMs: 1782622473500,
        },
      },
    },
  ],
});
