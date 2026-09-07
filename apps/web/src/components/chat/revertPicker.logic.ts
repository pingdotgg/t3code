import { type MessageId, type TurnId } from "@t3tools/contracts";

import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import { type TimelineEntry } from "../../session-logic";
import { type TurnDiffSummary } from "../../types";
import { buildRevertTurnCountByUserMessageId } from "./MessagesTimeline.logic";

const SNIPPET_MAX_CHARS = 72;

export interface RevertPickerOption {
  readonly messageId: MessageId;
  readonly turnLabel: number | null;
  readonly turnCount: number | null;
  readonly unavailableReason: "expired" | "pending" | null;
  readonly snippet: string;
  readonly createdAt: string;
  readonly filesChanged: number;
  readonly additions: number;
  readonly deletions: number;
}

function messageSnippet(text: string): string {
  const trimmed = assistantCitationsToPlainText(text).trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) return "(empty message)";
  return trimmed.length > SNIPPET_MAX_CHARS ? `${trimmed.slice(0, SNIPPET_MAX_CHARS)}…` : trimmed;
}

function discardedDiffstat(
  turnDiffSummaries: ReadonlyArray<TurnDiffSummary>,
  turnCount: number,
): { filesChanged: number; additions: number; deletions: number } {
  const paths = new Set<string>();
  let additions = 0;
  let deletions = 0;
  for (const summary of turnDiffSummaries) {
    if (summary.checkpointTurnCount <= turnCount) continue;
    for (const file of summary.files) {
      paths.add(file.path);
      additions += file.additions;
      deletions += file.deletions;
    }
  }
  return { filesChanged: paths.size, additions, deletions };
}

export interface ComposerRevertPicker {
  readonly options: ReadonlyArray<RevertPickerOption>;
  readonly blockedReason: string | null;
  readonly onHighlight: (option: RevertPickerOption | null) => void;
  readonly onRevert: (turnCount: number) => void;
}

export function deriveRevertPickerOptions(input: {
  supportsConversationRollback: boolean;
  timelineEntries: ReadonlyArray<TimelineEntry>;
  turnDiffSummaries: ReadonlyArray<TurnDiffSummary>;
  inferredCheckpointTurnCountByTurnId: Readonly<Record<string, number | undefined>>;
}): RevertPickerOption[] {
  if (!input.supportsConversationRollback) return [];

  const turnDiffSummaryByAssistantMessageId = new Map<MessageId, TurnDiffSummary>();
  const turnDiffSummaryByTurnId = new Map<TurnId, TurnDiffSummary>();
  for (const summary of input.turnDiffSummaries) {
    turnDiffSummaryByTurnId.set(summary.turnId, summary);
    if (summary.assistantMessageId) {
      turnDiffSummaryByAssistantMessageId.set(summary.assistantMessageId, summary);
    }
  }

  const revertTurnCountByUserMessageId = buildRevertTurnCountByUserMessageId({
    supportsConversationRollback: true,
    timelineEntries: input.timelineEntries,
    turnDiffSummaryByAssistantMessageId,
    turnDiffSummaryByTurnId,
    inferredCheckpointTurnCountByTurnId: input.inferredCheckpointTurnCountByTurnId,
  });

  const options: RevertPickerOption[] = [];
  let seenLiveCheckpoint = false;
  for (const entry of input.timelineEntries) {
    if (entry.kind !== "message" || entry.message.role !== "user") continue;
    const turnCount = revertTurnCountByUserMessageId.get(entry.message.id) ?? null;
    if (turnCount !== null) seenLiveCheckpoint = true;
    const diffstat =
      turnCount === null
        ? { filesChanged: 0, additions: 0, deletions: 0 }
        : discardedDiffstat(input.turnDiffSummaries, turnCount);
    options.push({
      messageId: entry.message.id,
      turnLabel: turnCount === null ? null : turnCount + 1,
      turnCount,
      unavailableReason: turnCount !== null ? null : seenLiveCheckpoint ? "pending" : "expired",
      snippet: messageSnippet(entry.message.text),
      createdAt: entry.message.createdAt,
      ...diffstat,
    });
  }
  return options.toReversed();
}
