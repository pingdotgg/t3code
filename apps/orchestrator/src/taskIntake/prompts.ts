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

export function buildTaskIntakeInitialPrompt(message: TaskIntakeMessage): string {
  const actorLabel =
    message.actor?.displayName?.trim() ||
    message.actor?.email?.trim() ||
    message.actor?.externalId?.trim() ||
    "Unknown actor";
  const conversationUrl = message.url ?? message.conversation.url;
  const text = message.text.trim();

  return [
    `A ${sourceLabel(message.source)} conversation triggered this T3 task.`,
    "",
    `Source: ${message.source}`,
    `Conversation external id: ${message.conversation.externalId}`,
    `Message id: ${message.messageId}`,
    `Actor: ${actorLabel}`,
    ...(conversationUrl !== undefined ? [`Conversation URL: ${conversationUrl}`] : []),
    ...(message.conversation.teamId !== undefined
      ? [`Team id: ${message.conversation.teamId}`]
      : []),
    ...(message.conversation.channelId !== undefined
      ? [`Channel id: ${message.conversation.channelId}`]
      : []),
    ...(message.conversation.issueId !== undefined
      ? [`Issue id: ${message.conversation.issueId}`]
      : []),
    ...(message.conversation.commentId !== undefined
      ? [`Thread/comment id: ${message.conversation.commentId}`]
      : []),
    "",
    "User request:",
    text.length > 0 ? text : "(empty message body)",
    "",
    "MVP operating notes:",
    "- Work only from the normalized message text and URLs above.",
    "- Do not assume hidden attachments or platform context are available unless linked in the message.",
    "- Leave a concise final summary in the T3 thread; intake sources receive only coarse lifecycle replies.",
  ].join("\n");
}
