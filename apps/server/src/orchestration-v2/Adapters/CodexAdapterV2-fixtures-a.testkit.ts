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
  BG_NATIVE_THREAD,
  BG_NATIVE_TURN,
  BG_PROMPT,
  BG_SCENARIO,
  backgroundCommandItem,
  makeCodexReplayTranscript,
  makeCodexReplayTurn,
  codexReplayPreamble,
} from "./CodexAdapterV2-fixtures-base.testkit.ts";

export const backgroundExecTranscript = makeCodexReplayTranscript({
  scenario: BG_SCENARIO,
  entries: [
    ...codexReplayPreamble({
      nativeThreadId: BG_NATIVE_THREAD,
      nativeTurnId: BG_NATIVE_TURN,
      prompt: BG_PROMPT,
    }),
    {
      type: "emit_inbound",
      label: "item/started/command",
      frame: {
        method: "item/started",
        params: {
          item: backgroundCommandItem("inProgress"),
          threadId: BG_NATIVE_THREAD,
          turnId: BG_NATIVE_TURN,
          startedAtMs: 1782622440500,
        },
      },
    },
    {
      type: "emit_inbound",
      label: "item/completed/root-answer",
      frame: {
        method: "item/completed",
        params: {
          item: {
            type: "agentMessage",
            id: "root-answer-bg",
            text: "STARTED",
            phase: "final_answer",
            memoryCitation: null,
          },
          threadId: BG_NATIVE_THREAD,
          turnId: BG_NATIVE_TURN,
          completedAtMs: 1782622441000,
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/completed",
      frame: {
        method: "turn/completed",
        params: {
          threadId: BG_NATIVE_THREAD,
          turn: makeCodexReplayTurn({ id: BG_NATIVE_TURN, status: "completed" }),
        },
      },
    },
    {
      type: "emit_inbound",
      label: "item/completed/command-late",
      afterMs: 30_000,
      frame: {
        method: "item/completed",
        params: {
          item: backgroundCommandItem("completed"),
          threadId: BG_NATIVE_THREAD,
          turnId: BG_NATIVE_TURN,
          completedAtMs: 1782622465500,
        },
      },
    },
  ],
});

export const backgroundStopCases = [true, false, "still_running", "thread_unloaded"] as const;

export const makeBackgroundStopTranscript = (terminated: (typeof backgroundStopCases)[number]) => {
  const stillRunning = terminated === "still_running";
  return makeCodexReplayTranscript({
    scenario: `codex-bg-stop-${terminated}`,
    entries: [
      ...backgroundExecTranscript.entries.slice(0, -1),
      {
        type: "expect_outbound",
        label: "terminate-background-command",
        frame: {
          id: 4,
          method: "thread/backgroundTerminals/terminate",
          params: { threadId: BG_NATIVE_THREAD, processId: "4242" },
        },
      },
      {
        type: "emit_inbound",
        label: "terminate-background-command",
        frame:
          terminated === "thread_unloaded"
            ? {
                id: 4,
                error: { code: -32600, message: `thread not found: ${BG_NATIVE_THREAD}` },
              }
            : { id: 4, result: { terminated: terminated === true } },
      },
      ...(terminated === false || stillRunning
        ? [
            {
              type: "expect_outbound" as const,
              frame: {
                id: 5,
                method: "thread/backgroundTerminals/list",
                params: { threadId: BG_NATIVE_THREAD },
              },
            },
            {
              type: "emit_inbound" as const,
              frame: {
                id: 5,
                result: { data: stillRunning ? [{ processId: "4242" }] : [], nextCursor: null },
              },
            },
          ]
        : []),
      ...(stillRunning
        ? [
            {
              type: "expect_outbound" as const,
              frame: {
                id: 6,
                method: "thread/backgroundTerminals/terminate",
                params: { threadId: BG_NATIVE_THREAD, processId: "4242" },
              },
            },
            {
              type: "emit_inbound" as const,
              frame: { id: 6, result: { terminated: false } },
            },
            {
              type: "expect_outbound" as const,
              frame: {
                id: 7,
                method: "thread/backgroundTerminals/list",
                params: { threadId: BG_NATIVE_THREAD },
              },
            },
            {
              type: "emit_inbound" as const,
              frame: { id: 7, result: { data: [{ processId: "4242" }], nextCursor: null } },
            },
            {
              type: "expect_outbound" as const,
              frame: {
                id: 8,
                method: "thread/backgroundTerminals/terminate",
                params: { threadId: BG_NATIVE_THREAD, processId: "4242" },
              },
            },
            {
              type: "emit_inbound" as const,
              frame: { id: 8, result: { terminated: true } },
            },
          ]
        : []),
      backgroundExecTranscript.entries.at(-1)!,
    ],
  });
};

export const INTERRUPT_SCENARIO = "codex-interrupt-mid-command";

export const INTERRUPT_NATIVE_THREAD = "native-codex-interrupt-thread";

export const INTERRUPT_NATIVE_TURN = "native-codex-interrupt-turn";

export const INTERRUPT_COMMAND_ITEM = "exec-codex-interrupt-command";

export const INTERRUPT_COMMAND_ITEM_TWO = "exec-codex-interrupt-command-two";

export const INTERRUPT_CHILD_COMMAND_ITEM = "exec-codex-interrupt-child-command";

export const INTERRUPT_CHILD_NATIVE_THREAD = "native-codex-interrupt-child-thread";

export const INTERRUPT_CHILD_NATIVE_TURN = "native-codex-interrupt-child-turn";

export const INTERRUPT_LATE_CHILD_NATIVE_TURN = "native-codex-interrupt-late-child-turn";

export const INTERRUPT_COMMAND = "bash -c 'sleep 30; echo SHOULD_NOT_FINISH_CMD_INTERRUPT_FIXTURE'";

export const INTERRUPT_COMMAND_TWO = "bash -c 'sleep 20; echo SECOND_COMMAND'";

export const INTERRUPT_PROMPT = "Run a long foreground command and wait until interrupted.";

export const interruptCommandItem = (status: "inProgress" | "completed"): Record<string, unknown> => ({
  type: "commandExecution",
  id: INTERRUPT_COMMAND_ITEM,
  command: INTERRUPT_COMMAND,
  cwd: "/workspace",
  processId: "57680",
  source: "unifiedExecStartup",
  status,
  commandActions: [{ type: "unknown", command: INTERRUPT_COMMAND }],
  aggregatedOutput: status === "completed" ? "SHOULD_NOT_FINISH_CMD_INTERRUPT_FIXTURE\n" : null,
  exitCode: status === "completed" ? 0 : null,
  durationMs: status === "completed" ? 30_000 : null,
});

export const interruptMidCommandTranscript = makeCodexReplayTranscript({
  scenario: INTERRUPT_SCENARIO,
  entries: [
    ...codexReplayPreamble({
      nativeThreadId: INTERRUPT_NATIVE_THREAD,
      nativeTurnId: INTERRUPT_NATIVE_TURN,
      prompt: INTERRUPT_PROMPT,
    }),
    {
      type: "emit_inbound",
      label: "item/started/command",
      frame: {
        method: "item/started",
        params: {
          item: interruptCommandItem("inProgress"),
          threadId: INTERRUPT_NATIVE_THREAD,
          turnId: INTERRUPT_NATIVE_TURN,
          startedAtMs: 1782622440500,
        },
      },
    },
    {
      type: "expect_outbound",
      label: "turn/interrupt",
      frame: {
        id: 4,
        method: "turn/interrupt",
        params: {
          threadId: INTERRUPT_NATIVE_THREAD,
          turnId: INTERRUPT_NATIVE_TURN,
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/interrupt",
      frame: { id: 4, result: {} },
    },
    {
      type: "emit_inbound",
      label: "item/started/command-two-after-interrupt-response",
      frame: {
        method: "item/started",
        params: {
          item: {
            ...interruptCommandItem("inProgress"),
            id: INTERRUPT_COMMAND_ITEM_TWO,
            command: INTERRUPT_COMMAND_TWO,
            processId: "57681",
            commandActions: [{ type: "unknown", command: INTERRUPT_COMMAND_TWO }],
          },
          threadId: INTERRUPT_NATIVE_THREAD,
          turnId: INTERRUPT_NATIVE_TURN,
          startedAtMs: 1782622440600,
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/completed",
      frame: {
        method: "turn/completed",
        params: {
          threadId: INTERRUPT_NATIVE_THREAD,
          turn: makeCodexReplayTurn({
            id: INTERRUPT_NATIVE_TURN,
            status: "interrupted",
          }),
        },
      },
    },
    {
      type: "expect_outbound",
      label: "thread/backgroundTerminals/terminate/one",
      frame: {
        id: 5,
        method: "thread/backgroundTerminals/terminate",
        params: { threadId: INTERRUPT_NATIVE_THREAD, processId: "57680" },
      },
    },
    {
      type: "emit_inbound",
      label: "thread/backgroundTerminals/terminate/one",
      frame: { id: 5, result: { terminated: false } },
    },
    {
      type: "expect_outbound",
      label: "thread/backgroundTerminals/list/after-false",
      frame: {
        id: 6,
        method: "thread/backgroundTerminals/list",
        params: { threadId: INTERRUPT_NATIVE_THREAD },
      },
    },
    {
      type: "emit_inbound",
      label: "thread/backgroundTerminals/list/after-false",
      frame: { id: 6, result: { data: [], nextCursor: null } },
    },
    {
      type: "expect_outbound",
      label: "thread/backgroundTerminals/terminate/two",
      frame: {
        id: 7,
        method: "thread/backgroundTerminals/terminate",
        params: { threadId: INTERRUPT_NATIVE_THREAD, processId: "57681" },
      },
    },
    {
      type: "emit_inbound",
      label: "thread/backgroundTerminals/terminate/two",
      frame: { id: 7, result: { terminated: true } },
    },
    {
      type: "emit_inbound",
      label: "item/completed/command-late",
      afterMs: 30_000,
      frame: {
        method: "item/completed",
        params: {
          item: interruptCommandItem("completed"),
          threadId: INTERRUPT_NATIVE_THREAD,
          turnId: INTERRUPT_NATIVE_TURN,
          completedAtMs: 1782622465500,
        },
      },
    },
  ],
});

export const interruptSubagentCommandTranscript = makeCodexReplayTranscript({
  scenario: "codex-interrupt-subagent-command",
  entries: [
    ...codexReplayPreamble({
      nativeThreadId: INTERRUPT_NATIVE_THREAD,
      nativeTurnId: INTERRUPT_NATIVE_TURN,
      prompt: INTERRUPT_PROMPT,
    }),
    {
      type: "emit_inbound",
      label: "item/completed/subAgentActivity-started",
      frame: {
        method: "item/completed",
        params: {
          item: {
            type: "subAgentActivity",
            id: "call-codex-interrupt-subagent",
            kind: "started",
            agentThreadId: INTERRUPT_CHILD_NATIVE_THREAD,
            agentPath: "/root/stop_hold",
          },
          threadId: INTERRUPT_NATIVE_THREAD,
          turnId: INTERRUPT_NATIVE_TURN,
          completedAtMs: 1782622441000,
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/started/child",
      frame: {
        method: "turn/started",
        params: {
          threadId: INTERRUPT_CHILD_NATIVE_THREAD,
          turn: makeCodexReplayTurn({
            id: INTERRUPT_CHILD_NATIVE_TURN,
            status: "inProgress",
          }),
        },
      },
    },
    {
      type: "emit_inbound",
      label: "item/started/child-command",
      frame: {
        method: "item/started",
        params: {
          item: {
            ...interruptCommandItem("inProgress"),
            id: INTERRUPT_CHILD_COMMAND_ITEM,
            processId: "57682",
          },
          threadId: INTERRUPT_CHILD_NATIVE_THREAD,
          turnId: INTERRUPT_CHILD_NATIVE_TURN,
          startedAtMs: 1782622441500,
        },
      },
    },
    {
      type: "expect_outbound",
      label: "turn/interrupt/root",
      frame: {
        id: 4,
        method: "turn/interrupt",
        params: {
          threadId: INTERRUPT_NATIVE_THREAD,
          turnId: INTERRUPT_NATIVE_TURN,
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/interrupt/root",
      frame: { id: 4, result: {} },
    },
    {
      type: "expect_outbound",
      label: "turn/interrupt/child",
      frame: {
        id: 5,
        method: "turn/interrupt",
        params: {
          threadId: INTERRUPT_CHILD_NATIVE_THREAD,
          turnId: INTERRUPT_CHILD_NATIVE_TURN,
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/interrupt/child",
      frame: { id: 5, result: {} },
    },
    {
      type: "expect_outbound",
      label: "thread/backgroundTerminals/terminate/child",
      frame: {
        id: 6,
        method: "thread/backgroundTerminals/terminate",
        params: { threadId: INTERRUPT_CHILD_NATIVE_THREAD, processId: "57682" },
      },
    },
    {
      type: "emit_inbound",
      label: "thread/backgroundTerminals/terminate/child",
      frame: { id: 6, result: { terminated: true } },
    },
    {
      type: "emit_inbound",
      label: "turn/completed/root",
      frame: {
        method: "turn/completed",
        params: {
          threadId: INTERRUPT_NATIVE_THREAD,
          turn: makeCodexReplayTurn({ id: INTERRUPT_NATIVE_TURN, status: "interrupted" }),
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/completed/child-completed-race",
      frame: {
        method: "turn/completed",
        params: {
          threadId: INTERRUPT_CHILD_NATIVE_THREAD,
          turn: makeCodexReplayTurn({
            id: INTERRUPT_CHILD_NATIVE_TURN,
            status: "completed",
          }),
        },
      },
    },
    { type: "runtime_exit", status: "success" },
  ],
});
