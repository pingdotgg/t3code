// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off preferSchemaOverJson:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics runEffectInsideEffect:off
// @effect-diagnostics catchUnfailableEffect:off
import {
  type AntigravitySettings,
  EventId,
  type ProviderApprovalDecision,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { clearInterval, setInterval, setTimeout } from "node:timers";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { AntigravityAdapterShape } from "../Services/AntigravityAdapter.ts";
import {
  type AntigravityDaemonEndpoint,
  antigravityLanguageServerRpc,
  makeAntigravityEnvironment,
  resolveAntigravityDaemonEndpoint,
  resolveAntigravityModelLabel,
  resolveAntigravityAgentApiPath,
  resolveAntigravitySettingsPath,
  transcriptPathForConversation,
} from "./AntigravityProvider.ts";

const PROVIDER = ProviderDriverKind.make("antigravity");
const AGENTAPI_TIMEOUT_MS = 30_000;
const TRANSCRIPT_POLL_MS = 500;
const GATE_POLL_MS = 750;
const INTERRUPTED_AGENTAPI_RESULT = "__t3_antigravity_agentapi_interrupted__";
const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);
let nextEventSequence = 0;

const CONTEXT_CHECKPOINT_COMPACTION_PROMPT = [
  "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.",
  "",
  "Include:",
  "- Current progress and key decisions made",
  "- Important context, constraints, or user preferences",
  "- What remains to be done (clear next steps)",
  "- Any critical data, examples, or references needed to continue",
  "",
  "Be concise, structured, and focused on helping the next LLM seamlessly continue the work.",
].join("\n");

const AgentApiNewConversationResponse = Schema.Struct({
  response: Schema.Struct({
    newConversation: Schema.Struct({
      conversationId: Schema.String,
      prompt: Schema.optional(Schema.String),
    }),
  }),
});
const decodeNewConversationResponse = Schema.decodeUnknownSync(AgentApiNewConversationResponse);

export interface AntigravityAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runAgentApi?: (
    binaryPath: string,
    args: ReadonlyArray<string>,
    options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
  ) => Promise<string>;
}

export interface AntigravityTranscriptRecord {
  readonly step_index?: number;
  readonly source?: string;
  readonly type?: string;
  readonly status?: string;
  readonly content?: string;
  readonly error?: string;
  readonly tool_calls?: ReadonlyArray<{
    readonly name?: string;
    readonly args?: Record<string, unknown>;
  }>;
}

type AntigravityToolCall = NonNullable<AntigravityTranscriptRecord["tool_calls"]>[number];

interface SessionContext {
  session: ProviderSession;
  conversationId: string | undefined;
  readonly turns: Array<{ readonly id: TurnId; readonly items: Array<unknown> }>;
  activeTurnId: TurnId | undefined;
  readonly pendingGates: Map<string, PendingAntigravityGate>;
  // Gates that full-access auto-approved and are awaiting the daemon to clear
  // the WAITING step. Tracked separately from pendingGates so the poller does
  // not re-open or re-approve the same gate on subsequent cycles.
  readonly autoApprovedGates: Set<string>;
  poller: NodeJS.Timeout | undefined;
  gatePoller: NodeJS.Timeout | undefined;
  daemonEndpoint: AntigravityDaemonEndpoint | undefined;
  daemonEndpointResolved: boolean;
  agentApiCancel: (() => void) | undefined;
  pollOffset: number;
  pollCarry: string;
  readonly seenLines: Set<string>;
  readonly toolCallStepIndexes: Set<number>;
  pendingCompaction: PendingCompaction | undefined;
  stopped: boolean;
}

interface PendingCompaction {
  readonly turnId: TurnId;
  summary: string;
  completed: boolean;
}

interface PendingAntigravityGate {
  readonly requestId: RuntimeRequestId;
  readonly trajectoryId: string;
  readonly stepIndex: number;
  readonly kind: "permission" | "filePermission";
  readonly requestType: "command_execution_approval" | "file_read_approval";
  readonly detail: string;
  readonly absolutePathUri: string | undefined;
}

interface CascadeTrajectoryStep {
  readonly status?: string;
  readonly metadata?: {
    readonly sourceTrajectoryStepInfo?: {
      readonly trajectoryId?: string;
      readonly stepIndex?: number;
    };
  };
  readonly requestedInteraction?: {
    readonly permission?: {
      readonly resource?: { readonly action?: string; readonly target?: string };
    };
    readonly filePermission?: { readonly absolutePathUri?: string };
  };
}

interface CascadeTrajectory {
  readonly trajectoryId?: string;
  readonly steps?: ReadonlyArray<CascadeTrajectoryStep>;
}

interface CascadeTrajectoryResponse {
  readonly trajectory?: CascadeTrajectory;
}

function eventId(prefix: string): EventId {
  nextEventSequence += 1;
  return EventId.make(`${prefix}-${process.pid}-${nextEventSequence}`);
}

function runtimeEventBase(input: {
  readonly threadId: ThreadId;
  readonly instanceId?: ProviderInstanceId | undefined;
  readonly turnId?: TurnId | undefined;
  readonly itemId?: RuntimeItemId | undefined;
  readonly requestId?: RuntimeRequestId | undefined;
  readonly createdAt?: string | undefined;
  readonly method?: string | undefined;
  readonly payload?: unknown;
  readonly rawSource?: "antigravity.transcript" | "antigravity.agentapi" | undefined;
}): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  return {
    eventId: eventId("antigravity"),
    provider: PROVIDER,
    ...(input.instanceId ? { providerInstanceId: input.instanceId } : {}),
    threadId: input.threadId,
    createdAt: input.createdAt ?? "1970-01-01T00:00:00.000Z",
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: input.itemId } : {}),
    ...(input.requestId ? { requestId: input.requestId } : {}),
    raw: {
      source: input.rawSource ?? "antigravity.transcript",
      ...(input.method ? { method: input.method } : {}),
      payload: input.payload ?? {},
    },
  };
}

const currentTimestamp = Effect.map(DateTime.now, DateTime.formatIso);

function trimText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeTranscriptType(value: string | undefined): string {
  return (value ?? "").trim().toUpperCase();
}

function toolDetail(tool: AntigravityToolCall): string | undefined {
  const args = tool.args ?? {};
  const command =
    trimText(args.command) ??
    trimText(args.Command) ??
    trimText(args.command_line) ??
    trimText(args.CommandLine);
  const target =
    trimText(args.TargetFile) ??
    trimText(args.target_file) ??
    trimText(args.file_path) ??
    trimText(args.path);
  return command ?? target ?? tool.name;
}

function toolTitle(tool: AntigravityToolCall): string {
  const name = trimText(tool.name);
  if (!name) return "Tool call";
  const normalized = name.toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "list_dir" || normalized === "list_directory") return "Listed directory";
  if (normalized === "read_file") return "Read file";
  if (normalized === "write_to_file" || normalized === "write_file") return "Write file";
  return name;
}

function itemTypeForTranscript(record: AntigravityTranscriptRecord) {
  const type = normalizeTranscriptType(record.type);
  if (type.includes("RUN_COMMAND")) return "command_execution" as const;
  if (type.includes("CODE_ACTION") || type.includes("FILE")) return "file_change" as const;
  if (type.includes("LIST_DIRECTORY") || type.includes("LIST_DIR"))
    return "dynamic_tool_call" as const;
  if (record.tool_calls && record.tool_calls.length > 0) return "dynamic_tool_call" as const;
  if (type.includes("PLANNER") || type.includes("PLAN")) return "plan" as const;
  return "assistant_message" as const;
}

function isTerminalResponseRecord(input: {
  readonly method: string;
  readonly status: string;
  readonly record: AntigravityTranscriptRecord;
}): boolean {
  return (
    input.status === "DONE" &&
    (input.method.includes("FINAL") || input.method.includes("RESPONSE")) &&
    !(input.record.tool_calls && input.record.tool_calls.length > 0)
  );
}

function sanitizeAntigravityAssistantText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const lines = value.split(/\r?\n/u);
  const kept: string[] = [];
  let droppingPermissionBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      droppingPermissionBlock = false;
      kept.push(line);
      continue;
    }
    if (/^Created At:\s*\S+\s+Completed At:\s*\S+/iu.test(trimmed)) continue;
    if (/^You have read and write access to the following workspace\(s\):$/iu.test(trimmed)) {
      droppingPermissionBlock = true;
      continue;
    }
    if (/^Additionally, your current permission grants\b/iu.test(trimmed)) {
      droppingPermissionBlock = false;
      continue;
    }
    if (droppingPermissionBlock) {
      if (trimmed.startsWith("/") || /^[A-Z]:[\\/]/u.test(trimmed)) continue;
      droppingPermissionBlock = false;
    }
    if (/^(read_file|write_file|command|mcp)\([^)]+\):\s*(?:allowed|denied|ask)$/iu.test(trimmed))
      continue;
    if (/^Browser initialized successfully\b/iu.test(trimmed)) continue;
    if (/^Workflow Status:/iu.test(trimmed)) continue;
    if (/^Workflow validation is now active\b/iu.test(trimmed)) continue;
    if (/^Content Priority Mode:/iu.test(trimmed)) continue;
    kept.push(line);
  }
  const sanitized = kept.join("\n").trim();
  return sanitized.length > 0 ? sanitized : undefined;
}

function isDuplicateConcreteToolRecord(
  record: AntigravityTranscriptRecord,
  priorToolCallStepIndexes: ReadonlySet<number>,
): boolean {
  if (typeof record.step_index !== "number" || !priorToolCallStepIndexes.has(record.step_index)) {
    return false;
  }
  const type = normalizeTranscriptType(record.type);
  return type.includes("LIST_DIRECTORY") || type.includes("LIST_DIR");
}

function agentApiTimeoutMessage(): string {
  return [
    `Antigravity agentapi did not finish within ${AGENTAPI_TIMEOUT_MS / 1_000}s.`,
    "It may be waiting for an external permission prompt in Antigravity.",
    "Open Antigravity to approve or deny the request, then retry this turn.",
  ].join(" ");
}

function agentApiFailureMessage(cause: unknown): string {
  const detail = isProviderAdapterRequestError(cause)
    ? cause.detail
    : cause instanceof Error
      ? cause.message
      : String(cause);
  const message = detail.trim();
  return message.includes("agentapi timed out") ? agentApiTimeoutMessage() : message;
}

export function parseAntigravityTranscriptLine(
  line: string,
): AntigravityTranscriptRecord | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    return parsed as AntigravityTranscriptRecord;
  } catch {
    return undefined;
  }
}

export function mapAntigravityTranscriptRecordToRuntimeEvents(input: {
  readonly record: AntigravityTranscriptRecord;
  readonly threadId: ThreadId;
  readonly instanceId?: ProviderInstanceId;
  readonly turnId?: TurnId;
  readonly createdAt?: string;
}): ReadonlyArray<ProviderRuntimeEvent> {
  const { record, threadId, instanceId, turnId, createdAt } = input;
  const method = normalizeTranscriptType(record.type) || "TRANSCRIPT";
  const itemType = itemTypeForTranscript(record);
  const status = normalizeTranscriptType(record.status);
  const content = trimText(record.content);
  const error = trimText(record.error);
  const completesTurn = isTerminalResponseRecord({ method, status, record });
  const events: ProviderRuntimeEvent[] = [];

  if (method.includes("ERROR") && error) {
    events.push({
      ...runtimeEventBase({ threadId, instanceId, turnId, createdAt, method, payload: record }),
      type: "runtime.error",
      payload: {
        message: error,
        class: "provider_error",
        detail: record,
      },
    });
    events.push({
      ...runtimeEventBase({ threadId, instanceId, turnId, createdAt, method, payload: record }),
      type: "turn.completed",
      payload: {
        state: "failed",
        errorMessage: error,
      },
    });
    return events;
  }

  if (record.source && normalizeTranscriptType(record.source) !== "MODEL") {
    return events;
  }

  if (record.tool_calls && record.tool_calls.length > 0) {
    for (const [index, tool] of record.tool_calls.entries()) {
      const itemId = RuntimeItemId.make(
        `antigravity-tool-${record.step_index ?? "x"}-${index}-${tool.name ?? "tool"}`,
      );
      events.push({
        ...runtimeEventBase({
          threadId,
          instanceId,
          turnId,
          itemId,
          createdAt,
          method,
          payload: record,
        }),
        type: "item.completed",
        payload: {
          itemType: "dynamic_tool_call",
          status: "completed",
          title: toolTitle(tool),
          ...(toolDetail(tool) ? { detail: toolDetail(tool) } : {}),
          data: tool,
        },
      });
    }
  }

  if (itemType === "dynamic_tool_call") {
    const itemId = RuntimeItemId.make(`antigravity-step-${record.step_index ?? eventId("step")}`);
    if (!record.tool_calls || record.tool_calls.length === 0) {
      events.push({
        ...runtimeEventBase({
          threadId,
          instanceId,
          turnId,
          itemId,
          createdAt,
          method,
          payload: record,
        }),
        type: "item.completed",
        payload: {
          itemType,
          status: status === "ERROR" ? "failed" : "completed",
          title: method.includes("LIST") ? "Listed directory" : "Tool call",
          ...(content ? { detail: content } : {}),
          data: record,
        },
      });
    }
    return events;
  }

  if (itemType === "command_execution" || itemType === "file_change") {
    const itemId = RuntimeItemId.make(`antigravity-step-${record.step_index ?? eventId("step")}`);
    events.push({
      ...runtimeEventBase({
        threadId,
        instanceId,
        turnId,
        itemId,
        createdAt,
        method,
        payload: record,
      }),
      type: "item.completed",
      payload: {
        itemType,
        status: status === "ERROR" ? "failed" : "completed",
        title: itemType === "command_execution" ? "Ran command" : "File change",
        ...(content ? { detail: content } : {}),
        data: record,
      },
    });
    if (content) {
      events.push({
        ...runtimeEventBase({
          threadId,
          instanceId,
          turnId,
          itemId,
          createdAt,
          method,
          payload: record,
        }),
        type: "content.delta",
        payload: {
          streamKind: itemType === "command_execution" ? "command_output" : "file_change_output",
          delta: content,
        },
      });
    }
    return events;
  }

  const assistantText = sanitizeAntigravityAssistantText(content);
  if (assistantText) {
    events.push({
      ...runtimeEventBase({ threadId, instanceId, turnId, createdAt, method, payload: record }),
      type: "content.delta",
      payload: {
        streamKind: completesTurn
          ? "assistant_text"
          : itemType === "plan"
            ? "plan_text"
            : "assistant_text",
        delta: assistantText,
      },
    });
  }

  if (completesTurn) {
    events.push({
      ...runtimeEventBase({ threadId, instanceId, turnId, createdAt, method, payload: record }),
      type: "turn.completed",
      payload: {
        state: "completed",
      },
    });
  }

  return events;
}

function runAgentApiDefault(
  binaryPath: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
  onChild?: (child: ReturnType<typeof execFile>) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(binaryPath, [...args], {
      cwd: options.cwd,
      env: options.env,
      timeout: AGENTAPI_TIMEOUT_MS,
      windowsHide: true,
    });
    onChild?.(child);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      if (signal === "SIGTERM" || signal === "SIGKILL") {
        reject(new Error(`agentapi timed out after ${AGENTAPI_TIMEOUT_MS}ms`));
        return;
      }
      reject(new Error(stderr.trim() || stdout.trim() || `agentapi exited with code ${code}`));
    });
  });
}

async function ensureAntigravityCliSettings(input: {
  readonly settings: AntigravitySettings;
  readonly cwd: string;
  readonly modelLabel?: string;
}): Promise<void> {
  const { settings, cwd, modelLabel } = input;
  const settingsPath = resolveAntigravitySettingsPath(settings);
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  const existing = Array.isArray(parsed.trustedWorkspaces) ? parsed.trustedWorkspaces : [];
  let changed = false;
  if (!existing.includes(cwd)) {
    parsed.trustedWorkspaces = [...existing.filter((entry) => typeof entry === "string"), cwd];
    changed = true;
  }
  if (modelLabel && parsed.model !== modelLabel) {
    parsed.model = modelLabel;
    changed = true;
  }
  if (changed) {
    await fs.writeFile(settingsPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  }
}

// Antigravity has no native "never ask" approval policy like Codex. Its daemon
// always raises permission gates, so full-access is implemented by replying
// "allow" to each gate as it appears. This builds the HandleCascadeUserInteraction
// payload shared by the manual respondToRequest path and the auto-approve path.
function sendCascadeGateDecision(input: {
  readonly endpoint: AntigravityDaemonEndpoint;
  readonly conversationId: string;
  readonly gate: PendingAntigravityGate;
  readonly decision: ProviderApprovalDecision;
}): Promise<unknown> {
  const { endpoint, conversationId, gate, decision } = input;
  const allow = decision === "accept" || decision === "acceptForSession";
  const scope =
    decision === "acceptForSession" ? "PERMISSION_SCOPE_CONVERSATION" : "PERMISSION_SCOPE_ONCE";
  const decisionPayload =
    gate.kind === "filePermission"
      ? {
          filePermission: {
            allow,
            scope,
            ...(gate.absolutePathUri ? { absolutePathUri: gate.absolutePathUri } : {}),
          },
        }
      : { permission: { allow, scope } };
  return antigravityLanguageServerRpc({
    endpoint,
    method: "HandleCascadeUserInteraction",
    body: {
      cascadeId: conversationId,
      interaction: {
        trajectoryId: gate.trajectoryId,
        stepIndex: gate.stepIndex,
        ...decisionPayload,
      },
    },
  });
}

export const makeAntigravityAdapter = Effect.fn("makeAntigravityAdapter")(function* (
  settings: AntigravitySettings,
  options: AntigravityAdapterLiveOptions = {},
): Effect.fn.Return<AntigravityAdapterShape, never, ServerConfig | Crypto.Crypto> {
  const serverConfig = yield* Effect.service(ServerConfig);
  const crypto = yield* Crypto.Crypto;
  const randomUUIDv4 = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "crypto/randomUUIDv4",
          detail: "Failed to generate Antigravity runtime identifier.",
          cause,
        }),
    ),
  );
  const sessionsRef = yield* Ref.make(new Map<ThreadId, SessionContext>());
  const eventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const binaryPath = resolveAntigravityAgentApiPath(settings);
  const baseEnv = options.environment ?? process.env;

  const emit = (event: ProviderRuntimeEvent): void => {
    Effect.runFork(Queue.offer(eventQueue, event));
  };

  const emitGateOpened = (context: SessionContext, gate: PendingAntigravityGate): void => {
    emit({
      ...runtimeEventBase({
        threadId: context.session.threadId,
        ...(options.instanceId ? { instanceId: options.instanceId } : {}),
        ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
        requestId: gate.requestId,
        createdAt: context.session.updatedAt,
        method: "antigravity/cascade-permission-opened",
        payload: { trajectoryId: gate.trajectoryId, stepIndex: gate.stepIndex },
      }),
      type: "request.opened",
      payload: { requestType: gate.requestType, detail: gate.detail },
    });
  };

  const emitGateResolved = (
    context: SessionContext,
    gate: PendingAntigravityGate,
    decision: string,
  ): void => {
    emit({
      ...runtimeEventBase({
        threadId: context.session.threadId,
        ...(options.instanceId ? { instanceId: options.instanceId } : {}),
        ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
        requestId: gate.requestId,
        createdAt: context.session.updatedAt,
        method: "antigravity/cascade-permission-resolved",
        payload: { trajectoryId: gate.trajectoryId, stepIndex: gate.stepIndex },
      }),
      type: "request.resolved",
      payload: { requestType: gate.requestType, decision },
    });
  };

  const endpointFor = (context: SessionContext): AntigravityDaemonEndpoint | undefined => {
    if (!context.daemonEndpointResolved) {
      context.daemonEndpointResolved = true;
      context.daemonEndpoint = resolveAntigravityDaemonEndpoint(
        settings,
        baseEnv,
        context.session.cwd ?? serverConfig.cwd,
      );
    }
    return context.daemonEndpoint;
  };

  const pollGates = async (context: SessionContext): Promise<void> => {
    // Permission gates only occur while a turn is executing; skipping otherwise avoids
    // continuously fetching the (large) trajectory and re-running daemon detection.
    if (context.stopped || !context.conversationId || !context.activeTurnId) return;
    const endpoint = endpointFor(context);
    if (!endpoint) return;
    const conversationId = context.conversationId;
    // Full-access mirrors Codex's "never ask" policy: Antigravity always raises
    // gates, so we answer "allow" the moment each one appears instead of waiting
    // for a human (which other runtime modes still do).
    const autoApprove = context.session.runtimeMode === "full-access";
    let trajectory: CascadeTrajectory | undefined;
    try {
      const response = (await antigravityLanguageServerRpc({
        endpoint,
        method: "GetCascadeTrajectory",
        body: { cascadeId: conversationId },
      })) as CascadeTrajectoryResponse;
      trajectory = response.trajectory;
    } catch {
      // Transient RPC failure; keep the cached endpoint (re-resolving here blocks the event loop).
      return;
    }
    const steps = trajectory?.steps ?? [];
    const seen = new Set<string>();
    const autoApproveQueue: PendingAntigravityGate[] = [];
    steps.forEach((step, index) => {
      const interaction = step.requestedInteraction;
      if (step.status !== "CORTEX_STEP_STATUS_WAITING" || !interaction) return;
      const info = step.metadata?.sourceTrajectoryStepInfo;
      const trajectoryId = trimText(info?.trajectoryId) ?? trimText(trajectory?.trajectoryId);
      const stepIndex = typeof info?.stepIndex === "number" ? info.stepIndex : index;
      if (!trajectoryId) return;
      const id = `antigravity-approval:${trajectoryId}:${stepIndex}`;
      seen.add(id);
      // Skip gates already surfaced for manual approval or already auto-approved
      // (the daemon may keep reporting WAITING until it processes our decision).
      if (context.pendingGates.has(id) || context.autoApprovedGates.has(id)) return;
      const isFile = interaction.filePermission !== undefined;
      const gate: PendingAntigravityGate = {
        requestId: RuntimeRequestId.make(id),
        trajectoryId,
        stepIndex,
        kind: isFile ? "filePermission" : "permission",
        requestType: isFile ? "file_read_approval" : "command_execution_approval",
        detail:
          trimText(interaction.permission?.resource?.target) ??
          trimText(interaction.filePermission?.absolutePathUri) ??
          (isFile ? "Antigravity file access request" : "Antigravity command request"),
        absolutePathUri: isFile ? trimText(interaction.filePermission?.absolutePathUri) : undefined,
      };
      if (autoApprove) {
        // Reserve synchronously so overlapping poll cycles do not approve twice.
        context.autoApprovedGates.add(id);
        autoApproveQueue.push(gate);
      } else {
        emitGateOpened(context, gate);
        context.pendingGates.set(id, gate);
      }
    });
    for (const [id, gate] of context.pendingGates) {
      if (!seen.has(id)) {
        context.pendingGates.delete(id);
        emitGateResolved(context, gate, "external");
      }
    }
    // Drop auto-approved markers once the daemon has cleared the WAITING step.
    for (const id of context.autoApprovedGates) {
      if (!seen.has(id)) context.autoApprovedGates.delete(id);
    }
    for (const gate of autoApproveQueue) {
      try {
        await sendCascadeGateDecision({ endpoint, conversationId, gate, decision: "accept" });
      } catch {
        // Auto-approval failed (e.g. daemon RPC error): fall back to manual
        // approval so the turn is not silently stuck.
        context.autoApprovedGates.delete(gate.requestId);
        emitGateOpened(context, gate);
        context.pendingGates.set(gate.requestId, gate);
      }
    }
  };

  const startGatePoller = (context: SessionContext): void => {
    if (!context.conversationId || context.gatePoller) return;
    context.gatePoller = setInterval(() => {
      void pollGates(context);
    }, GATE_POLL_MS);
    void pollGates(context);
  };

  const emitThreadCompacted = (context: SessionContext, createdAt: string, detail?: unknown) => {
    emit({
      ...runtimeEventBase({
        threadId: context.session.threadId,
        ...(options.instanceId ? { instanceId: options.instanceId } : {}),
        createdAt,
        method: "thread/compacted",
        rawSource: "antigravity.agentapi",
        payload: detail ?? {},
      }),
      type: "thread.state.changed",
      payload: {
        state: "compacted",
        ...(detail !== undefined ? { detail } : {}),
      },
    });
  };

  const startCompactedConversation = async (
    context: SessionContext,
    summary: string,
  ): Promise<void> => {
    const pendingCompaction = context.pendingCompaction;
    if (!pendingCompaction || pendingCompaction.completed || context.stopped) return;
    context.pendingCompaction = {
      ...pendingCompaction,
      completed: true,
    };
    const cwd = context.session.cwd ?? serverConfig.cwd;
    const env = makeAntigravityEnvironment(settings, baseEnv, cwd);
    const seedPrompt = [
      "<T3_CONTEXT_CHECKPOINT>",
      "Continue this conversation from the compacted handoff summary below. Do not repeat the summary unless the user asks.",
      "",
      summary.trim(),
      "</T3_CONTEXT_CHECKPOINT>",
    ].join("\n");
    const stdout = await (options.runAgentApi
      ? options.runAgentApi(binaryPath, ["new-conversation", seedPrompt], { cwd, env })
      : runAgentApiDefault(binaryPath, ["new-conversation", seedPrompt], { cwd, env }));
    const decoded = decodeNewConversationResponse(JSON.parse(stdout) as unknown);
    const conversationId = decoded.response.newConversation.conversationId;
    const updatedAt = new Date().toISOString();
    context.conversationId = conversationId;
    context.session = {
      ...context.session,
      status: "ready",
      activeTurnId: undefined,
      resumeCursor: { conversationId },
      updatedAt,
    };
    context.pollOffset = 0;
    context.pollCarry = "";
    context.seenLines.clear();
    context.toolCallStepIndexes.clear();
    context.pendingCompaction = undefined;
    if (context.poller) {
      clearInterval(context.poller);
      context.poller = undefined;
    }
    startTranscriptPoller(context);
    startGatePoller(context);
    emitThreadCompacted(context, updatedAt, { conversationId });
  };

  const getContext = (threadId: ThreadId, _method: string) =>
    Ref.get(sessionsRef).pipe(
      Effect.flatMap((sessions) => {
        const context = sessions.get(threadId);
        if (!context || context.stopped) {
          return Effect.fail(
            new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
          );
        }
        return Effect.succeed(context);
      }),
    );

  // Antigravity backgrounds work and resumes after the transcript already
  // looked "completed" (e.g. it launched a command, waited, then kept going).
  // Reopen a turn so resumed output is framed and the session reflects that
  // the agent is running again instead of staying stuck in the stopped state.
  const reopenTurn = (context: SessionContext): void => {
    const turnId = TurnId.make(`antigravity-turn-${randomUUID()}`);
    const updatedAt = context.session.updatedAt;
    context.activeTurnId = turnId;
    context.session = {
      ...context.session,
      status: "running",
      activeTurnId: turnId,
      updatedAt,
    };
    emit({
      ...runtimeEventBase({
        threadId: context.session.threadId,
        ...(options.instanceId ? { instanceId: options.instanceId } : {}),
        turnId,
        createdAt: updatedAt,
        method: "turn.resume",
      }),
      type: "turn.started",
      payload: {},
    });
  };

  const startTranscriptPoller = (context: SessionContext): void => {
    if (!context.conversationId || context.poller) return;
    const transcriptPath = transcriptPathForConversation({
      settings,
      conversationId: context.conversationId,
    });

    const poll = async () => {
      if (context.stopped) return;
      try {
        const stat = await fs.stat(transcriptPath);
        if (stat.size < context.pollOffset) {
          context.pollOffset = 0;
          context.pollCarry = "";
          context.seenLines.clear();
          context.toolCallStepIndexes.clear();
        }
        if (stat.size === context.pollOffset) return;
        const handle = await fs.open(transcriptPath, "r");
        try {
          const length = stat.size - context.pollOffset;
          const buffer = Buffer.alloc(length);
          await handle.read(buffer, 0, length, context.pollOffset);
          context.pollOffset = stat.size;
          const text = context.pollCarry + buffer.toString("utf8");
          const lines = text.split(/\r?\n/g);
          context.pollCarry = lines.pop() ?? "";
          for (const line of lines) {
            const key = line.trim();
            if (!key || context.seenLines.has(key)) continue;
            context.seenLines.add(key);
            const record = parseAntigravityTranscriptLine(line);
            if (!record) continue;
            if (isDuplicateConcreteToolRecord(record, context.toolCallStepIndexes)) continue;
            if (typeof record.step_index === "number" && record.tool_calls?.length) {
              context.toolCallStepIndexes.add(record.step_index);
            }
            const mapRecord = () =>
              mapAntigravityTranscriptRecordToRuntimeEvents({
                record,
                threadId: context.session.threadId,
                ...(options.instanceId ? { instanceId: options.instanceId } : {}),
                ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
                createdAt: context.session.updatedAt,
              });
            let mapped = mapRecord();
            if (mapped.length === 0) continue;
            // Resumed output after a prior turn.completed: reopen the turn so it
            // is shown and the session flips back to running, then re-map so the
            // events carry the reopened turn id.
            if (context.activeTurnId === undefined && !context.stopped) {
              reopenTurn(context);
              mapped = mapRecord();
            }
            for (const event of mapped) {
              const pendingCompaction = context.pendingCompaction;
              if (
                pendingCompaction &&
                event.turnId === pendingCompaction.turnId &&
                event.type === "content.delta" &&
                event.payload.streamKind === "assistant_text"
              ) {
                pendingCompaction.summary += event.payload.delta;
              }
              emit(event);
              if (event.type === "turn.completed") {
                const shouldFinalizeCompaction =
                  pendingCompaction !== undefined &&
                  event.turnId === pendingCompaction.turnId &&
                  pendingCompaction.summary.trim().length > 0;
                context.activeTurnId = undefined;
                context.session = {
                  ...context.session,
                  status: "ready",
                  activeTurnId: undefined,
                  updatedAt: context.session.updatedAt,
                };
                if (shouldFinalizeCompaction) {
                  startCompactedConversation(context, pendingCompaction.summary).catch((cause) => {
                    const detail = cause instanceof Error ? cause.message : String(cause);
                    context.pendingCompaction = undefined;
                    emit({
                      ...runtimeEventBase({
                        threadId: context.session.threadId,
                        ...(options.instanceId ? { instanceId: options.instanceId } : {}),
                        createdAt: new Date().toISOString(),
                        method: "compact.new-conversation",
                        rawSource: "antigravity.agentapi",
                        payload: { detail },
                      }),
                      type: "runtime.error",
                      payload: {
                        message: `Failed to start compacted Antigravity conversation: ${detail}`,
                        class: "provider_error",
                        detail,
                      },
                    });
                  });
                }
              }
            }
          }
        } finally {
          await handle.close();
        }
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        emit({
          ...runtimeEventBase({
            threadId: context.session.threadId,
            ...(options.instanceId ? { instanceId: options.instanceId } : {}),
            createdAt: context.session.updatedAt,
            method: "transcript.poll",
            payload: { transcriptPath },
          }),
          type: "runtime.warning",
          payload: {
            message: `Failed to read Antigravity transcript: ${error.message}`,
          },
        });
      }
    };
    context.poller = setInterval(() => {
      void poll();
    }, TRANSCRIPT_POLL_MS);
    void poll();
  };

  const startSession: AntigravityAdapterShape["startSession"] = Effect.fn(
    "AntigravityAdapter.startSession",
  )(function* (input) {
    const createdAt = yield* currentTimestamp;
    const modelLabel = resolveAntigravityModelLabel(input.modelSelection);
    const session: ProviderSession = {
      provider: PROVIDER,
      ...(options.instanceId ? { providerInstanceId: options.instanceId } : {}),
      status: "ready",
      runtimeMode: input.runtimeMode,
      cwd: input.cwd ?? serverConfig.cwd,
      ...(modelLabel ? { model: modelLabel } : {}),
      threadId: input.threadId,
      ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
      createdAt,
      updatedAt: createdAt,
    };
    const context: SessionContext = {
      session,
      conversationId:
        input.resumeCursor &&
        typeof input.resumeCursor === "object" &&
        "conversationId" in input.resumeCursor &&
        typeof input.resumeCursor.conversationId === "string"
          ? input.resumeCursor.conversationId
          : undefined,
      turns: [],
      activeTurnId: undefined,
      pendingGates: new Map(),
      autoApprovedGates: new Set(),
      poller: undefined,
      gatePoller: undefined,
      daemonEndpoint: undefined,
      daemonEndpointResolved: false,
      agentApiCancel: undefined,
      pollOffset: 0,
      pollCarry: "",
      seenLines: new Set(),
      toolCallStepIndexes: new Set(),
      pendingCompaction: undefined,
      stopped: false,
    };
    yield* Ref.update(sessionsRef, (sessions) => new Map(sessions).set(input.threadId, context));
    if (context.conversationId) {
      startTranscriptPoller(context);
      startGatePoller(context);
    }
    emit({
      ...runtimeEventBase({
        threadId: input.threadId,
        ...(options.instanceId ? { instanceId: options.instanceId } : {}),
        createdAt,
        method: "session.start",
      }),
      type: "session.started",
      payload: context.conversationId ? { resume: { conversationId: context.conversationId } } : {},
    });
    return session;
  });

  const sendTurn: AntigravityAdapterShape["sendTurn"] = Effect.fn("AntigravityAdapter.sendTurn")(
    function* (input) {
      const context = yield* getContext(input.threadId, "sendTurn");
      const prompt = input.input?.trim();
      if (!prompt) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "Antigravity requires a non-empty text prompt.",
        });
      }

      const cwd = context.session.cwd ?? serverConfig.cwd;
      const modelLabel = resolveAntigravityModelLabel(input.modelSelection);
      const env = makeAntigravityEnvironment(settings, baseEnv, cwd);
      yield* Effect.tryPromise({
        try: () =>
          ensureAntigravityCliSettings({
            settings,
            cwd,
            ...(modelLabel ? { modelLabel } : {}),
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "settings.write",
            detail:
              cause instanceof Error
                ? cause.message
                : "Failed to prepare Antigravity CLI settings.",
            cause,
          }),
      }).pipe(Effect.catch(() => Effect.void));
      const attachmentText = (input.attachments ?? [])
        .map((attachment) =>
          resolveAttachmentPath({ attachmentsDir: serverConfig.attachmentsDir, attachment }),
        )
        .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
        .map((entry) => `\nAttachment: ${entry}`)
        .join("");
      const fullPrompt = [
        `<T3_WORKSPACE_CONTEXT>\nCurrent working directory: ${cwd}\nWhen the user refers to "this folder", "here", or the current folder, use this directory.\n</T3_WORKSPACE_CONTEXT>`,
        `${prompt}${attachmentText}`,
      ].join("\n\n");
      const turnId = TurnId.make(`antigravity-turn-${yield* randomUUIDv4}`);
      const updatedAt = yield* currentTimestamp;

      context.activeTurnId = turnId;
      context.session = {
        ...context.session,
        status: "running",
        activeTurnId: turnId,
        ...(modelLabel ? { model: modelLabel } : {}),
        updatedAt,
      };
      context.turns.push({ id: turnId, items: [] });
      emit({
        ...runtimeEventBase({
          threadId: input.threadId,
          ...(options.instanceId ? { instanceId: options.instanceId } : {}),
          turnId,
          createdAt: updatedAt,
          method: "turn.start",
        }),
        type: "turn.started",
        payload: modelLabel ? { model: modelLabel } : {},
      });

      const args = context.conversationId
        ? ["send-message", context.conversationId, fullPrompt]
        : ["new-conversation", fullPrompt];
      let agentApiCancel: (() => void) | undefined;
      const stdout = yield* Effect.tryPromise({
        try: () =>
          options.runAgentApi
            ? options.runAgentApi(binaryPath, args, { cwd, env })
            : runAgentApiDefault(binaryPath, args, { cwd, env }, (child) => {
                agentApiCancel = () => {
                  if (child.exitCode !== null || child.killed) {
                    return;
                  }
                  child.kill("SIGTERM");
                  setTimeout(() => {
                    if (child.exitCode === null && !child.killed) {
                      child.kill("SIGKILL");
                    }
                  }, 2_000).unref?.();
                };
              }),
        catch: (cause) => {
          const detail = cause instanceof Error ? cause.message : String(cause);
          return new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: args[0] ?? "agentapi",
            detail,
            cause,
          });
        },
      }).pipe(
        Effect.catch((error: ProviderAdapterRequestError) =>
          Effect.gen(function* () {
            const wasInterrupted = context.activeTurnId !== turnId;
            if (wasInterrupted) {
              context.agentApiCancel = undefined;
              return INTERRUPTED_AGENTAPI_RESULT;
            }
            const message = agentApiFailureMessage(error);
            const failedAt = yield* currentTimestamp;
            yield* Queue.offer(eventQueue, {
              ...runtimeEventBase({
                threadId: input.threadId,
                ...(options.instanceId ? { instanceId: options.instanceId } : {}),
                turnId,
                createdAt: failedAt,
                method: "agentapi.error",
                rawSource: "antigravity.agentapi",
                payload: {
                  method: args[0] ?? "agentapi",
                  detail: error.detail,
                },
              }),
              type: "runtime.error",
              payload: {
                message,
                class: "provider_error",
                detail: error.detail,
              },
            });
            yield* Queue.offer(eventQueue, {
              ...runtimeEventBase({
                threadId: input.threadId,
                ...(options.instanceId ? { instanceId: options.instanceId } : {}),
                turnId,
                createdAt: failedAt,
                method: "agentapi.error",
                rawSource: "antigravity.agentapi",
                payload: {
                  method: args[0] ?? "agentapi",
                  detail: error.detail,
                },
              }),
              type: "turn.completed",
              payload: {
                state: "failed",
                errorMessage: message,
              },
            });
            context.activeTurnId = undefined;
            context.agentApiCancel = undefined;
            context.session = {
              ...context.session,
              status: "error",
              activeTurnId: undefined,
              lastError: message,
              updatedAt: failedAt,
            };
            return yield* error;
          }),
        ),
      );
      context.agentApiCancel = agentApiCancel;
      if (stdout === INTERRUPTED_AGENTAPI_RESULT) {
        return {
          threadId: input.threadId,
          turnId,
          ...(context.conversationId
            ? { resumeCursor: { conversationId: context.conversationId } }
            : {}),
        } satisfies ProviderTurnStartResult;
      }
      context.agentApiCancel = undefined;

      if (!context.conversationId) {
        const parsedJson = yield* Effect.try({
          try: () => JSON.parse(stdout) as unknown,
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "new-conversation",
              detail: "Antigravity agentapi returned invalid JSON.",
              cause,
            }),
        });
        const decoded = yield* Effect.try({
          try: () => decodeNewConversationResponse(parsedJson),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "new-conversation",
              detail: "Antigravity agentapi response did not include a conversation id.",
              cause,
            }),
        });
        context.conversationId = decoded.response.newConversation.conversationId;
        const updatedAt = yield* currentTimestamp;
        context.session = {
          ...context.session,
          resumeCursor: { conversationId: context.conversationId },
          updatedAt,
        };
        startTranscriptPoller(context);
        startGatePoller(context);
      }

      return {
        threadId: input.threadId,
        turnId,
        ...(context.conversationId
          ? { resumeCursor: { conversationId: context.conversationId } }
          : {}),
      } satisfies ProviderTurnStartResult;
    },
  );

  const interruptTurn: AntigravityAdapterShape["interruptTurn"] = Effect.fn(
    "AntigravityAdapter.interruptTurn",
  )(function* (threadId) {
    const context = yield* getContext(threadId, "interruptTurn");
    const turnId = context.activeTurnId;
    context.agentApiCancel?.();
    context.agentApiCancel = undefined;
    const endpoint = endpointFor(context);
    if (context.conversationId && endpoint) {
      yield* Effect.tryPromise(() =>
        antigravityLanguageServerRpc({
          endpoint,
          method: "CancelCascadeInvocation",
          body: {
            cascadeId: context.conversationId,
            killBackgroundTasks: true,
            notifyParent: false,
          },
        }),
      ).pipe(Effect.catch(() => Effect.void));
    }
    const updatedAt = yield* currentTimestamp;
    context.activeTurnId = undefined;
    context.pendingCompaction = undefined;
    context.pendingGates.clear();
    context.autoApprovedGates.clear();
    context.agentApiCancel = undefined;
    context.session = { ...context.session, status: "ready", activeTurnId: undefined, updatedAt };
    emit({
      ...runtimeEventBase({
        threadId,
        ...(options.instanceId ? { instanceId: options.instanceId } : {}),
        ...(turnId ? { turnId } : {}),
        createdAt: updatedAt,
        method: "interrupt",
      }),
      type: "turn.completed",
      payload: { state: "cancelled" },
    });
  });

  const compactThread: AntigravityAdapterShape["compactThread"] = Effect.fn(
    "AntigravityAdapter.compactThread",
  )(function* (threadId) {
    const context = yield* getContext(threadId, "compactThread");
    if (context.activeTurnId) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "compactThread",
        issue: "Cannot compact Antigravity while a turn is already running.",
      });
    }
    const result = yield* sendTurn({
      threadId,
      input: CONTEXT_CHECKPOINT_COMPACTION_PROMPT,
      attachments: [],
    });
    context.pendingCompaction = {
      turnId: result.turnId,
      summary: "",
      completed: false,
    };
  });

  const respondToRequest: AntigravityAdapterShape["respondToRequest"] = (
    threadId,
    requestId,
    decision: ProviderApprovalDecision,
  ) =>
    getContext(threadId, "respondToRequest").pipe(
      Effect.flatMap((context) => {
        const gate = context.pendingGates.get(requestId);
        const endpoint = gate ? endpointFor(context) : undefined;
        const conversationId = context.conversationId;
        if (!gate || !conversationId || !endpoint) {
          return Effect.fail(
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "respondToRequest",
              detail: `Antigravity has no pending approval ${requestId}.`,
            }),
          );
        }
        return Effect.tryPromise({
          try: () => sendCascadeGateDecision({ endpoint, conversationId, gate, decision }),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "HandleCascadeUserInteraction",
              detail: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
        }).pipe(
          Effect.map(() => {
            context.pendingGates.delete(requestId);
            context.autoApprovedGates.delete(requestId);
            emitGateResolved(context, gate, decision);
          }),
        );
      }),
      Effect.asVoid,
    );

  const respondToUserInput: AntigravityAdapterShape["respondToUserInput"] = (
    threadId,
    requestId,
    _answers: ProviderUserInputAnswers,
  ) =>
    getContext(threadId, "respondToUserInput").pipe(
      Effect.flatMap(() =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "respondToUserInput",
            detail: `Antigravity daemon mode did not expose pending user input ${requestId}.`,
          }),
        ),
      ),
      Effect.asVoid,
    );

  const stopSession: AntigravityAdapterShape["stopSession"] = Effect.fn(
    "AntigravityAdapter.stopSession",
  )(function* (threadId) {
    const context = yield* getContext(threadId, "stopSession");
    const updatedAt = yield* currentTimestamp;
    context.stopped = true;
    context.agentApiCancel?.();
    context.agentApiCancel = undefined;
    if (context.poller) clearInterval(context.poller);
    if (context.gatePoller) clearInterval(context.gatePoller);
    context.session = { ...context.session, status: "closed", updatedAt };
    yield* Ref.update(sessionsRef, (sessions) => {
      const next = new Map(sessions);
      next.delete(threadId);
      return next;
    });
  });

  const listSessions = () =>
    Ref.get(sessionsRef).pipe(
      Effect.map((sessions) => Array.from(sessions.values(), (entry) => entry.session)),
    );
  const hasSession = (threadId: ThreadId) =>
    Ref.get(sessionsRef).pipe(Effect.map((sessions) => sessions.has(threadId)));

  const stopAll = () =>
    Ref.get(sessionsRef).pipe(
      Effect.flatMap((sessions) =>
        Effect.forEach(Array.from(sessions.keys()), (threadId) => stopSession(threadId), {
          concurrency: "unbounded",
          discard: true,
        }),
      ),
    );

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session" },
    startSession,
    sendTurn,
    interruptTurn,
    compactThread,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread: (threadId) =>
      getContext(threadId, "readThread").pipe(
        Effect.map((context) => ({
          threadId,
          turns: context.turns,
        })),
      ),
    rollbackThread: (threadId) =>
      getContext(threadId, "rollbackThread").pipe(
        Effect.map((context) => ({
          threadId,
          turns: context.turns,
        })),
      ),
    stopAll,
    streamEvents: Stream.fromQueue(eventQueue),
  } satisfies AntigravityAdapterShape;
});
