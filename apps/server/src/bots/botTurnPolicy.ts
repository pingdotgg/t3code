import type { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import { isRuntimeModeAbove, type BotGrantSource, type BotProfile } from "@t3tools/contracts";

import { CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES } from "../provider/CodexDeveloperInstructions.ts";

type MessageSource = {
  readonly id: string;
  readonly createdBy: string;
  readonly creationSource: string;
  readonly scheduledTaskId?: string | undefined;
  readonly senderThreadId?: string | undefined;
  readonly linkedSender?: unknown;
};

export function botRunSource(message: MessageSource): BotGrantSource {
  if (message.id.startsWith("bot-work-turn:webhook:")) return "webhook";
  if (message.id.startsWith("bot-work-turn:scheduled:")) return "scheduled";
  if (message.scheduledTaskId !== undefined) {
    return message.id.startsWith(`scheduled-task-message:${message.scheduledTaskId}:webhook:`)
      ? "webhook"
      : "scheduled";
  }
  return message.createdBy === "user" &&
    (message.creationSource === "web" || message.creationSource === "mobile") &&
    message.senderThreadId === undefined &&
    message.linkedSender === undefined
    ? "direct"
    : "handoff";
}

export function botTurnPolicy(
  bot: BotProfile,
  policy: ProviderAdapterV2RuntimePolicy,
  message: MessageSource,
  crossProject = false,
): ProviderAdapterV2RuntimePolicy {
  const text = [
    `Bot profile: ${bot.name}`,
    bot.role && `Role: ${bot.role}`,
    bot.description && `Description: ${bot.description}`,
    bot.instructions,
  ]
    .filter(Boolean)
    .join("\n");
  const instructions: string[] = [];
  let chunk = "";
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES) {
      instructions.push(chunk);
      chunk = "";
      bytes = 0;
    }
    chunk += character;
    bytes += size;
  }
  if (chunk) instructions.push(chunk);
  const source = botRunSource(message);
  const mayWrite =
    source !== "direct" &&
    bot.access.writeSources.includes(source) &&
    !isRuntimeModeAbove("auto-accept-edits", policy.maxRuntimeMode);
  return {
    ...policy,
    runtimeMode: "approval-required",
    maxRuntimeMode: "approval-required",
    sandboxPolicy: mayWrite
      ? { type: "workspaceWrite", excludeSlashTmp: true, excludeTmpdirEnvVar: true }
      : { type: "readOnly" },
    approvalPolicy: source === "direct" ? "untrusted" : "never",
    botInstructions: instructions,
    ...(source === "webhook" || crossProject
      ? { botWorkspaceProfile: mayWrite ? "write" : "read" }
      : {}),
  };
}
