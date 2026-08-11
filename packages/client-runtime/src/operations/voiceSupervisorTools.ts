import {
  CommandId,
  EnvironmentId,
  IsoDateTime,
  MessageId,
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  buildFollowUpThreadInput,
  buildStartProjectTaskInput,
  buildThreadTurnInterruptInput,
  type BuiltFollowUpThreadInput,
  type BuiltInterruptThreadInput,
  type BuiltStartProjectTaskInput,
  type ProjectTaskWorkspace,
  type ThreadTaskCommandMetadata,
} from "./threadTasks.ts";
import {
  boundSupervisorText,
  createSupervisorJsonSnapshot,
  type PublishSupervisorTargetsResult,
  type SupervisorConfirmedMutationResult,
  type SupervisorExecutionRejectionReason,
  type SupervisorJsonSnapshotFailureReason,
  type SupervisorMutationProposalResult,
  type SupervisorProposalHandle,
  type SupervisorTargetAvailability,
  type SupervisorTargetBinding,
  type SupervisorTargetCandidate,
  type SupervisorTargetHandle,
  type SupervisorTargetResolution,
  type SupervisorTargetVersion,
  type ThreadSupervisorCore,
} from "./threadSupervisor.ts";
import {
  resolveThreadOperationalStatus,
  type ThreadOperationalStatus,
} from "../state/threadOperationalStatus.ts";
import type { EnvironmentProject, EnvironmentThreadShell } from "../state/shell.ts";

export const MAX_VOICE_TOOL_CALL_ID_CHARS = 160;
export const MAX_VOICE_TOOL_SELECTOR_CHARS = 512;
export const MAX_VOICE_TOOL_INSTRUCTION_CHARS = 4_000;
export const MAX_VOICE_TOOL_TITLE_CHARS = 72;
export const MAX_VOICE_TOOL_LIST_ITEMS = 20;
export const MAX_VOICE_TARGET_LABEL_CHARS = 240;
const MAX_VOICE_ENVIRONMENT_QUALIFIER_CHARS = 96;
const VOICE_TARGET_LABEL_SEPARATOR = " · ";
const MAX_SUMMARY_TEXT_CHARS = MAX_VOICE_TARGET_LABEL_CHARS;
const MAX_PATH_CHARS = 4_096;
const DEFAULT_MAX_TOOL_CALLS = 256;
const VOICE_RESULT_SNAPSHOT_BOUNDS = Object.freeze({
  maxDepth: 8,
  maxNodes: 512,
  maxBytes: 16 * 1_024,
  maxKeys: 512,
  maxArrayItems: MAX_VOICE_TOOL_LIST_ITEMS,
});
const UNSAFE_TOOL_ARGUMENT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function buildVoiceTargetDisplayLabel(title: string, environmentLabel: string): string {
  const environmentBudget = Math.min(
    MAX_VOICE_ENVIRONMENT_QUALIFIER_CHARS,
    MAX_VOICE_TARGET_LABEL_CHARS - VOICE_TARGET_LABEL_SEPARATOR.length - 1,
  );
  const boundedEnvironment =
    environmentLabel.length <= environmentBudget
      ? environmentLabel
      : `${environmentLabel.slice(0, Math.ceil((environmentBudget - 3) / 2)).trimEnd()}...${environmentLabel.slice(-Math.floor((environmentBudget - 3) / 2)).trimStart()}`;
  const titleBudget =
    MAX_VOICE_TARGET_LABEL_CHARS - VOICE_TARGET_LABEL_SEPARATOR.length - boundedEnvironment.length;
  return `${boundSupervisorText(title, titleBudget)}${VOICE_TARGET_LABEL_SEPARATOR}${boundedEnvironment}`;
}

const VoiceCallId = TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_VOICE_TOOL_CALL_ID_CHARS));
const VoiceSelector = TrimmedNonEmptyString.check(
  Schema.isMaxLength(MAX_VOICE_TOOL_SELECTOR_CHARS),
);
const VoiceInstruction = TrimmedNonEmptyString.check(
  Schema.isMaxLength(MAX_VOICE_TOOL_INSTRUCTION_CHARS),
);
const VoiceTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_VOICE_TOOL_TITLE_CHARS));
const VoiceListLimit = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(MAX_VOICE_TOOL_LIST_ITEMS),
);

export const VoiceListToolArguments = Schema.Struct({
  call_id: VoiceCallId,
  limit: Schema.optionalKey(VoiceListLimit),
});

export const VoiceThreadReadToolArguments = Schema.Struct({
  call_id: VoiceCallId,
  thread: VoiceSelector,
});

export const VoiceStartThreadToolArguments = Schema.Struct({
  call_id: VoiceCallId,
  project_handle: VoiceSelector,
  instruction: VoiceInstruction,
  title: Schema.optionalKey(VoiceTitle),
});

export const VoiceFollowUpToolArguments = Schema.Struct({
  call_id: VoiceCallId,
  thread_handle: VoiceSelector,
  instruction: VoiceInstruction,
});

export const VoiceInterruptToolArguments = Schema.Struct({
  call_id: VoiceCallId,
  thread_handle: VoiceSelector,
});

export const VoiceToolArgumentSchemas = {
  list_active_work: VoiceListToolArguments,
  list_projects: VoiceListToolArguments,
  list_threads: VoiceListToolArguments,
  get_thread_summary: VoiceThreadReadToolArguments,
  open_thread: VoiceThreadReadToolArguments,
  start_thread: VoiceStartThreadToolArguments,
  send_follow_up: VoiceFollowUpToolArguments,
  interrupt_thread: VoiceInterruptToolArguments,
} as const;

export type VoiceSupervisorToolName = keyof typeof VoiceToolArgumentSchemas;

type VoiceSupervisorWireProperty =
  | {
      readonly type: "string";
      readonly minLength: 1;
      readonly maxLength: number;
    }
  | {
      readonly type: "integer";
      readonly minimum: 0;
      readonly maximum: number;
    };

export interface VoiceSupervisorWireParameters {
  readonly type: "object";
  readonly properties: Readonly<Record<string, VoiceSupervisorWireProperty>>;
  readonly required?: ReadonlyArray<string>;
  readonly additionalProperties: false;
}

const stringParameter = (maxLength: number): VoiceSupervisorWireProperty => ({
  type: "string",
  minLength: 1,
  maxLength,
});

const listParameters: VoiceSupervisorWireParameters = {
  type: "object",
  properties: {
    limit: { type: "integer", minimum: 0, maximum: MAX_VOICE_TOOL_LIST_ITEMS },
  },
  additionalProperties: false,
};

export const voiceSupervisorToolParameters = {
  list_active_work: listParameters,
  list_projects: listParameters,
  list_threads: listParameters,
  get_thread_summary: {
    type: "object",
    properties: { thread: stringParameter(MAX_VOICE_TOOL_SELECTOR_CHARS) },
    required: ["thread"],
    additionalProperties: false,
  },
  open_thread: {
    type: "object",
    properties: { thread: stringParameter(MAX_VOICE_TOOL_SELECTOR_CHARS) },
    required: ["thread"],
    additionalProperties: false,
  },
  start_thread: {
    type: "object",
    properties: {
      project_handle: stringParameter(MAX_VOICE_TOOL_SELECTOR_CHARS),
      instruction: stringParameter(MAX_VOICE_TOOL_INSTRUCTION_CHARS),
      title: stringParameter(MAX_VOICE_TOOL_TITLE_CHARS),
    },
    required: ["project_handle", "instruction"],
    additionalProperties: false,
  },
  send_follow_up: {
    type: "object",
    properties: {
      thread_handle: stringParameter(MAX_VOICE_TOOL_SELECTOR_CHARS),
      instruction: stringParameter(MAX_VOICE_TOOL_INSTRUCTION_CHARS),
    },
    required: ["thread_handle", "instruction"],
    additionalProperties: false,
  },
  interrupt_thread: {
    type: "object",
    properties: { thread_handle: stringParameter(MAX_VOICE_TOOL_SELECTOR_CHARS) },
    required: ["thread_handle"],
    additionalProperties: false,
  },
} as const satisfies Record<VoiceSupervisorToolName, VoiceSupervisorWireParameters>;

export interface VoiceSupervisorToolDefinition {
  readonly name: VoiceSupervisorToolName;
  readonly description: string;
  readonly kind: "read" | "navigation" | "mutation";
  readonly inputSchema: Schema.Top;
  /** Closed model-facing schema. The protocol-authoritative call_id is injected locally. */
  readonly parameters: VoiceSupervisorWireParameters;
}

export const voiceSupervisorToolDefinitions: ReadonlyArray<VoiceSupervisorToolDefinition> =
  Object.freeze([
    {
      name: "list_active_work",
      description: "List bounded active coding work and return opaque thread handles.",
      kind: "read",
      inputSchema: VoiceListToolArguments,
      parameters: voiceSupervisorToolParameters.list_active_work,
    },
    {
      name: "list_projects",
      description: "List bounded projects and return opaque project handles.",
      kind: "read",
      inputSchema: VoiceListToolArguments,
      parameters: voiceSupervisorToolParameters.list_projects,
    },
    {
      name: "list_threads",
      description: "List bounded non-archived threads and return opaque thread handles.",
      kind: "read",
      inputSchema: VoiceListToolArguments,
      parameters: voiceSupervisorToolParameters.list_threads,
    },
    {
      name: "get_thread_summary",
      description: "Read one bounded thread summary by opaque handle or exact display name.",
      kind: "read",
      inputSchema: VoiceThreadReadToolArguments,
      parameters: voiceSupervisorToolParameters.get_thread_summary,
    },
    {
      name: "open_thread",
      description: "Navigate the local client to a thread by opaque handle or exact display name.",
      kind: "navigation",
      inputSchema: VoiceThreadReadToolArguments,
      parameters: voiceSupervisorToolParameters.open_thread,
    },
    {
      name: "start_thread",
      description:
        "Prepare a new coding thread for local confirmation using an opaque project handle.",
      kind: "mutation",
      inputSchema: VoiceStartThreadToolArguments,
      parameters: voiceSupervisorToolParameters.start_thread,
    },
    {
      name: "send_follow_up",
      description:
        "Prepare a thread follow-up for local confirmation using an opaque thread handle.",
      kind: "mutation",
      inputSchema: VoiceFollowUpToolArguments,
      parameters: voiceSupervisorToolParameters.send_follow_up,
    },
    {
      name: "interrupt_thread",
      description:
        "Prepare an active-turn interrupt for local confirmation using an opaque thread handle.",
      kind: "mutation",
      inputSchema: VoiceInterruptToolArguments,
      parameters: voiceSupervisorToolParameters.interrupt_thread,
    },
  ]);

const WorkspaceString = TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_PATH_CHARS));
const VoiceLocalWorkspace = Schema.Struct({
  mode: Schema.Literal("local"),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(WorkspaceString),
});
const VoiceWorktreeWorkspace = Schema.Struct({
  mode: Schema.Literal("worktree"),
  projectCwd: WorkspaceString,
  baseBranch: TrimmedNonEmptyString,
  worktreeBranch: TrimmedNonEmptyString,
  startFromOrigin: Schema.Boolean,
});
const VoiceWorkspace = Schema.Union([VoiceLocalWorkspace, VoiceWorktreeWorkspace]);

const VoiceStartMutation = Schema.Struct({
  kind: Schema.Literal("start_thread"),
  spec: Schema.Struct({
    commandId: CommandId,
    messageId: MessageId,
    createdAt: IsoDateTime,
    projectId: ProjectId,
    threadId: ThreadId,
    title: VoiceTitle,
    titleSeed: VoiceTitle,
    text: VoiceInstruction,
    modelSelection: ModelSelection,
    runtimeMode: RuntimeMode,
    interactionMode: ProviderInteractionMode,
    workspace: VoiceWorkspace,
  }),
});

const VoiceFollowUpMutation = Schema.Struct({
  kind: Schema.Literal("send_follow_up"),
  spec: Schema.Struct({
    commandId: CommandId,
    messageId: MessageId,
    createdAt: IsoDateTime,
    text: VoiceInstruction,
    thread: Schema.Struct({
      id: ThreadId,
      projectId: ProjectId,
      title: TrimmedNonEmptyString,
      modelSelection: ModelSelection,
      runtimeMode: RuntimeMode,
      interactionMode: ProviderInteractionMode,
    }),
  }),
});

const VoiceInterruptMutation = Schema.Struct({
  kind: Schema.Literal("interrupt_thread"),
  projectId: ProjectId,
  command: Schema.Struct({
    commandId: CommandId,
    createdAt: IsoDateTime,
    threadId: ThreadId,
    turnId: Schema.optionalKey(TurnId),
  }),
});

const VoiceMutation = Schema.Union([
  VoiceStartMutation,
  VoiceFollowUpMutation,
  VoiceInterruptMutation,
]);

type MaybePromise<T> = T | Promise<T>;

export interface VoiceSupervisorProjectRecord {
  readonly project: EnvironmentProject;
  readonly displayLabel: string;
  readonly version: SupervisorTargetVersion;
  readonly availability: SupervisorTargetCandidate["availability"];
  readonly aliases?: ReadonlyArray<string>;
}

export interface VoiceSupervisorThreadRecord {
  readonly thread: EnvironmentThreadShell;
  readonly displayLabel: string;
  readonly version: SupervisorTargetVersion;
  readonly availability: SupervisorTargetCandidate["availability"];
  readonly aliases?: ReadonlyArray<string>;
}

export interface VoiceStartThreadPreparation extends ThreadTaskCommandMetadata {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly titleSeed: string;
  readonly modelSelection: Schema.Schema.Type<typeof ModelSelection>;
  readonly runtimeMode: Schema.Schema.Type<typeof RuntimeMode>;
  readonly interactionMode: Schema.Schema.Type<typeof ProviderInteractionMode>;
  readonly workspace: ProjectTaskWorkspace;
}

export interface VoiceInterruptPreparation {
  readonly commandId: CommandId;
  readonly createdAt: Schema.Schema.Type<typeof IsoDateTime>;
}

export interface VoiceCommandReceipt {
  readonly status: "accepted" | "completed";
}

export interface VoiceSupervisorRepository {
  readonly listProjects: () => MaybePromise<ReadonlyArray<VoiceSupervisorProjectRecord>>;
  readonly listThreads: () => MaybePromise<ReadonlyArray<VoiceSupervisorThreadRecord>>;
  readonly getProject: (
    environmentId: EnvironmentId,
    projectId: ProjectId,
  ) => MaybePromise<VoiceSupervisorProjectRecord | null>;
  readonly getThread: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) => MaybePromise<VoiceSupervisorThreadRecord | null>;
  readonly prepareStartThread: (input: {
    readonly project: VoiceSupervisorProjectRecord;
    readonly instruction: string;
    readonly requestedTitle?: string;
  }) => MaybePromise<VoiceStartThreadPreparation>;
  readonly prepareFollowUp: (input: {
    readonly thread: VoiceSupervisorThreadRecord;
    readonly instruction: string;
  }) => MaybePromise<ThreadTaskCommandMetadata>;
  readonly prepareInterrupt: (input: {
    readonly thread: VoiceSupervisorThreadRecord;
  }) => MaybePromise<VoiceInterruptPreparation>;
  readonly openThread: (thread: VoiceSupervisorThreadRecord) => MaybePromise<void>;
  readonly startThreadTurn: (input: {
    readonly environmentId: EnvironmentId;
    readonly command: BuiltStartProjectTaskInput | BuiltFollowUpThreadInput;
  }) => Promise<VoiceCommandReceipt>;
  readonly interruptThreadTurn: (input: {
    readonly environmentId: EnvironmentId;
    readonly command: BuiltInterruptThreadInput;
  }) => Promise<VoiceCommandReceipt>;
}

export interface VoiceModelTarget {
  readonly handle: SupervisorTargetHandle;
  readonly label: string;
  readonly availability: SupervisorTargetAvailability;
}

export interface VoiceModelProposal {
  readonly handle: SupervisorProposalHandle;
  readonly action: string;
  readonly summary: string;
  readonly target: VoiceModelTarget;
  readonly expiresAtEpochMs: number;
}

export type VoiceToolInvocationFailure =
  | { readonly status: "invalid-arguments" }
  | { readonly status: "call-id-conflict" }
  | { readonly status: "capacity-exceeded"; readonly resource: "calls" }
  | { readonly status: "unavailable" };

export type VoicePublicationFailure =
  | {
      readonly status:
        | "invalid-call-id"
        | "invalid-limit"
        | "invalid-opaque-id"
        | "invalid-target-set";
    }
  | { readonly status: "capacity-exceeded"; readonly resource: "calls" | "targets" }
  | { readonly status: "call-id-conflict" };

export type VoiceProjectListItem = VoiceModelTarget;

export interface VoiceThreadListItem extends VoiceModelTarget {
  readonly status: ThreadOperationalStatus;
}

export interface VoiceBoundedListResult<Item> {
  readonly status: "ok";
  readonly items: ReadonlyArray<Item>;
  readonly totalCount: number;
  readonly omittedCount: number;
  readonly truncated: boolean;
}

export type VoiceProjectListResult =
  | VoiceToolInvocationFailure
  | VoicePublicationFailure
  | VoiceBoundedListResult<VoiceProjectListItem>;

export type VoiceThreadListResult =
  | VoiceToolInvocationFailure
  | VoicePublicationFailure
  | VoiceBoundedListResult<VoiceThreadListItem>;

export type VoiceTargetResolutionFailure =
  | {
      readonly status: "ambiguous" | "candidates";
      readonly candidates: ReadonlyArray<VoiceModelTarget>;
    }
  | { readonly status: "not-found" | "expired" };

export interface VoiceThreadSummary {
  readonly handle: SupervisorTargetHandle;
  readonly label: string;
  readonly availability: SupervisorTargetAvailability;
  readonly operationalStatus: ThreadOperationalStatus;
  readonly currentStep?: string;
}

export type VoiceThreadSummaryResult =
  | VoiceToolInvocationFailure
  | VoiceTargetResolutionFailure
  | { readonly status: "target-rejected"; readonly reason: SupervisorExecutionRejectionReason }
  | { readonly status: "ok"; readonly thread: VoiceThreadSummary };

export type VoiceOpenThreadResult =
  | VoiceToolInvocationFailure
  | VoiceTargetResolutionFailure
  | { readonly status: "target-rejected"; readonly reason: SupervisorExecutionRejectionReason }
  | {
      readonly status: "opened";
      readonly thread: Pick<VoiceThreadSummary, "handle" | "label">;
    };

export type VoiceMutationResult =
  | VoiceToolInvocationFailure
  | {
      readonly status: "proposed";
      readonly proposal: VoiceModelProposal;
      readonly replacedProposalHandle?: SupervisorProposalHandle;
    }
  | { readonly status: "pending-proposal"; readonly proposal: VoiceModelProposal }
  | {
      readonly status:
        | "not-found"
        | "target-expired"
        | "proposal-expired"
        | "invalid-call-id"
        | "invalid-opaque-id"
        | "replacement-mismatch"
        | "preparation-invalid";
    }
  | {
      readonly status: "target-unavailable";
      readonly availability: Exclude<SupervisorTargetAvailability, "live">;
    }
  | {
      readonly status: "invalid-snapshot";
      readonly field: "mutation" | "preview";
      readonly reason: SupervisorJsonSnapshotFailureReason;
    }
  | { readonly status: "capacity-exceeded"; readonly resource: "calls" | "proposals" };

export interface VoiceToolResultMap {
  readonly list_active_work: VoiceThreadListResult;
  readonly list_projects: VoiceProjectListResult;
  readonly list_threads: VoiceThreadListResult;
  readonly get_thread_summary: VoiceThreadSummaryResult;
  readonly open_thread: VoiceOpenThreadResult;
  readonly start_thread: VoiceMutationResult;
  readonly send_follow_up: VoiceMutationResult;
  readonly interrupt_thread: VoiceMutationResult;
}

export type VoiceKnownToolResult = VoiceToolResultMap[VoiceSupervisorToolName];
export type VoiceToolResult = VoiceKnownToolResult | { readonly status: "unknown-tool" };

export interface VoiceToolsController {
  readonly definitions: ReadonlyArray<VoiceSupervisorToolDefinition>;
  readonly invoke: {
    <Name extends VoiceSupervisorToolName>(
      name: Name,
      input: unknown,
    ): Promise<VoiceToolResultMap[Name]>;
    (name: string, input: unknown): Promise<VoiceToolResult>;
  };
  readonly getConfirmationPayloadLocally: ThreadSupervisorCore["getConfirmationPayloadLocally"];
  readonly cancelProposalLocally: ThreadSupervisorCore["cancelProposalLocally"];
  readonly confirmProposalLocally: (
    handle: SupervisorProposalHandle,
  ) => Promise<SupervisorConfirmedMutationResult>;
}

export interface CreateVoiceToolsControllerOptions {
  readonly core: ThreadSupervisorCore;
  readonly repository: VoiceSupervisorRepository;
  readonly maxToolCalls?: number;
}

type StoredToolCall =
  | { readonly kind: "tombstone" }
  | {
      readonly kind: "result";
      readonly signature: string;
      readonly result: Promise<VoiceKnownToolResult>;
    };

type ProjectRevalidation =
  | { readonly status: "live"; readonly record: VoiceSupervisorProjectRecord }
  | { readonly status: "rejected"; readonly reason: SupervisorExecutionRejectionReason };

type ThreadRevalidation =
  | { readonly status: "live"; readonly record: VoiceSupervisorThreadRecord }
  | { readonly status: "rejected"; readonly reason: SupervisorExecutionRejectionReason };

function decodeStrict<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  input: unknown,
): S["Type"] | null {
  try {
    const decoded = Schema.decodeUnknownResult(schema, { onExcessProperty: "error" })(input);
    return Result.isSuccess(decoded) ? decoded.success : null;
  } catch {
    return null;
  }
}

function extractOwnDataCallId(input: unknown): string | null {
  if (input === null || (typeof input !== "object" && typeof input !== "function")) return null;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(input, "call_id");
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable ||
      typeof descriptor.value !== "string"
    ) {
      return null;
    }
    const callId = descriptor.value;
    return callId.length > 0 &&
      callId.length <= MAX_VOICE_TOOL_CALL_ID_CHARS &&
      callId.trim() === callId
      ? callId
      : null;
  } catch {
    return null;
  }
}

function copyOwnDataToolInput(
  input: unknown,
  expectedCallId: string,
): Readonly<Record<string, unknown>> | null {
  if (input === null || (typeof input !== "object" && typeof input !== "function")) return null;
  try {
    const keys = Reflect.ownKeys(input);
    if (keys.length > 8) return null;
    const copy: Record<string, unknown> = Object.create(null);
    let copiedExpectedCallId = false;
    for (const key of keys) {
      if (typeof key !== "string" || UNSAFE_TOOL_ARGUMENT_KEYS.has(key)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        return null;
      }
      if (key === "call_id") {
        if (descriptor.value !== expectedCallId) return null;
        copiedExpectedCallId = true;
      }
      Object.defineProperty(copy, key, {
        value: descriptor.value,
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
    return copiedExpectedCallId ? Object.freeze(copy) : null;
  } catch {
    return null;
  }
}

function requireStableVoiceResult<ResultType extends VoiceToolResult>(
  result: ResultType,
): ResultType {
  const snapshot = createSupervisorJsonSnapshot(result, VOICE_RESULT_SNAPSHOT_BOUNDS);
  if (snapshot.status === "rejected") {
    throw new Error("Static voice tool result exceeded its JSON snapshot bounds.");
  }
  return snapshot.value as ResultType;
}

const INVALID_ARGUMENTS_RESULT = requireStableVoiceResult({ status: "invalid-arguments" } as const);
const CALL_ID_CONFLICT_RESULT = requireStableVoiceResult({ status: "call-id-conflict" } as const);
const CALL_CAPACITY_RESULT = requireStableVoiceResult({
  status: "capacity-exceeded",
  resource: "calls",
} as const);
const UNAVAILABLE_RESULT = requireStableVoiceResult({ status: "unavailable" } as const);
const UNKNOWN_TOOL_RESULT = requireStableVoiceResult({ status: "unknown-tool" } as const);

function snapshotVoiceKnownToolResult(result: VoiceKnownToolResult): VoiceKnownToolResult {
  const snapshot = createSupervisorJsonSnapshot(result, VOICE_RESULT_SNAPSHOT_BOUNDS);
  if (
    snapshot.status === "rejected" ||
    snapshot.value === null ||
    typeof snapshot.value !== "object" ||
    Array.isArray(snapshot.value)
  ) {
    return UNAVAILABLE_RESULT;
  }
  return snapshot.value as VoiceKnownToolResult;
}

function assertNever(value: never): never {
  return value;
}

function uniqueProjects(
  records: ReadonlyArray<VoiceSupervisorProjectRecord>,
): ReadonlyArray<VoiceSupervisorProjectRecord> {
  const unique = new Map<string, VoiceSupervisorProjectRecord>();
  for (const record of records) {
    const key = JSON.stringify([record.project.environmentId, record.project.id, record.version]);
    if (!unique.has(key)) unique.set(key, record);
  }
  return [...unique.values()];
}

function uniqueThreads(
  records: ReadonlyArray<VoiceSupervisorThreadRecord>,
): ReadonlyArray<VoiceSupervisorThreadRecord> {
  const unique = new Map<string, VoiceSupervisorThreadRecord>();
  for (const record of records) {
    const key = JSON.stringify([
      record.thread.environmentId,
      record.thread.projectId,
      record.thread.id,
      record.version,
    ]);
    if (!unique.has(key)) unique.set(key, record);
  }
  return [...unique.values()];
}

function projectCandidate(record: VoiceSupervisorProjectRecord): SupervisorTargetCandidate {
  return {
    binding: {
      kind: "project",
      environmentId: record.project.environmentId,
      projectId: record.project.id,
      version: record.version,
    },
    label: record.displayLabel,
    ...(record.aliases === undefined ? {} : { aliases: record.aliases }),
    availability: record.availability,
  };
}

function threadCandidate(record: VoiceSupervisorThreadRecord): SupervisorTargetCandidate {
  return {
    binding: {
      kind: "thread",
      environmentId: record.thread.environmentId,
      projectId: record.thread.projectId,
      threadId: record.thread.id,
      version: record.version,
    },
    label: record.displayLabel,
    ...(record.aliases === undefined ? {} : { aliases: record.aliases }),
    availability: record.availability,
  };
}

function modelTarget(target: {
  readonly handle: SupervisorTargetHandle;
  readonly label: string;
  readonly availability: SupervisorTargetAvailability;
}): VoiceModelTarget {
  return {
    handle: target.handle,
    label: target.label,
    availability: target.availability,
  };
}

function resolutionForModel(
  resolution: Exclude<SupervisorTargetResolution, { readonly status: "resolved" }>,
): VoiceTargetResolutionFailure {
  switch (resolution.status) {
    case "ambiguous":
    case "candidates":
      return {
        status: resolution.status,
        candidates: resolution.candidates.map(modelTarget),
      };
    case "not-found":
    case "expired":
      return { status: resolution.status };
  }
  return assertNever(resolution);
}

function modelProposal(result: {
  readonly handle: SupervisorProposalHandle;
  readonly action: string;
  readonly summary: string;
  readonly target: {
    readonly handle: SupervisorTargetHandle;
    readonly label: string;
    readonly availability: SupervisorTargetAvailability;
  };
  readonly expiresAtEpochMs: number;
}): VoiceModelProposal {
  return {
    handle: result.handle,
    action: result.action,
    summary: result.summary,
    target: modelTarget(result.target),
    expiresAtEpochMs: result.expiresAtEpochMs,
  };
}

function proposalForModel(result: SupervisorMutationProposalResult): VoiceMutationResult {
  switch (result.status) {
    case "proposed":
      return {
        status: "proposed",
        proposal: modelProposal(result.proposal),
        ...(result.replacedProposalHandle === undefined
          ? {}
          : { replacedProposalHandle: result.replacedProposalHandle }),
      };
    case "pending-proposal":
      return {
        status: "pending-proposal",
        proposal: modelProposal(result.proposal),
      };
    case "not-found":
    case "target-expired":
    case "proposal-expired":
    case "target-unavailable":
    case "invalid-snapshot":
    case "invalid-call-id":
    case "invalid-opaque-id":
    case "replacement-mismatch":
    case "capacity-exceeded":
    case "call-id-conflict":
      return result;
  }
  return assertNever(result);
}

function publicationFailureForModel(
  result: Exclude<PublishSupervisorTargetsResult, { readonly status: "published" }>,
): VoicePublicationFailure {
  switch (result.status) {
    case "invalid-call-id":
    case "invalid-limit":
    case "invalid-opaque-id":
    case "invalid-target-set":
    case "capacity-exceeded":
    case "call-id-conflict":
      return result;
  }
  return assertNever(result);
}

export function createVoiceToolsController(
  options: CreateVoiceToolsControllerOptions,
): VoiceToolsController {
  const { core, repository } = options;
  const maxToolCalls = options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  if (!Number.isSafeInteger(maxToolCalls) || maxToolCalls <= 0) {
    throw new Error("maxToolCalls must be a finite positive integer.");
  }
  const calls = new Map<string, StoredToolCall>();
  const projectsByHandle = new Map<string, VoiceSupervisorProjectRecord>();
  const threadsByHandle = new Map<string, VoiceSupervisorThreadRecord>();

  const invokeKnown = <S extends Schema.ConstraintDecoder<unknown>>(
    name: VoiceSupervisorToolName,
    schema: S,
    input: unknown,
    run: (args: S["Type"]) => Promise<VoiceKnownToolResult>,
  ): Promise<VoiceKnownToolResult> => {
    const callId = extractOwnDataCallId(input);
    if (callId === null) return Promise.resolve(INVALID_ARGUMENTS_RESULT);

    const existing = calls.get(callId);
    if (existing?.kind === "tombstone") {
      return Promise.resolve(CALL_ID_CONFLICT_RESULT);
    }

    const copiedInput = copyOwnDataToolInput(input, callId);
    const args = copiedInput === null ? null : decodeStrict(schema, copiedInput);
    if (args === null) {
      if (existing !== undefined) return Promise.resolve(CALL_ID_CONFLICT_RESULT);
      if (calls.size >= maxToolCalls) return Promise.resolve(CALL_CAPACITY_RESULT);
      calls.set(callId, { kind: "tombstone" });
      return Promise.resolve(INVALID_ARGUMENTS_RESULT);
    }

    const signature = JSON.stringify([name, args]);
    if (existing !== undefined) {
      return existing.signature === signature
        ? existing.result
        : Promise.resolve(CALL_ID_CONFLICT_RESULT);
    }
    if (calls.size >= maxToolCalls) {
      return Promise.resolve(CALL_CAPACITY_RESULT);
    }
    const result = Promise.resolve()
      .then(() => run(args))
      .then(snapshotVoiceKnownToolResult)
      .catch((): VoiceKnownToolResult => UNAVAILABLE_RESULT);
    calls.set(callId, { kind: "result", signature, result });
    return result;
  };

  const publishProjects = async (callId: string, limit: number | undefined) => {
    const records = uniqueProjects(await repository.listProjects());
    const published = core.publishTargets({
      callId,
      targetKind: "project",
      targets: records.map(projectCandidate),
      ...(limit === undefined ? {} : { requestedLimit: limit }),
    });
    if (published.status !== "published") return { published, records: [] } as const;
    for (let index = 0; index < published.result.items.length; index += 1) {
      const item = published.result.items[index];
      const record = records[index];
      if (item !== undefined && record !== undefined) projectsByHandle.set(item.handle, record);
    }
    return { published, records } as const;
  };

  const publishThreads = async (
    callId: string,
    limit: number | undefined,
    records: ReadonlyArray<VoiceSupervisorThreadRecord>,
  ) => {
    const unique = uniqueThreads(records);
    const published = core.publishTargets({
      callId,
      targetKind: "thread",
      targets: unique.map(threadCandidate),
      ...(limit === undefined ? {} : { requestedLimit: limit }),
    });
    if (published.status !== "published") return { published, records: [] } as const;
    for (let index = 0; index < published.result.items.length; index += 1) {
      const item = published.result.items[index];
      const record = unique[index];
      if (item !== undefined && record !== undefined) threadsByHandle.set(item.handle, record);
    }
    return { published, records: unique } as const;
  };

  const revalidateThread = async (
    record: VoiceSupervisorThreadRecord,
  ): Promise<ThreadRevalidation> => {
    const current = await repository.getThread(record.thread.environmentId, record.thread.id);
    if (
      current === null ||
      current.thread.environmentId !== record.thread.environmentId ||
      current.thread.projectId !== record.thread.projectId ||
      current.thread.id !== record.thread.id
    ) {
      return { status: "rejected", reason: "missing" };
    }
    if (current.availability !== "live") {
      return { status: "rejected", reason: current.availability };
    }
    return current.version === record.version
      ? { status: "live", record: current }
      : { status: "rejected", reason: "version-changed" };
  };

  const exactProjectRecord = (handle: string) => {
    const resolution = core.resolveTarget(handle, "project");
    if (resolution.status !== "resolved" || resolution.target.handle !== handle) return null;
    return projectsByHandle.get(resolution.target.handle) ?? null;
  };

  const exactThreadRecord = (handle: string) => {
    const resolution = core.resolveTarget(handle, "thread");
    if (resolution.status !== "resolved" || resolution.target.handle !== handle) return null;
    return threadsByHandle.get(resolution.target.handle) ?? null;
  };

  const listProjects = async (
    args: Schema.Schema.Type<typeof VoiceListToolArguments>,
  ): Promise<VoiceProjectListResult> => {
    const { published } = await publishProjects(args.call_id, args.limit);
    if (published.status !== "published") return publicationFailureForModel(published);
    return {
      status: "ok",
      items: published.result.items.map((item) => ({
        handle: item.handle,
        label: item.label,
        availability: item.availability,
      })),
      totalCount: published.result.totalCount,
      omittedCount: published.result.omittedCount,
      truncated: published.result.truncated,
    };
  };

  const listThreads = async (
    args: Schema.Schema.Type<typeof VoiceListToolArguments>,
    activeOnly: boolean,
  ): Promise<VoiceThreadListResult> => {
    const records = (await repository.listThreads()).filter((record) => {
      if (record.thread.archivedAt !== null) return false;
      return !activeOnly || resolveThreadOperationalStatus(record.thread) !== "ready";
    });
    const { published, records: publishedRecords } = await publishThreads(
      args.call_id,
      args.limit,
      records,
    );
    if (published.status !== "published") return publicationFailureForModel(published);
    return {
      status: "ok",
      items: published.result.items.map((item, index) => ({
        handle: item.handle,
        label: item.label,
        availability: item.availability,
        status:
          publishedRecords[index] === undefined
            ? "ready"
            : resolveThreadOperationalStatus(publishedRecords[index].thread),
      })),
      totalCount: published.result.totalCount,
      omittedCount: published.result.omittedCount,
      truncated: published.result.truncated,
    };
  };

  const getThreadSummary = async (
    args: Schema.Schema.Type<typeof VoiceThreadReadToolArguments>,
  ): Promise<VoiceThreadSummaryResult> => {
    const resolution = core.resolveTarget(args.thread, "thread");
    if (resolution.status !== "resolved") return resolutionForModel(resolution);
    const stored = threadsByHandle.get(resolution.target.handle);
    if (stored === undefined) return { status: "not-found" };
    const current = await revalidateThread(stored);
    if (current.status === "rejected") {
      return { status: "target-rejected", reason: current.reason };
    }
    const step = current.record.thread.planProgress?.step;
    return {
      status: "ok",
      thread: {
        handle: resolution.target.handle,
        label: resolution.target.label,
        availability: current.record.availability,
        operationalStatus: resolveThreadOperationalStatus(current.record.thread),
        ...(step === undefined
          ? {}
          : { currentStep: boundSupervisorText(step, MAX_SUMMARY_TEXT_CHARS) }),
      },
    };
  };

  const openThread = async (
    args: Schema.Schema.Type<typeof VoiceThreadReadToolArguments>,
  ): Promise<VoiceOpenThreadResult> => {
    const resolution = core.resolveTarget(args.thread, "thread");
    if (resolution.status !== "resolved") return resolutionForModel(resolution);
    const stored = threadsByHandle.get(resolution.target.handle);
    if (stored === undefined) return { status: "not-found" };
    const current = await revalidateThread(stored);
    if (current.status === "rejected") {
      return { status: "target-rejected", reason: current.reason };
    }
    await repository.openThread(current.record);
    return {
      status: "opened",
      thread: { handle: resolution.target.handle, label: resolution.target.label },
    };
  };

  const startThread = async (
    args: Schema.Schema.Type<typeof VoiceStartThreadToolArguments>,
  ): Promise<VoiceMutationResult> => {
    const project = exactProjectRecord(args.project_handle);
    if (project === null) return { status: "not-found" };
    const preparation = await repository.prepareStartThread({
      project,
      instruction: args.instruction,
      ...(args.title === undefined ? {} : { requestedTitle: args.title }),
    });
    const mutation = decodeStrict(VoiceStartMutation, {
      kind: "start_thread",
      spec: {
        ...preparation,
        projectId: project.project.id,
        text: args.instruction,
      },
    });
    if (mutation === null) return { status: "preparation-invalid" };
    return proposalForModel(
      core.proposeMutation({
        callId: args.call_id,
        targetHandle: args.project_handle,
        expectedTargetKind: "project",
        action: "Start thread",
        summary: `Start ${preparation.title} in ${project.displayLabel}`,
        mutation,
        preview: {
          operation: "start_thread",
          instruction: args.instruction,
          target: project.displayLabel,
          title: preparation.title,
          model: preparation.modelSelection.model,
          runtimeMode: preparation.runtimeMode,
          interactionMode: preparation.interactionMode,
          workspace:
            preparation.workspace.mode === "worktree"
              ? {
                  mode: "worktree",
                  baseBranch: preparation.workspace.baseBranch,
                  startFromOrigin: preparation.workspace.startFromOrigin,
                  runSetupScript: true,
                }
              : {
                  mode: "local",
                  branch: preparation.workspace.branch,
                  hasWorktreePath: preparation.workspace.worktreePath !== null,
                  runSetupScript: false,
                },
        },
      }),
    );
  };

  const sendFollowUp = async (
    args: Schema.Schema.Type<typeof VoiceFollowUpToolArguments>,
  ): Promise<VoiceMutationResult> => {
    const thread = exactThreadRecord(args.thread_handle);
    if (thread === null) return { status: "not-found" };
    const metadata = await repository.prepareFollowUp({ thread, instruction: args.instruction });
    const mutation = decodeStrict(VoiceFollowUpMutation, {
      kind: "send_follow_up",
      spec: {
        ...metadata,
        text: args.instruction,
        thread: {
          id: thread.thread.id,
          projectId: thread.thread.projectId,
          title: thread.thread.title,
          modelSelection: thread.thread.modelSelection,
          runtimeMode: thread.thread.runtimeMode,
          interactionMode: thread.thread.interactionMode,
        },
      },
    });
    if (mutation === null) return { status: "preparation-invalid" };
    return proposalForModel(
      core.proposeMutation({
        callId: args.call_id,
        targetHandle: args.thread_handle,
        expectedTargetKind: "thread",
        action: "Send follow-up",
        summary: `Follow up ${thread.displayLabel}`,
        mutation,
        preview: {
          operation: "send_follow_up",
          instruction: args.instruction,
          target: thread.displayLabel,
          model: thread.thread.modelSelection.model,
        },
      }),
    );
  };

  const interruptThread = async (
    args: Schema.Schema.Type<typeof VoiceInterruptToolArguments>,
  ): Promise<VoiceMutationResult> => {
    const thread = exactThreadRecord(args.thread_handle);
    if (thread === null) return { status: "not-found" };
    const metadata = await repository.prepareInterrupt({ thread });
    const command = buildThreadTurnInterruptInput({
      ...metadata,
      thread: thread.thread,
    });
    const mutation = decodeStrict(VoiceInterruptMutation, {
      kind: "interrupt_thread",
      projectId: thread.thread.projectId,
      command,
    });
    if (mutation === null) return { status: "preparation-invalid" };
    return proposalForModel(
      core.proposeMutation({
        callId: args.call_id,
        targetHandle: args.thread_handle,
        expectedTargetKind: "thread",
        action: "Interrupt thread",
        summary: `Interrupt ${thread.displayLabel}`,
        mutation,
        preview: {
          operation: "interrupt_thread",
          target: thread.displayLabel,
          hasActiveTurn: (thread.thread.session?.activeTurnId ?? null) !== null,
        },
      }),
    );
  };

  const revalidateTarget = async (
    target: SupervisorTargetBinding,
  ): Promise<ProjectRevalidation | ThreadRevalidation> => {
    if (target.kind === "project") {
      const current = await repository.getProject(target.environmentId, target.projectId);
      if (
        current === null ||
        current.project.environmentId !== target.environmentId ||
        current.project.id !== target.projectId
      ) {
        return { status: "rejected", reason: "missing" };
      }
      if (current.availability !== "live") {
        return { status: "rejected", reason: current.availability };
      }
      return current.version === target.version
        ? { status: "live", record: current }
        : { status: "rejected", reason: "version-changed" };
    }
    const current = await repository.getThread(target.environmentId, target.threadId);
    if (
      current === null ||
      current.thread.projectId !== target.projectId ||
      current.thread.environmentId !== target.environmentId ||
      current.thread.id !== target.threadId
    ) {
      return { status: "rejected", reason: "missing" };
    }
    if (current.availability !== "live") {
      return { status: "rejected", reason: current.availability };
    }
    return current.version === target.version
      ? { status: "live", record: current }
      : { status: "rejected", reason: "version-changed" };
  };

  const executeConfirmed = async (input: {
    readonly target: SupervisorTargetBinding;
    readonly mutation: Schema.Json;
  }) => {
    const current = await revalidateTarget(input.target);
    if (current.status === "rejected") {
      return { status: "rejected" as const, reason: current.reason };
    }
    const mutation = decodeStrict(VoiceMutation, input.mutation);
    if (mutation === null) throw new Error("Invalid frozen voice mutation.");
    if (mutation.kind === "start_thread") {
      if (input.target.kind !== "project" || mutation.spec.projectId !== input.target.projectId) {
        throw new Error("Voice start target mismatch.");
      }
      const command = buildStartProjectTaskInput({ ...mutation.spec, attachments: [] });
      const receipt = await repository.startThreadTurn({
        environmentId: input.target.environmentId,
        command,
      });
      return {
        status: "executed" as const,
        value: { operation: mutation.kind, receipt: receipt.status },
      };
    }
    if (input.target.kind !== "thread") {
      throw new Error("Voice thread target mismatch.");
    }
    if (mutation.kind === "send_follow_up") {
      if (
        mutation.spec.thread.projectId !== input.target.projectId ||
        mutation.spec.thread.id !== input.target.threadId
      ) {
        throw new Error("Voice follow-up target mismatch.");
      }
      const command = buildFollowUpThreadInput({
        commandId: mutation.spec.commandId,
        messageId: mutation.spec.messageId,
        createdAt: mutation.spec.createdAt,
        text: mutation.spec.text,
        attachments: [],
        thread: mutation.spec.thread,
      });
      const receipt = await repository.startThreadTurn({
        environmentId: input.target.environmentId,
        command,
      });
      return {
        status: "executed" as const,
        value: { operation: mutation.kind, receipt: receipt.status },
      };
    }
    if (
      mutation.projectId !== input.target.projectId ||
      mutation.command.threadId !== input.target.threadId
    ) {
      throw new Error("Voice interrupt target mismatch.");
    }
    const receipt = await repository.interruptThreadTurn({
      environmentId: input.target.environmentId,
      command: mutation.command,
    });
    return {
      status: "executed" as const,
      value: { operation: mutation.kind, receipt: receipt.status },
    };
  };

  function invoke<Name extends VoiceSupervisorToolName>(
    name: Name,
    input: unknown,
  ): Promise<VoiceToolResultMap[Name]>;
  function invoke(name: string, input: unknown): Promise<VoiceToolResult>;
  async function invoke(name: string, input: unknown): Promise<VoiceToolResult> {
    if (name === "list_active_work" || name === "list_projects" || name === "list_threads") {
      return invokeKnown(name, VoiceListToolArguments, input, (args) =>
        name === "list_projects"
          ? listProjects(args)
          : listThreads(args, name === "list_active_work"),
      );
    }
    if (name === "get_thread_summary" || name === "open_thread") {
      return invokeKnown(name, VoiceThreadReadToolArguments, input, (args) =>
        name === "get_thread_summary" ? getThreadSummary(args) : openThread(args),
      );
    }
    if (name === "start_thread") {
      return invokeKnown(name, VoiceStartThreadToolArguments, input, startThread);
    }
    if (name === "send_follow_up") {
      return invokeKnown(name, VoiceFollowUpToolArguments, input, sendFollowUp);
    }
    if (name === "interrupt_thread") {
      return invokeKnown(name, VoiceInterruptToolArguments, input, interruptThread);
    }
    return UNKNOWN_TOOL_RESULT;
  }

  return {
    definitions: voiceSupervisorToolDefinitions,
    invoke,
    getConfirmationPayloadLocally: core.getConfirmationPayloadLocally,
    cancelProposalLocally: core.cancelProposalLocally,
    confirmProposalLocally: (handle) => core.confirmProposalLocally(handle, { executeConfirmed }),
  };
}
