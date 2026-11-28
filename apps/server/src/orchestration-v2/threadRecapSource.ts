import {
  type MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2PlanArtifact,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
} from "@t3tools/contracts";
import { limitSection } from "@t3tools/provider-core/server/textGenerationUtils";
import * as DateTime from "effect/DateTime";

import { isActiveRun } from "./ThreadManagementService.ts";

const MAX_INITIAL_MESSAGES = 6;
const MAX_DELTA_MESSAGES = 4;
const MAX_MESSAGE_CHARS = 600;
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
  const text = limitSection(message.text.replace(/\s+/gu, " ").trim(), MAX_MESSAGE_CHARS);
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
  return runs.reduce<OrchestrationV2Run | null>(
    (latest, run) => (latest === null || run.ordinal >= latest.ordinal ? run : latest),
    null,
  );
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

  const latestFiles = input.checkpoints.findLast(
    (checkpoint) => checkpoint.files.length > 0,
  )?.files;
  if (latestFiles) {
    const paths = latestFiles.slice(0, MAX_CHANGED_FILES).map((file) => file.path);
    lines.push(`Latest changed files: ${paths.join(", ")}`);
  }

  return lines.join("\n");
}

export function deriveThreadRecapSource(input: ThreadRecapSourceInput): ThreadRecapSource {
  const hasStreamingMessage = input.messages.some(
    (message) => (message.role === "user" || message.role === "assistant") && message.streaming,
  );
  const hasActiveRun = input.runs.some(isActiveRun);
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

  const newMaterial = [
    `Thread: ${input.thread.title}`,
    ...selectedMessages.map(formatMessage),
  ].join("\n");

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
