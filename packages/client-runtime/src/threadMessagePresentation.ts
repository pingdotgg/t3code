import { TurnId } from "@t3tools/contracts";

export function unkeyedResponseTurnId(messageId: string): TurnId {
  return TurnId.make(`unkeyed-response:${messageId}`);
}

export function isUnkeyedResponseTurnId(turnId: TurnId): boolean {
  return turnId.startsWith("unkeyed-response:");
}

export function unsettledTurnId(
  latestTurn: { turnId: TurnId; completedAt: string | null; state: string } | null,
  runningTurnId: TurnId | null = null,
): TurnId | null {
  if (runningTurnId !== null) return runningTurnId;
  if (!latestTurn) return null;
  return latestTurn.completedAt !== null && latestTurn.state !== "running"
    ? null
    : latestTurn.turnId;
}

export function reasoningDisplayKind(
  message: { id: string; text: string },
  hasSummary: boolean,
): "summary" | "raw" {
  if (isReasoningSummaryMessage(message)) {
    return "summary";
  }
  return hasSummary || message.text.length > 2_000 || message.text.split("\n", 26).length > 25
    ? "raw"
    : "summary";
}

export function isReasoningSummaryMessage(message: { id: string }): boolean {
  return message.id.startsWith("reasoning:summary:") || message.id.startsWith("assistant:");
}
