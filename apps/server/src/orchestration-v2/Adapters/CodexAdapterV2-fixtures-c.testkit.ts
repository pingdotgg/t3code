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
  codexReplayPreamble,
  makeCodexReplayHarness,
  makeCodexReplayTranscript,
  makeCodexReplayTurn,
  makeCodexTestTurnInput,
  providerThreadId,
} from "./CodexAdapterV2-fixtures-base.testkit.ts";

export const RESUME_SCENARIO = "codex-resume-subagent";

export const RESUME_NATIVE_THREAD = "native-codex-resume-thread";

export const RESUME_NATIVE_TURN = "native-codex-resume-root-turn";

export const RESUME_CHILD_THREAD = "native-codex-resume-child-thread";

export const RESUME_CHILD_TURN_1 = "native-codex-resume-child-turn-1";

export const RESUME_CHILD_TURN_2 = "native-codex-resume-child-turn-2";

export const RESUME_PROMPT = "Spawn a sub-agent, nudge it, and reply NUDGED.";

export const childAgentMessage = (input: {
  readonly id: string;
  readonly text: string;
  readonly turnId: string;
  readonly completedAtMs: number;
  readonly afterMs?: number;
  readonly omitPhase?: boolean;
}): CodexReplay.CodexAppServerReplayEntry => ({
  type: "emit_inbound",
  label: `item/completed/${input.id}`,
  ...(input.afterMs === undefined ? {} : { afterMs: input.afterMs }),
  frame: {
    method: "item/completed",
    params: {
      item: {
        type: "agentMessage",
        id: input.id,
        text: input.text,
        ...(input.omitPhase ? {} : { phase: "final_answer" as const }),
        memoryCitation: null,
      },
      threadId: RESUME_CHILD_THREAD,
      turnId: input.turnId,
      completedAtMs: input.completedAtMs,
    },
  },
});

export const childTurnStarted = (
  turnId: string,
  afterMs?: number,
): CodexReplay.CodexAppServerReplayEntry => ({
  type: "emit_inbound",
  label: `turn/started/${turnId}`,
  ...(afterMs === undefined ? {} : { afterMs }),
  frame: {
    method: "turn/started",
    params: {
      threadId: RESUME_CHILD_THREAD,
      turn: {
        ...makeCodexReplayTurn({ id: turnId, status: "inProgress" }),
        startedAt: turnId === RESUME_CHILD_TURN_2 ? 1782622470 : 1782622440,
      },
    },
  },
});

export const childTurnCompleted = (
  turnId: string,
  afterMs?: number,
): CodexReplay.CodexAppServerReplayEntry => ({
  type: "emit_inbound",
  label: `turn/completed/${turnId}`,
  ...(afterMs === undefined ? {} : { afterMs }),
  frame: {
    method: "turn/completed",
    params: {
      threadId: RESUME_CHILD_THREAD,
      turn: makeCodexReplayTurn({ id: turnId, status: "completed" }),
    },
  },
});

export const resumeSubagentTranscript = makeCodexReplayTranscript({
  scenario: RESUME_SCENARIO,
  entries: [
    ...codexReplayPreamble({
      nativeThreadId: RESUME_NATIVE_THREAD,
      nativeTurnId: RESUME_NATIVE_TURN,
      prompt: RESUME_PROMPT,
    }),
    {
      type: "emit_inbound",
      label: "item/completed/subAgentActivity-started",
      frame: {
        method: "item/completed",
        params: {
          item: {
            type: "subAgentActivity",
            id: "call-codex-resume-spawn",
            kind: "started",
            agentThreadId: RESUME_CHILD_THREAD,
            agentPath: "/root/resume_agent",
          },
          threadId: RESUME_NATIVE_THREAD,
          turnId: RESUME_NATIVE_TURN,
          completedAtMs: 1782622441000,
        },
      },
    },
    childTurnStarted(RESUME_CHILD_TURN_1),
    childAgentMessage({
      id: "child-first-answer",
      text: "CODEX_FIRST_DONE",
      turnId: RESUME_CHILD_TURN_1,
      completedAtMs: 1782622442000,
    }),
    childAgentMessage({
      id: "child-first-answer-empty",
      text: "",
      turnId: RESUME_CHILD_TURN_1,
      completedAtMs: 1782622442001,
      omitPhase: true,
    }),
    childAgentMessage({
      id: "child-first-answer-duplicate",
      text: "CODEX_FIRST_DONE",
      turnId: RESUME_CHILD_TURN_1,
      completedAtMs: 1782622442002,
    }),
    childTurnCompleted(RESUME_CHILD_TURN_1, 100),
    {
      type: "emit_inbound",
      label: "item/completed/root-answer",
      frame: {
        method: "item/completed",
        params: {
          item: {
            type: "agentMessage",
            id: "root-answer-resume",
            text: "NUDGED",
            phase: "final_answer",
            memoryCitation: null,
          },
          threadId: RESUME_NATIVE_THREAD,
          turnId: RESUME_NATIVE_TURN,
          completedAtMs: 1782622443000,
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/completed/root",
      frame: {
        method: "turn/completed",
        params: {
          threadId: RESUME_NATIVE_THREAD,
          turn: makeCodexReplayTurn({ id: RESUME_NATIVE_TURN, status: "completed" }),
        },
      },
    },
    childTurnStarted(RESUME_CHILD_TURN_2, 30_000),
    childAgentMessage({
      id: "child-resume-answer",
      text: "CODEX_RESUME_DONE",
      turnId: RESUME_CHILD_TURN_2,
      completedAtMs: 1782622480000,
      afterMs: 30_000,
    }),
    childTurnCompleted(RESUME_CHILD_TURN_2),
  ],
});

export const lateChildPrefix = () => {
  const entries = resumeSubagentTranscript.entries;
  const labelIndex = (label: string) =>
    entries.findIndex((entry) => entry.type === "emit_inbound" && entry.label === label);
  const rootCompleted = labelIndex("turn/completed/root");
  return {
    spawned: entries.slice(0, labelIndex(`turn/started/${RESUME_CHILD_TURN_1}`) + 1),
    rootFinished: entries.slice(rootCompleted - 1, rootCompleted + 1),
  };
};

export const codexReplayThreadResult = (input: {
  readonly nativeThreadId: string;
  readonly forkedFromId: string | null;
}) => ({
  thread: {
    id: input.nativeThreadId,
    sessionId: input.nativeThreadId,
    forkedFromId: input.forkedFromId,
    preview: "",
    ephemeral: false,
    modelProvider: "openai",
    createdAt: 1782622440,
    updatedAt: 1782622440,
    status: { type: "idle" },
    path: `/tmp/${input.nativeThreadId}.jsonl`,
    cwd: "/workspace",
    cliVersion: "0.144.0",
    source: "vscode",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  },
  model: "gpt-5.4",
  modelProvider: "openai",
  serviceTier: null,
  cwd: "/workspace",
  instructionSources: [],
  approvalPolicy: "on-request",
  approvalsReviewer: "user",
  sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
  reasoningEffort: "medium",
});

export const errorCauseChainText = (error: unknown): string =>
  error instanceof Error ? `${error.message} ${errorCauseChainText(error.cause)}` : String(error);

export const codexReplaySourceTurn = (input: {
  readonly id: string;
  readonly ordinal: number;
  readonly nativeId: string | null;
  readonly providerThreadId: ProviderThreadId;
  readonly now: DateTime.Utc;
}): OrchestrationV2ProviderTurn => ({
  id: ProviderTurnId.make(input.id),
  providerThreadId: input.providerThreadId,
  nodeId: NodeId.make(`node-${input.id}`),
  runAttemptId: RunAttemptId.make(`run-attempt-${input.id}`),
  nativeTurnRef:
    input.nativeId === null
      ? { driver: CodexAdapterV2.CODEX_DRIVER_KIND, nativeId: null, strength: "none" }
      : {
          driver: CodexAdapterV2.CODEX_DRIVER_KIND,
          nativeId: input.nativeId,
          strength: "strong",
        },
  ordinal: input.ordinal,
  status: "completed",
  startedAt: input.now,
  completedAt: input.now,
});

export const nativeThreadId = "goal-thread";

export const objective = "Ship the feature";

export const codexGoal = (status: string, tokensUsed: number) => ({
  threadId: nativeThreadId,
  objective,
  status,
  tokenBudget: null,
  tokensUsed,
  timeUsedSeconds: 3,
  createdAt: 1782622440,
  updatedAt: 1782622450,
});

export const notification = (
  label: string,
  method: string,
  params: unknown,
): CodexReplay.CodexAppServerReplayEntry => ({
  type: "emit_inbound",
  label,
  frame: { method, params },
});

export const request = (id: number, method: string, params: unknown, result: unknown) =>
  [
    { type: "expect_outbound", label: method, frame: { id, method, params } },
    { type: "emit_inbound", label: method, frame: { id, result } },
  ] satisfies Array<CodexReplay.CodexAppServerReplayEntry>;

export const withReplayRequestId_2 = (
  entries: ReadonlyArray<CodexReplay.CodexAppServerReplayEntry>,
  id: number,
) =>
  entries.map((entry) =>
    "frame" in entry && Predicate.isObject(entry.frame) && "id" in entry.frame
      ? { ...entry, frame: { ...entry.frame, id } }
      : entry,
  );

export const sessionStart = codexReplayPreamble({
  nativeThreadId,
  nativeTurnId: "unused",
  prompt: "unused",
}).slice(0, 5);

export const goalTurnInput = (
  harness: {
    readonly threadId: ThreadId;
    readonly providerThread: OrchestrationV2ProviderThread;
  },
  text: string,
) =>
  DateTime.now.pipe(
    Effect.map((now) =>
      makeCodexTestTurnInput({
        threadId: harness.threadId,
        providerThread: harness.providerThread,
        now,
        attemptId: RunAttemptId.make("goal-attempt"),
        text,
      }),
    ),
  );

export const providerGoals = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
  events.flatMap((event) =>
    event.type === "provider_thread.updated" ? [event.providerThread.goal?.status ?? null] : [],
  );

export const nativeThreadId_2 = "file-approval-thread";

export const nativeTurnId = "file-approval-turn";

export const prompt = "Edit the files.";

export type FileUpdateChange = CodexSchema.V2ItemStartedNotification__FileUpdateChange;

export const addA: FileUpdateChange = { path: "/w/a.ts", kind: { type: "add" }, diff: "export {};" };

export const updateB: FileUpdateChange = {
  path: "/w/b.ts",
  kind: { type: "update", move_path: null },
  diff: "@@",
};

export const renameC: FileUpdateChange = {
  path: "/w/c.ts",
  kind: { type: "update", move_path: "/w/d.ts" },
  diff: "@@",
};

export const deleteE: FileUpdateChange = { path: "/w/e.ts", kind: { type: "delete" }, diff: "gone" };

export const fileChange = (
  phase: "started" | "completed",
  turnId: string,
  itemId: string,
  changes: ReadonlyArray<FileUpdateChange>,
): CodexReplay.CodexAppServerReplayEntry => ({
  type: "emit_inbound",
  label: `${phase} ${itemId}`,
  frame: {
    method: `item/${phase}`,
    params: {
      threadId: nativeThreadId_2,
      turnId,
      ...(phase === "started" ? { startedAtMs: 1 } : { completedAtMs: 3 }),
      item: {
        type: "fileChange",
        id: itemId,
        status: phase === "started" ? "inProgress" : "completed",
        changes,
      },
    },
  },
});

export const approval = (input: {
  readonly id: number;
  readonly turnId: string;
  readonly itemId: string;
}): Array<CodexReplay.CodexAppServerReplayEntry> => [
  {
    type: "emit_inbound",
    label: `approval ${input.itemId}`,
    frame: {
      id: input.id,
      method: "item/fileChange/requestApproval",
      params: {
        threadId: nativeThreadId_2,
        turnId: input.turnId,
        itemId: input.itemId,
        startedAtMs: 2,
        reason: null,
        grantRoot: null,
      },
    },
  },
  {
    type: "expect_outbound",
    label: `approval ${input.itemId}`,
    frame: { id: input.id, result: { decision: "accept" } },
  },
];

export const turnCompleted = (turnId: string): CodexReplay.CodexAppServerReplayEntry => ({
  type: "emit_inbound",
  label: `complete ${turnId}`,
  frame: {
    method: "turn/completed",
    params: {
      threadId: nativeThreadId_2,
      turn: makeCodexReplayTurn({ id: turnId, status: "completed" }),
    },
  },
});

export const startApprovalTurn = (
  scenario: string,
  entries: ReadonlyArray<CodexReplay.CodexAppServerReplayEntry>,
) =>
  Effect.gen(function* () {
    const pending = yield* Queue.unbounded<OrchestrationV2RuntimeRequest>();
    const harness = yield* makeCodexReplayHarness(
      makeCodexReplayTranscript({
        scenario,
        entries: [...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }), ...entries],
      }),
      (event) =>
        event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending"
          ? Queue.offer(pending, event.runtimeRequest)
          : Effect.void,
    );
    yield* harness.runtime.startTurn(
      makeCodexTestTurnInput({
        threadId: harness.threadId,
        providerThread: harness.providerThread,
        now: yield* DateTime.now,
        attemptId: RunAttemptId.make(`${scenario}-attempt`),
        text: prompt,
      }),
    );
    return {
      harness,
      answerNext: Queue.take(pending).pipe(
        Effect.tap((request) =>
          harness.runtime.respondToRuntimeRequest({
            requestId: request.id,
            decision: "accept",
          }),
        ),
      ),
    };
  });

export const approvalItem = (
  events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
  request: OrchestrationV2RuntimeRequest,
) =>
  events.flatMap((event) =>
    event.type === "turn_item.updated" &&
    event.turnItem.type === "approval_request" &&
    event.turnItem.requestId === request.id
      ? [event.turnItem]
      : [],
  )[0];
