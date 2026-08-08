/**
 * Golden fixtures for the Aether event pipeline tests — REAL wire shapes for
 * both transports, derived from the aether repo's schemas and normalizer
 * builders (read-only reference, pinned in the plumbing spec):
 *
 *   - WS frames: packages/workspace-protocol/src/messages.ts (agent task
 *     event union; strict server-side, so anything here MUST also satisfy
 *     the strict schemas — extra keys are only used where the wire is an
 *     open record like tool `input`)
 *   - codex file_change input: apps/workspace-service/src/agents/codex/
 *     event-normalizer.ts buildFileChangeInput — `{files:[{path, op,
 *     oldContent?, newContent?, diff?}], paths, path?, op?}`
 *   - claude Edit: raw tool passthrough `{file_path, old_string, new_string}`
 *   - command execution: codex `{command, cwd}` input + `terminal` display
 *     block `{command, stdout?, exitCode?}`
 *   - awaiting_input: live `{pendingInputId, payload:{toolName, input}}` vs
 *     the REST projection `{kind, tool_id, input}` (tasks_read.go:685-726) —
 *     DIFFERENT shapes, same pending input (`pendingInputId` ≡ `tool_id`)
 *   - durable rows: tasks_read.go TaskTimelineMessage
 *
 * Used as test INPUT only.
 *
 * @module provider/Layers/aether/eventMapper.fixtures
 */
import type { AetherConversationDelta, AetherTask, AetherTimelineMessage } from "./restSchemas.ts";

export const FIXTURE_TASK_ID = "task-1";

const frameBase = {
  channel: "agent",
  type: "task_event",
  taskId: FIXTURE_TASK_ID,
} as const;

// ---------------------------------------------------------------------------
// WS frames (live transport)
// ---------------------------------------------------------------------------

export const wsAssistantDelta = {
  ...frameBase,
  kind: "assistant_message.delta",
  messageId: "m1",
  turnId: "u1",
  createdAt: "2026-08-08T10:00:01.000Z",
  payload: { delta: "Looking at the" },
} as const;

export const wsAssistantDelta2 = {
  ...frameBase,
  kind: "assistant_message.delta",
  messageId: "m1",
  turnId: "u1",
  createdAt: "2026-08-08T10:00:01.100Z",
  payload: { delta: " failing test." },
} as const;

// Thinking ids arrive `thinking:`-prefixed on the live stream
// (task-stream-emitter.ts durableThinkingMessageId).
export const wsThinkingDelta = {
  ...frameBase,
  kind: "thinking.delta",
  messageId: "thinking:m2",
  turnId: "u1",
  createdAt: "2026-08-08T10:00:00.500Z",
  payload: { delta: "The test asserts…" },
} as const;

export const wsStreamComplete = {
  ...frameBase,
  kind: "stream.complete",
  messageId: "m1",
  createdAt: "2026-08-08T10:00:02.000Z",
} as const;

export const wsAssistantCompleted = {
  ...frameBase,
  kind: "assistant_message.completed",
  messageId: "m1",
  turnId: "u1",
  createdAt: "2026-08-08T10:00:02.000Z",
  payload: { content: "Looking at the failing test." },
} as const;

export const wsThinkingCompleted = {
  ...frameBase,
  kind: "thinking.completed",
  messageId: "thinking:m2",
  turnId: "u1",
  createdAt: "2026-08-08T10:00:01.500Z",
  payload: { content: "The test asserts…" },
} as const;

/** Codex file_change: normalizer-built files[] input + result-borne diff. */
export const wsCodexFileChange = {
  ...frameBase,
  kind: "tool_call.completed",
  toolCallId: "call-fc-codex",
  turnId: "u1",
  createdAt: "2026-08-08T10:00:03.000Z",
  payload: {
    name: "apply_patch",
    input: {
      files: [
        {
          path: "src/app.ts",
          op: "modify",
          oldContent: "const a = 1;\n",
          newContent: "const a = 2;\n",
        },
        {
          path: "src/new.ts",
          op: "create",
          diff: "diff --git a/src/new.ts b/src/new.ts\n@@ -0,0 +1 @@\n+export {};\n",
        },
      ],
      paths: ["src/app.ts", "src/new.ts"],
    },
    display: { label: "Edit src/app.ts, src/new.ts" },
    status: "output-available",
    itemType: "file_change",
  },
} as const;

/** Claude Edit: raw provider input passthrough. */
export const wsClaudeEdit = {
  ...frameBase,
  kind: "tool_call.completed",
  toolCallId: "call-fc-claude",
  turnId: "u1",
  createdAt: "2026-08-08T10:00:04.000Z",
  payload: {
    name: "Edit",
    input: {
      file_path: "src/util.ts",
      old_string: "return a;",
      new_string: "return a + 1;",
    },
    display: { label: "Edit src/util.ts" },
    status: "output-available",
    itemType: "file_change",
  },
} as const;

/** Command start: input-available, no terminal output yet. */
export const wsCommandStarted = {
  ...frameBase,
  kind: "tool_call.started",
  toolCallId: "call-bash",
  turnId: "u1",
  createdAt: "2026-08-08T10:00:05.000Z",
  payload: {
    name: "Bash",
    input: { command: "pnpm test", cwd: "/home/coder/project" },
    display: { label: "pnpm test" },
    status: "input-available",
    itemType: "command_execution",
  },
} as const;

/** Command failure: terminal block carries stdout + nonzero exitCode. */
export const wsCommandFailed = {
  ...frameBase,
  kind: "tool_call.failed",
  toolCallId: "call-bash",
  turnId: "u1",
  createdAt: "2026-08-08T10:00:06.000Z",
  payload: {
    name: "Bash",
    input: { command: "pnpm test", cwd: "/home/coder/project" },
    display: {
      label: "pnpm test",
      blocks: [
        {
          type: "terminal",
          command: "pnpm test",
          stdout: "1 test failed",
          exitCode: 1,
        },
      ],
    },
    status: "output-error",
    itemType: "command_execution",
    error: "Command exited with code 1",
  },
} as const;

/** Denied tool: output-denied → declined + tool.denied. */
export const wsToolDenied = {
  ...frameBase,
  kind: "tool_call.completed",
  toolCallId: "call-denied",
  turnId: "u1",
  createdAt: "2026-08-08T10:00:07.000Z",
  payload: {
    name: "Bash",
    input: { command: "rm -rf /" },
    display: { label: "rm -rf /" },
    status: "output-denied",
    itemType: "command_execution",
    error: "denied by policy",
  },
} as const;

/** MCP tool card: mcp__<server>__<tool> naming (event-normalizer.ts:863-903). */
export const wsMcpToolCall = {
  ...frameBase,
  kind: "tool_call.completed",
  toolCallId: "call-mcp",
  turnId: "u1",
  createdAt: "2026-08-08T10:00:08.000Z",
  payload: {
    name: "mcp__linear__create_issue",
    input: { title: "Fix flake" },
    display: { label: "linear: create_issue" },
    status: "output-available",
    itemType: "mcp_tool_call",
    result: '{"id":"LIN-1"}',
  },
} as const;

/** Tool card carrying a todo_list display block (inline turn-plan chip). */
export const wsTodoTool = {
  ...frameBase,
  kind: "tool_call.completed",
  toolCallId: "call-todo",
  turnId: "u1",
  createdAt: "2026-08-08T10:00:09.000Z",
  payload: {
    name: "TodoWrite",
    input: {},
    display: {
      label: "Update plan",
      blocks: [
        {
          type: "todo_list",
          items: [
            { text: "Reproduce the failure", status: "completed" },
            { text: "Fix the reducer", status: "in_progress" },
            { text: "Add a regression test", status: "pending" },
          ],
        },
      ],
    },
    status: "output-available",
    itemType: "task_tracking",
  },
} as const;

export const wsTurnCompleted = {
  ...frameBase,
  kind: "turn.completed",
  turnId: "u1",
  createdAt: "2026-08-08T10:00:10.000Z",
  payload: { status: "completed" },
} as const;

export const wsTurnFailed = {
  ...frameBase,
  kind: "turn.failed",
  turnId: "u1",
  createdAt: "2026-08-08T10:00:10.000Z",
  payload: { errorMessage: "agent crashed" },
} as const;

/**
 * LIVE awaiting_input, questions: `{turnId, pendingInputId, toolCallId,
 * payload:{toolName, input}}` — NO `kind`, NO `tool_id` on this path.
 */
export const wsAwaitingInputQuestions = {
  ...frameBase,
  kind: "turn.awaiting_input",
  turnId: "u1",
  pendingInputId: "pi-1",
  toolCallId: "call-ask",
  createdAt: "2026-08-08T10:00:11.000Z",
  payload: {
    toolName: "ask_user",
    input: {
      questions: [
        {
          id: "q1",
          header: "Approach",
          question: "Which approach should I take?",
          options: [
            { label: "Patch the reducer", description: "Smallest change" },
            // description absent on the wire — the mapper synthesizes it.
            { label: "Rewrite the module" },
          ],
          multiSelect: false,
        },
      ],
    },
  },
} as const;

export const wsAwaitingInputPlan = {
  ...frameBase,
  kind: "turn.awaiting_input",
  turnId: "u1",
  pendingInputId: "pi-2",
  toolCallId: "call-plan",
  createdAt: "2026-08-08T10:00:12.000Z",
  payload: {
    toolName: "propose_plan",
    input: {
      summary: "Fix the reducer bug",
      plan: "1. Reproduce\n2. Fix\n3. Test",
    },
  },
} as const;

export const wsAwaitingInputStopTask = {
  ...frameBase,
  kind: "turn.awaiting_input",
  turnId: "u1",
  pendingInputId: "pi-3",
  toolCallId: "call-stop",
  createdAt: "2026-08-08T10:00:13.000Z",
  payload: { toolName: "stop_task", input: {} },
} as const;

export const wsConversationTruncated = {
  ...frameBase,
  kind: "conversation.truncated",
  messageId: "m1",
  createdAt: "2026-08-08T10:00:14.000Z",
  payload: { anchorMessageId: "m1" },
} as const;

export const wsSlashCommandsUpdated = {
  ...frameBase,
  kind: "slash_commands.updated",
  createdAt: "2026-08-08T10:00:15.000Z",
  payload: { slashCommands: [{ name: "review", description: "Review the diff" }] },
} as const;

/** A kind newer servers may emit — must be dropped after one log, never crash. */
export const wsUnknownKindFrame = {
  ...frameBase,
  kind: "usage.updated",
  createdAt: "2026-08-08T10:00:16.000Z",
  payload: { inputTokens: 1200 },
} as const;

/** The golden live-turn sequence, in wire order. */
export const wsGoldenTurn = [
  wsThinkingDelta,
  wsThinkingCompleted,
  wsAssistantDelta,
  wsAssistantDelta2,
  wsStreamComplete,
  wsAssistantCompleted,
  wsCodexFileChange,
  wsClaudeEdit,
  wsCommandStarted,
  wsCommandFailed,
  wsToolDenied,
  wsMcpToolCall,
  wsTodoTool,
  wsTurnCompleted,
] as const;

// ---------------------------------------------------------------------------
// REST (durable transport)
// ---------------------------------------------------------------------------

const taskBase = {
  id: FIXTURE_TASK_ID,
  project_id: "project-1",
  name: "Fix the flaky test",
  agent_type: "codex",
  model: "gpt-5.6-sol",
  interaction_mode: "default",
  auto_fix_ci: false,
  auto_fix_pr_comments: false,
  auto_rebase: false,
} as const;

export const taskProcessing: AetherTask = {
  ...taskBase,
  latest_sequence: 3,
  status: "processing",
  run_context: { workspace_id: "ws-1", started_at: "2026-08-08T10:00:00Z" },
};

/** The idle state between EVERY pair of turns — READY, no state emission. */
export const taskAwaitingMessage: AetherTask = {
  ...taskBase,
  latest_sequence: 9,
  status: "awaiting_input",
  run_context: { workspace_id: "ws-1", started_at: "2026-08-08T10:00:00Z" },
  awaiting_input: { kind: "message" },
};

/** REST projection of the SAME pending input as wsAwaitingInputQuestions. */
export const taskAwaitingQuestions: AetherTask = {
  ...taskBase,
  latest_sequence: 9,
  status: "awaiting_input",
  run_context: { workspace_id: "ws-1", started_at: "2026-08-08T10:00:00Z" },
  awaiting_input: {
    kind: "questions",
    tool_id: "pi-1",
    input: wsAwaitingInputQuestions.payload.input,
  },
};

export const taskAwaitingPlan: AetherTask = {
  ...taskBase,
  latest_sequence: 9,
  status: "awaiting_input",
  run_context: { workspace_id: "ws-1", started_at: "2026-08-08T10:00:00Z" },
  awaiting_input: {
    kind: "plan",
    tool_id: "pi-2",
    input: wsAwaitingInputPlan.payload.input,
  },
};

export const taskErrored: AetherTask = {
  ...taskBase,
  latest_sequence: 9,
  status: "errored",
  run_context: null,
  error: "VM provisioning failed",
  completed_at: "2026-08-08T10:05:00Z",
};

/**
 * Durable timeline rows — the REST twins of the golden live turn. The
 * assistant text row uses the durable `assistant:`-prefixed id form the spec
 * calls out for dedupe; the thinking row is `thinking:`-prefixed on BOTH
 * transports.
 */
export const deltaRows: ReadonlyArray<AetherTimelineMessage> = [
  {
    id: "u1",
    role: "user",
    content: "fix the flaky test",
    deliveryStatus: "delivered",
    timestamp: "2026-08-08T10:00:00.000Z",
    sequence: 1,
  },
  {
    id: "thinking:m2",
    role: "assistant",
    variant: "thinking",
    content: "The test asserts…",
    isStreaming: false,
    timestamp: "2026-08-08T10:00:01.500Z",
    sequence: 2,
  },
  {
    id: "assistant:m1",
    role: "assistant",
    variant: "text",
    content: "Looking at the failing test.",
    timestamp: "2026-08-08T10:00:02.000Z",
    sequence: 3,
  },
  {
    id: "row-fc",
    role: "assistant",
    variant: "tool",
    tool: {
      id: "call-fc-codex",
      name: "apply_patch",
      input: wsCodexFileChange.payload.input,
      status: "output-available",
      itemType: "file_change",
      display: { label: "Edit src/app.ts, src/new.ts" },
    },
    timestamp: "2026-08-08T10:00:03.000Z",
    sequence: 4,
  },
  {
    id: "seam-1",
    role: "assistant",
    variant: "seam",
    seam: { reason: "compaction" },
    timestamp: "2026-08-08T10:00:04.000Z",
    sequence: 5,
  },
];

export function makeDelta(overrides?: {
  readonly task?: AetherTask;
  readonly messages?: ReadonlyArray<AetherTimelineMessage>;
  readonly latestSequence?: number;
  readonly activeProcessingTurn?: { readonly messageId: string; readonly startedAt: string } | null;
  readonly truncated?: boolean;
}): AetherConversationDelta {
  return {
    task: overrides?.task ?? taskAwaitingMessage,
    messages: overrides?.messages ?? deltaRows,
    activity: [],
    activeProcessingTurn: overrides?.activeProcessingTurn ?? null,
    latestSequence:
      overrides?.latestSequence ??
      Math.max(0, ...(overrides?.messages ?? deltaRows).map((row) => row.sequence)),
    removedMessageIds: [],
    truncated: overrides?.truncated ?? false,
  };
}
