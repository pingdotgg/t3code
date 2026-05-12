import type { TaskIntakeMessage } from "./contracts.ts";

function sourceLabel(source: TaskIntakeMessage["source"]) {
  switch (source) {
    case "linear":
      return "Linear";
    case "slack":
      return "Slack";
    case "support_email":
      return "support email";
    case "webhook":
      return "webhook";
  }
}

export function buildTaskIntakeTitle(message: TaskIntakeMessage): string {
  const trimmedText = message.text.trim().replace(/\s+/g, " ");
  if (trimmedText.length > 0) {
    return trimmedText.length > 80 ? `${trimmedText.slice(0, 77)}...` : trimmedText;
  }

  return `${sourceLabel(message.source)} task request`;
}

function buildTaskIntakeRelayPrompt(message: TaskIntakeMessage): string {
  const text = message.text.trim();
  const attachmentLines =
    message.attachments
      ?.map((attachment, index) => {
        const label = attachment.name?.trim() || `Attachment ${index + 1}`;
        return `${label}: ${attachment.url}`;
      })
      .filter((line) => line.length > 0) ?? [];

  if (attachmentLines.length === 0) {
    return text.length > 0 ? text : "(empty message body)";
  }

  return [text.length > 0 ? text : "(empty message body)", "", ...attachmentLines].join("\n");
}

export function buildTaskIntakeInitialPrompt(message: TaskIntakeMessage): string {
  return buildTaskIntakeRelayPrompt(message);
}

export function buildTaskIntakeFollowUpPrompt(message: TaskIntakeMessage): string {
  return buildTaskIntakeRelayPrompt(message);
}
