import { useLayoutEffect } from "react";
import type { RunId } from "@t3tools/contracts";
import type { TimelineEntry } from "../../session-logic";
import {
  timelineTurnFoldRunIdsByEntryId,
  type MessagesTimelineRow,
  type TimelineLatestRun,
} from "./MessagesTimeline.logic";
import type { ThreadFindPositionReader } from "./threadFind";
import { attachThreadFindTimeline } from "./threadFindStore";
import { readThreadFindPosition } from "./threadFindPosition";

/** Hands thread find how to read the find position of this timeline's viewport. */
export function useThreadFindPositionReader({
  threadKey,
  navigate,
  timelineViewportElement,
  findFoldRunIds,
  timelineEntries,
  latestRun,
  runningRunId,
  isWorking,
  runlessWorkActive,
  rows,
  contentInsetEndAdjustment,
}: {
  readonly threadKey: string;
  readonly navigate: () => void;
  readonly timelineViewportElement: HTMLDivElement | null;
  readonly findFoldRunIds: ReadonlyMap<string, RunId> | null;
  readonly timelineEntries: ReadonlyArray<TimelineEntry>;
  readonly latestRun: TimelineLatestRun | null;
  readonly runningRunId: RunId | null;
  readonly isWorking: boolean;
  readonly runlessWorkActive: boolean;
  readonly rows: MessagesTimelineRow[];
  readonly contentInsetEndAdjustment: number;
}) {
  // Layout effect so a find opened right after a thread switch reads this viewport.
  useLayoutEffect(() => {
    if (!timelineViewportElement) return;
    const read: ThreadFindPositionReader = (query) => {
      const foldRunIds =
        findFoldRunIds ??
        timelineTurnFoldRunIdsByEntryId({
          timelineEntries,
          latestRun,
          runningRunId,
          isWorking,
          runlessWorkActive,
        });
      const entryById = new Map(timelineEntries.map((entry) => [entry.id, entry]));
      return readThreadFindPosition(
        timelineViewportElement,
        query,
        (rowId) => {
          const rowIndex = rows.findIndex((row) => row.id === rowId);
          for (const row of rows.slice(Math.max(0, rowIndex))) {
            if (row.kind !== "turn-fold" && row.kind !== "attempt-fold") {
              const entry = entryById.get(row.kind === "assistant-meta" ? row.message.id : row.id);
              if (entry && (entry.kind === "message" || entry.kind === "proposed-plan"))
                return entry.id;
              continue;
            }
            const entry = timelineEntries.find((entry) => {
              const runId =
                row.kind === "turn-fold"
                  ? foldRunIds.get(entry.id)
                  : entry.kind === "message"
                    ? entry.message.runId
                    : entry.kind === "proposed-plan"
                      ? entry.proposedPlan.runId
                      : null;
              return (
                runId === row.runId &&
                (entry.kind !== "message" || entry.message.role === "assistant") &&
                (row.kind !== "attempt-fold" || entry.attempt?.id === row.attemptId)
              );
            });
            if (entry && (entry.kind === "message" || entry.kind === "proposed-plan"))
              return entry.id;
          }
          return undefined;
        },
        contentInsetEndAdjustment,
      );
    };
    return attachThreadFindTimeline({ threadKey, readPosition: read, navigate });
  }, [
    contentInsetEndAdjustment,
    findFoldRunIds,
    isWorking,
    navigate,
    threadKey,
    latestRun,
    rows,
    runlessWorkActive,
    runningRunId,
    timelineEntries,
    timelineViewportElement,
  ]);
}
