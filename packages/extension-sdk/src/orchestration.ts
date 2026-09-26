import { defineApi, defineStreamApi, type TypedApi, type TypedStreamApi } from "./capabilities.js";
import type { Json } from "./contracts.js";
import type { JsonObject } from "./environment.js";
import type { VcsDiffPreviewStreamEvent } from "./catalogue.js";

export const ORCHESTRATION_STATUS = "t3.orchestration/status";
export const ORCHESTRATION_CONTROL = "t3.orchestration/control";
export const ORCHESTRATION_READ = "t3.orchestration/read";
export const ORCHESTRATION_OPERATE = "t3.orchestration/operate";

export type RuntimeSubagentStatus =
  | "pending"
  | "running"
  | "waiting"
  | "idle"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type SubagentUsage = {
  readonly totalTokens: number;
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningOutputTokens?: number;
  readonly toolUses?: number;
  readonly durationMs?: number;
};

export type SubagentActivityEntry = {
  readonly at: string;
  readonly summary: string;
};

export type SubagentWorkflowPhase = {
  readonly index: number;
  readonly title: string;
};

export type SubagentRunHandles = {
  readonly runId?: string;
  readonly scriptPath?: string;
  readonly transcriptDir?: string;
  readonly sessionUrl?: string;
};

export type RuntimeSubagent = {
  readonly id: string;
  readonly kind: "subagent" | "subagent_batch" | "workflow" | "workflow_agent";
  readonly title: string;
  readonly role: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly status: RuntimeSubagentStatus;
  readonly activationCount: number;
  readonly usage: SubagentUsage | null;
  readonly progress: string | null;
  readonly lastToolName: string | null;
  readonly result: string | null;
  readonly error: string | null;
  readonly outputFile: string | null;
  readonly parentAgentId: string | null;
  readonly agentIndex: number | null;
  readonly phaseIndex: number | null;
  readonly phaseTitle: string | null;
  readonly attempt: number | null;
  readonly workflowName: string | null;
  readonly phases: ReadonlyArray<SubagentWorkflowPhase>;
  readonly runHandles: SubagentRunHandles | null;
  readonly recentActivity: ReadonlyArray<SubagentActivityEntry>;
  /** First retained observation, used as the roster's stable display order. */
  readonly firstSeenAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly updatedAt: string;
};

export type OrchestrationReceipt = {
  readonly commandId: string;
  readonly status: "accepted" | "rejected";
  readonly sequence: number;
  readonly error: string | null;
};
export type ApprovalDecision =
  | "accept"
  | "acceptForSession"
  | "acceptAlways"
  | "decline"
  | "cancel";
export type ApprovalOption = {
  readonly decision: ApprovalDecision;
  readonly label: string;
  readonly warning?: string;
};
export type PendingApproval = {
  readonly requestId: string;
  readonly requestKind: "command" | "file-read" | "file-change" | "mcp-elicitation" | "permission";
  readonly createdAt: string;
  readonly detail?: string;
  readonly appName?: string;
  readonly options?: readonly ApprovalOption[];
};
export type UserInputQuestion = {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: readonly {
    readonly label: string;
    readonly description: string;
    readonly value?: string;
  }[];
  readonly allowCustomAnswer?: boolean;
  readonly multiSelect?: boolean;
};
export type PendingUserInput = {
  readonly requestId: string;
  readonly createdAt: string;
  readonly questions: readonly UserInputQuestion[];
  readonly dismissible: boolean;
};
export type OrchestrationCheckpoint = {
  readonly turnId: string;
  readonly checkpointTurnCount: number;
  readonly checkpointRef: string;
  readonly status: "ready" | "missing" | "error";
  readonly files: readonly {
    readonly path: string;
    readonly kind: string;
    readonly additions: number;
    readonly deletions: number;
  }[];
  readonly assistantMessageId: string | null;
  readonly completedAt: string;
};
export type OrchestrationSession = {
  readonly threadId: string;
  readonly status: "idle" | "starting" | "running" | "ready" | "interrupted" | "stopped" | "error";
  readonly providerName: string | null;
  readonly providerInstanceId?: string;
  readonly runtimeMode: "full-access" | "approval-required" | "auto" | "auto-accept-edits";
  readonly activeTurnId: string | null;
  readonly lastError: string | null;
  readonly updatedAt: string;
};
export type OrchestrationTurn = {
  readonly turnId: string;
  readonly state: "running" | "completed" | "interrupted" | "error";
  readonly requestedAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly assistantMessageId: string | null;
  readonly sourceProposedPlan?: { readonly threadId: string; readonly planId: string };
};
export type AgentsState = {
  readonly agents: readonly RuntimeSubagent[];
  readonly pendingApprovals: readonly PendingApproval[];
  readonly pendingUserInputs: readonly PendingUserInput[];
  readonly checkpoints: readonly OrchestrationCheckpoint[];
  readonly session: OrchestrationSession | null;
  readonly turn: OrchestrationTurn | null;
  readonly receipts: readonly OrchestrationReceipt[];
  readonly retention: { readonly agentsCap: 100; readonly receiptsCap: 100 };
};
export type AgentsEvent =
  | ({
      readonly kind: "snapshot" | "updated";
      readonly streamEpoch: string;
      readonly revision: number;
    } & AgentsState)
  | {
      readonly kind: "receipt";
      readonly streamEpoch: string;
      readonly revision: number;
      readonly receipt: OrchestrationReceipt;
    }
  | { readonly kind: "closed"; readonly streamEpoch: string; readonly reason: "overflow" };
export type OrchestrationGuard = {
  readonly commandId?: string;
  readonly expectedEpoch?: string;
  readonly expectedRevision?: number;
};
export type TurnStartInput = OrchestrationGuard & {
  readonly text: string;
  readonly modelSelection?: {
    readonly instanceId: string;
    readonly model: string;
    readonly options?: JsonObject;
  };
  readonly runtimeMode?: "full-access" | "approval-required" | "auto" | "auto-accept-edits";
  readonly interactionMode?: "default" | "plan";
  readonly titleSeed?: string;
};
export type OrchestrationControlMethods = {
  "turn.start": { input: TurnStartInput; output: OrchestrationReceipt };
  "turn.interrupt": {
    input: OrchestrationGuard & { readonly turnId?: string };
    output: OrchestrationReceipt;
  };
  "session.stop": {
    input: OrchestrationGuard & { readonly onlyIfSettled?: boolean };
    output: OrchestrationReceipt;
  };
  "approval.respond": {
    input: OrchestrationGuard & { readonly requestId: string; readonly decision: ApprovalDecision };
    output: OrchestrationReceipt;
  };
  "userInput.respond": {
    input: OrchestrationGuard & {
      readonly requestId: string;
      readonly answers: Readonly<Record<string, Json>>;
    };
    output: OrchestrationReceipt;
  };
  "userInput.dismiss": {
    input: OrchestrationGuard & { readonly requestId: string };
    output: OrchestrationReceipt;
  };
  "thread.settle": { input: OrchestrationGuard; output: OrchestrationReceipt };
  "thread.unsettle": { input: OrchestrationGuard; output: OrchestrationReceipt };
  "checkpoint.revert": {
    input: OrchestrationGuard & { readonly turnCount: number };
    output: OrchestrationReceipt;
  };
};
export const ORCHESTRATION_CONTROL_OPS = [
  "turn.start",
  "turn.interrupt",
  "session.stop",
  "approval.respond",
  "userInput.respond",
  "userInput.dismiss",
  "thread.settle",
  "thread.unsettle",
  "checkpoint.revert",
] as const;
export type OrchestrationCapabilities = {
  readonly operations: Readonly<Record<string, boolean>>;
  readonly streamEpoch: string;
  readonly revision: number;
};
/**
 * The wire `oneOf` is the authority; `?: null` markers are the tightest
 * `Json`-compatible spelling of "the other key is absent" under
 * `exactOptionalPropertyTypes` (`?: never` falls out of `Json`). An
 * explicit `null` is still rejected by `additionalProperties: false` —
 * omit the key rather than nulling it.
 */
export type TurnDiffInput =
  | { readonly turnId: string; readonly turnCount?: null }
  | { readonly turnCount: number; readonly turnId?: null };

const str = { type: "string", maxLength: 32768 } as const;
const id = { type: "string", minLength: 1, maxLength: 160 } as const;
const num = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const;
const bool = { type: "boolean" } as const;
const nullable = (schema: JsonObject): JsonObject => ({ anyOf: [schema, { type: "null" }] });
const obj = (properties: JsonObject, required = Object.keys(properties)): JsonObject => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});
const arr = (items: JsonObject, maxItems = 100): JsonObject => ({ type: "array", items, maxItems });
const empty = obj({});
const decision = { enum: ["accept", "acceptForSession", "acceptAlways", "decline", "cancel"] };
const receipt = obj({
  commandId: id,
  status: { enum: ["accepted", "rejected"] },
  sequence: num,
  error: nullable(str),
});
const agentProps: Record<string, Json> = {
  id: str,
  kind: { enum: ["subagent", "subagent_batch", "workflow", "workflow_agent"] },
  title: str,
  status: {
    enum: [
      "pending",
      "running",
      "waiting",
      "idle",
      "completed",
      "failed",
      "cancelled",
      "interrupted",
    ],
  },
  activationCount: num,
  usage: nullable(
    obj(
      {
        totalTokens: num,
        inputTokens: num,
        cachedInputTokens: num,
        outputTokens: num,
        reasoningOutputTokens: num,
        toolUses: num,
        durationMs: { type: "number" },
      },
      ["totalTokens"],
    ),
  ),
  phases: arr(obj({ index: num, title: str })),
  runHandles: nullable(
    obj({ runId: str, scriptPath: str, transcriptDir: str, sessionUrl: str }, []),
  ),
  recentActivity: arr(obj({ at: str, summary: str })),
  firstSeenAt: str,
  updatedAt: str,
};
for (const key of [
  "role",
  "model",
  "effort",
  "progress",
  "lastToolName",
  "result",
  "error",
  "outputFile",
  "parentAgentId",
  "phaseTitle",
  "workflowName",
  "startedAt",
  "completedAt",
])
  agentProps[key] = nullable(str);
for (const key of ["agentIndex", "phaseIndex", "attempt"]) agentProps[key] = nullable(num);
const approval = obj(
  {
    requestId: id,
    requestKind: { enum: ["command", "file-read", "file-change", "mcp-elicitation", "permission"] },
    createdAt: str,
    detail: str,
    appName: str,
    options: arr(obj({ decision, label: str, warning: str }, ["decision", "label"])),
  },
  ["requestId", "requestKind", "createdAt"],
);
const question = obj(
  {
    id: str,
    header: str,
    question: str,
    options: arr(obj({ label: str, description: str, value: str }, ["label", "description"])),
    allowCustomAnswer: bool,
    multiSelect: bool,
  },
  ["id", "header", "question", "options"],
);
const sessionProps = {
  threadId: id,
  status: { enum: ["idle", "starting", "running", "ready", "interrupted", "stopped", "error"] },
  providerName: nullable(str),
  providerInstanceId: id,
  runtimeMode: { enum: ["full-access", "approval-required", "auto", "auto-accept-edits"] },
  activeTurnId: nullable(id),
  lastError: nullable(str),
  updatedAt: str,
};
const state = {
  agents: arr(obj(agentProps)),
  pendingApprovals: arr(approval),
  pendingUserInputs: arr(
    obj({ requestId: id, createdAt: str, questions: arr(question), dismissible: bool }),
  ),
  checkpoints: arr(
    obj({
      turnId: id,
      checkpointTurnCount: num,
      checkpointRef: str,
      status: { enum: ["ready", "missing", "error"] },
      files: arr(obj({ path: str, kind: str, additions: num, deletions: num }), 10000),
      assistantMessageId: nullable(id),
      completedAt: str,
    }),
    10000,
  ),
  session: nullable(
    obj(
      sessionProps,
      Object.keys(sessionProps).filter((k) => k !== "providerInstanceId"),
    ),
  ),
  turn: nullable(
    obj(
      {
        turnId: id,
        state: { enum: ["running", "completed", "interrupted", "error"] },
        requestedAt: str,
        startedAt: nullable(str),
        completedAt: nullable(str),
        assistantMessageId: nullable(id),
        sourceProposedPlan: obj({ threadId: id, planId: id }),
      },
      ["turnId", "state", "requestedAt", "startedAt", "completedAt", "assistantMessageId"],
    ),
  ),
  receipts: arr(receipt),
  retention: obj({ agentsCap: { const: 100 }, receiptsCap: { const: 100 } }),
};
const eventSchema = {
  oneOf: [
    obj({ kind: { enum: ["snapshot", "updated"] }, streamEpoch: id, revision: num, ...state }),
    obj({ kind: { const: "receipt" }, streamEpoch: id, revision: num, receipt }),
    obj({ kind: { const: "closed" }, streamEpoch: id, reason: { const: "overflow" } }),
  ],
};
const guard = { commandId: id, expectedEpoch: id, expectedRevision: num };
const operationInputs: Record<keyof OrchestrationControlMethods, JsonObject> = {
  "turn.start": obj(
    {
      ...guard,
      attachments: {},
      bootstrap: {},
      sourceProposedPlan: {},
      text: str,
      modelSelection: obj(
        { instanceId: id, model: str, options: { type: "object", additionalProperties: true } },
        ["instanceId", "model"],
      ),
      runtimeMode: { enum: ["full-access", "approval-required", "auto", "auto-accept-edits"] },
      interactionMode: { enum: ["default", "plan"] },
      titleSeed: str,
    },
    ["text"],
  ),
  "turn.interrupt": obj({ ...guard, turnId: id }, []),
  "session.stop": obj({ ...guard, onlyIfSettled: bool }, []),
  "approval.respond": obj({ ...guard, requestId: id, decision }, ["requestId", "decision"]),
  "userInput.respond": obj(
    { ...guard, requestId: id, answers: { type: "object", additionalProperties: true } },
    ["requestId", "answers"],
  ),
  "userInput.dismiss": obj({ ...guard, requestId: id }, ["requestId"]),
  "thread.settle": obj(guard, []),
  "thread.unsettle": obj(guard, []),
  "checkpoint.revert": obj({ ...guard, turnCount: num }, ["turnCount"]),
};
export const orchestrationControlApi = defineApi<OrchestrationControlMethods>({
  id: ORCHESTRATION_CONTROL,
  version: "1.0.0",
  methods: ORCHESTRATION_CONTROL_OPS.map((name) => ({
    name,
    effect: "write",
    requiredGrants: [ORCHESTRATION_OPERATE],
    inputSchema: operationInputs[name],
    outputSchema: receipt,
  })),
});
type StatusMethods = {
  getCapabilities: { input: Record<string, never>; output: OrchestrationCapabilities };
  getWorkflowScript: {
    input: { readonly workflowId: string };
    output: { readonly contents: string; readonly truncated: boolean };
  };
};
type StatusStreams = {
  subscribeAgents: { input: Record<string, never>; event: AgentsEvent };
  getTurnDiff: { input: TurnDiffInput; event: VcsDiffPreviewStreamEvent };
  getThreadDiff: { input: Record<string, never>; event: VcsDiffPreviewStreamEvent };
};
export function defineOrchestrationStatusApi(
  diffEventSchema: JsonObject,
): TypedApi<StatusMethods> & TypedStreamApi<StatusStreams> {
  return defineStreamApi<StatusStreams>({
    id: ORCHESTRATION_STATUS,
    version: "1.0.0",
    methods: [
      {
        name: "getCapabilities",
        effect: "read",
        requiredGrants: [ORCHESTRATION_READ],
        inputSchema: empty,
        outputSchema: obj({
          operations: { type: "object", additionalProperties: bool },
          streamEpoch: id,
          revision: num,
        }),
      },
      {
        name: "getWorkflowScript",
        effect: "read",
        requiredGrants: [ORCHESTRATION_READ],
        inputSchema: obj({ workflowId: id }),
        outputSchema: obj({ contents: { type: "string", maxLength: 8192 }, truncated: bool }),
      },
    ],
    streams: [
      {
        name: "subscribeAgents",
        requiredGrants: [ORCHESTRATION_READ],
        inputSchema: empty,
        eventSchema,
      },
      {
        name: "getTurnDiff",
        requiredGrants: [ORCHESTRATION_READ],
        inputSchema: { oneOf: [obj({ turnId: id }), obj({ turnCount: { ...num, minimum: 1 } })] },
        eventSchema: diffEventSchema,
      },
      {
        name: "getThreadDiff",
        requiredGrants: [ORCHESTRATION_READ],
        inputSchema: empty,
        eventSchema: diffEventSchema,
      },
    ],
  });
}
export const ORCHESTRATION_CONTROL_API = orchestrationControlApi.definition;
