import {
  type MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2PlanArtifact,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const MAX_INITIAL_MESSAGES = 6;
const MAX_DELTA_MESSAGES = 4;
const MAX_MESSAGE_CHARS = 600;
const MAX_MATERIAL_CHARS = 4_000;
const MAX_STATE_CHARS = 1_200;
const MAX_CHANGED_FILES = 5;

export interface ThreadRecapSourceInput {
  readonly thread: Pick<OrchestrationV2AppThread, "id" | "title">;
  readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly runtimeRequests: ReadonlyArray<OrchestrationV2RuntimeRequest>;
  readonly plans: ReadonlyArray<OrchestrationV2PlanArtifact>;
  readonly checkpoints: ReadonlyArray<OrchestrationV2Checkpoint>;
  readonly previousCoveredMessageId: MessageId | null;
  readonly hasPreviousRecap: boolean;
}

export interface ThreadRecapSource {
  readonly isSettled: boolean;
  readonly hasNewMaterial: boolean;
  readonly latestMessageId: MessageId | null;
  readonly signature: string;
  readonly newMaterial: string;
  readonly currentState: string;
}

function compactText(value: string, maxChars: number): string {
  const compacted = value.replace(/\s+/gu, " ").trim();
  if (compacted.length <= maxChars) {
    return compacted;
  }
  const end = Math.max(0, maxChars - 15);
  const last = compacted.charCodeAt(end - 1);
  const safeEnd = last >= 0xd800 && last <= 0xdbff ? end - 1 : end;
  return `${compacted.slice(0, safeEnd).trimEnd()}... [truncated]`;
}

function limitText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const end = Math.max(0, maxChars - 15);
  const last = value.charCodeAt(end - 1);
  const safeEnd = last >= 0xd800 && last <= 0xdbff ? end - 1 : end;
  return `${value.slice(0, safeEnd).trimEnd()}\n[truncated]`;
}

function isRecappableMessage(message: OrchestrationV2ConversationMessage): boolean {
  return (
    (message.role === "user" || message.role === "assistant") &&
    !message.streaming &&
    message.workflowScript !== true &&
    message.text.trim().length > 0
  );
}

function formatMessage(message: OrchestrationV2ConversationMessage): string {
  const speaker = message.role === "user" ? "User" : "Assistant";
  const text = compactText(message.text, MAX_MESSAGE_CHARS);
  const attachments =
    message.attachments.length > 0
      ? ` [Attachments: ${message.attachments.map((attachment) => attachment.name).join(", ")}]`
      : "";
  return `${speaker}: ${text}${attachments}`;
}

function messageSignature(message: OrchestrationV2ConversationMessage): string {
  return [
    message.id,
    message.role,
    message.text.length,
    DateTime.formatIso(message.updatedAt),
  ].join(":");
}

function latestRunOf(runs: ReadonlyArray<OrchestrationV2Run>): OrchestrationV2Run | null {
  let latest: OrchestrationV2Run | null = null;
  for (const run of runs) {
    if (latest === null || run.ordinal >= latest.ordinal) {
      latest = run;
    }
  }
  return latest;
}

function buildCurrentState(input: {
  readonly latestRun: OrchestrationV2Run | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly hasActiveProposedPlan: boolean;
  readonly checkpoints: ReadonlyArray<OrchestrationV2Checkpoint>;
}): string {
  const lines: string[] = [];
  if (input.latestRun) {
    lines.push(`Latest turn: ${input.latestRun.status}`);
  }
  if (input.hasPendingApprovals) {
    lines.push("Pending: approval required");
  }
  if (input.hasPendingUserInput) {
    lines.push("Pending: user input required");
  }
  if (input.hasActiveProposedPlan) {
    lines.push("Pending: proposed plan awaiting decision");
  }

  let latestFiles: ReadonlyArray<string> = [];
  for (let index = input.checkpoints.length - 1; index >= 0; index -= 1) {
    const checkpoint = input.checkpoints[index];
    if (checkpoint && checkpoint.files.length > 0) {
      latestFiles = checkpoint.files.slice(0, MAX_CHANGED_FILES).map((file) => file.path);
      break;
    }
  }
  if (latestFiles.length > 0) {
    lines.push(`Latest changed files: ${latestFiles.join(", ")}`);
  }

  return limitText(lines.join("\n"), MAX_STATE_CHARS);
}

function isActiveRunStatus(status: OrchestrationV2Run["status"]): boolean {
  return (
    status === "queued" ||
    status === "preparing" ||
    status === "starting" ||
    status === "running" ||
    status === "waiting"
  );
}

export function deriveThreadRecapSource(input: ThreadRecapSourceInput): ThreadRecapSource {
  const hasStreamingMessage = input.messages.some(
    (message) => (message.role === "user" || message.role === "assistant") && message.streaming,
  );
  const hasActiveRun = input.runs.some((run) => isActiveRunStatus(run.status));
  const isSettled = !hasStreamingMessage && !hasActiveRun;

  const recappableMessages = input.messages.filter(isRecappableMessage);
  const latestMessage = recappableMessages.at(-1) ?? null;
  const latestMessageId = latestMessage?.id ?? null;

  const coveredIndex = input.previousCoveredMessageId
    ? recappableMessages.findIndex((message) => message.id === input.previousCoveredMessageId)
    : -1;
  const deltaMessages =
    coveredIndex >= 0 ? recappableMessages.slice(coveredIndex + 1) : recappableMessages;
  const selectedMessages = input.hasPreviousRecap
    ? deltaMessages.slice(-MAX_DELTA_MESSAGES)
    : recappableMessages.slice(-MAX_INITIAL_MESSAGES);
  const hasNewMaterial =
    selectedMessages.length > 0 && coveredIndex < recappableMessages.length - 1;

  const latestRun = latestRunOf(input.runs);
  const hasPendingApprovals = input.runtimeRequests.some(
    (request) =>
      request.status === "pending" &&
      request.kind !== "user_input" &&
      request.kind !== "dynamic_tool_call" &&
      request.kind !== "auth_refresh",
  );
  const hasPendingUserInput = input.runtimeRequests.some(
    (request) => request.status === "pending" && request.kind === "user_input",
  );
  const hasActiveProposedPlan = input.plans.some(
    (plan) => plan.kind === "proposed_plan" && plan.status === "active",
  );

  const signature = [
    input.thread.id,
    latestMessage ? messageSignature(latestMessage) : "empty",
    latestRun?.status ?? "no-run",
    hasPendingApprovals ? "approval" : "",
    hasPendingUserInput ? "input" : "",
    hasActiveProposedPlan ? "plan" : "",
  ].join("|");

  const newMaterial = limitText(
    [`Thread: ${input.thread.title}`, ...selectedMessages.map(formatMessage)].join("\n"),
    MAX_MATERIAL_CHARS,
  );

  return {
    isSettled,
    hasNewMaterial,
    latestMessageId,
    signature,
    newMaterial,
    currentState: buildCurrentState({
      latestRun,
      hasPendingApprovals,
      hasPendingUserInput,
      hasActiveProposedPlan,
      checkpoints: input.checkpoints,
    }),
  };
}
