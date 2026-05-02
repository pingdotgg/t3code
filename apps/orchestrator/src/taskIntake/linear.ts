import type { TaskIntakeMessage } from "./contracts.ts";
import type { LinearIngressEnvelope } from "../linear/ingress.ts";

export function linearIngressToTaskIntakeMessage(
  envelope: LinearIngressEnvelope,
): TaskIntakeMessage {
  const receivedAt = new Date(envelope.receivedAt).toISOString();
  const externalId = envelope.issueId;

  return {
    eventId: envelope.eventId,
    source: "linear",
    conversation: {
      source: "linear",
      externalLinkKind: "linear_issue",
      externalId,
      issueId: envelope.issueId,
      ...(envelope.commentId !== undefined ? { commentId: envelope.commentId } : {}),
      ...(envelope.teamId !== undefined ? { teamId: envelope.teamId } : {}),
      ...(envelope.commentUrl !== undefined ? { url: envelope.commentUrl } : {}),
    },
    messageId: envelope.messageId ?? envelope.eventId,
    text: envelope.body,
    receivedAt,
    ...(envelope.commentUrl !== undefined ? { url: envelope.commentUrl } : {}),
    ...(envelope.authorName !== undefined
      ? {
          actor: {
            displayName: envelope.authorName,
          },
        }
      : {}),
  };
}
