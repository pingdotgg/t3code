import type { OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { v2Projection, v2ThreadId } from "./orchestrationV2TestFixtures.ts";
import {
  applyHistoryPageMeta,
  clearActiveHistoryLoading,
  isActiveHistoryRequestCursor,
  mergeOlderHistoryIntoProjection,
  shouldShowLoadEarlierControl,
} from "./threadHistoryMerge.ts";
import { applyOrchestrationV2ProjectionEvent } from "./orchestrationV2Projection.ts";

const NOW = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");

function row(index: number): OrchestrationV2ProjectedTurnItem {
  const id = `item-${index}` as never;
  return {
    position: index,
    visibility: "local",
    sourceThreadId: v2ThreadId,
    sourceItemId: id,
    item: {
      id,
      type: "command_execution",
      threadId: v2ThreadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: index + 1,
      status: "completed",
      title: `Command ${index}`,
      input: `cmd-${index}`,
      output: `out-${index}`,
      exitCode: 0,
      startedAt: NOW,
      completedAt: NOW,
      updatedAt: NOW,
    },
  };
}

describe("threadHistoryMerge", () => {
  it("prepends older rows and dedupes by source identity", () => {
    const recent = [row(2), row(3)];
    const projection = {
      ...v2Projection,
      turnItems: recent.map((entry) => entry.item),
      visibleTurnItems: recent.map((entry, position) => ({ ...entry, position })),
    };
    const older = [row(0), row(1), row(2)];
    const merged = mergeOlderHistoryIntoProjection(projection, older);
    expect(merged.visibleTurnItems.map((entry) => entry.sourceItemId)).toEqual([
      "item-0",
      "item-1",
      "item-2",
      "item-3",
    ]);
    expect(merged.visibleTurnItems.map((entry) => entry.position)).toEqual([0, 1, 2, 3]);
    expect(merged.turnItems.map((item) => item.id)).toEqual([
      "item-2",
      "item-3",
      "item-0",
      "item-1",
    ]);
  });

  it("retains live rows that arrived after the older page was fetched", () => {
    const live = [row(5), row(6)];
    const projection = {
      ...v2Projection,
      turnItems: live.map((entry) => entry.item),
      visibleTurnItems: live.map((entry, position) => ({ ...entry, position })),
    };
    const older = [row(3), row(4)];
    const merged = mergeOlderHistoryIntoProjection(projection, older);
    expect(merged.visibleTurnItems.map((entry) => entry.sourceItemId)).toEqual([
      "item-3",
      "item-4",
      "item-5",
      "item-6",
    ]);
  });

  it("does not resurrect a local item hidden while an older page was in flight", () => {
    const stalePageRow = row(1);
    const currentItem = {
      ...stalePageRow.item,
      output: "newer live output",
      updatedAt: DateTime.makeUnsafe("2026-06-20T00:00:01.000Z"),
    };
    const projection = {
      ...v2Projection,
      turnItems: [currentItem],
      visibleTurnItems: [],
    };

    const merged = mergeOlderHistoryIntoProjection(projection, [stalePageRow]);

    expect(merged).toBe(projection);
    expect(merged.turnItems).toEqual([currentItem]);
    expect(merged.visibleTurnItems).toEqual([]);
  });

  it("marks history expanded after a successful page", () => {
    const next = applyHistoryPageMeta(
      {
        historyCursor: "cursor-a",
        hasMoreHistory: true,
        loading: true,
        error: null,
        expanded: false,
        latestLocalTurnOrdinal: 42,
      },
      { nextCursor: "cursor-b", hasMoreHistory: true },
    );
    expect(next).toEqual({
      historyCursor: "cursor-b",
      hasMoreHistory: true,
      loading: false,
      error: null,
      expanded: true,
      latestLocalTurnOrdinal: 42,
    });
  });

  it("only applies history responses for the active request cursor", () => {
    expect(isActiveHistoryRequestCursor("cursor-a", { historyCursor: "cursor-a" })).toBe(true);
    expect(isActiveHistoryRequestCursor("cursor-a", { historyCursor: "cursor-b" })).toBe(false);
    expect(isActiveHistoryRequestCursor("cursor-a", { historyCursor: null })).toBe(false);
  });

  it("clears loading on interrupt only for the active request cursor", () => {
    const loading = {
      historyCursor: "cursor-a",
      hasMoreHistory: true,
      loading: true,
      error: null,
      expanded: false,
      latestLocalTurnOrdinal: 10,
    };
    expect(clearActiveHistoryLoading("cursor-a", loading)).toEqual({
      ...loading,
      loading: false,
    });
    // Stale cursor must not mutate replacement progressive meta.
    expect(
      clearActiveHistoryLoading("cursor-a", { ...loading, historyCursor: "cursor-b" }),
    ).toEqual({ ...loading, historyCursor: "cursor-b" });
    // Already idle: identity-preserving no-op shape.
    const idle = { ...loading, loading: false };
    expect(clearActiveHistoryLoading("cursor-a", idle)).toBe(idle);
  });

  it("shows the load-earlier control when history remains or a local error is set", () => {
    expect(
      shouldShowLoadEarlierControl({
        historyCursor: "c",
        hasMoreHistory: true,
        loading: false,
        error: null,
        expanded: false,
        latestLocalTurnOrdinal: null,
      }),
    ).toBe(true);
    expect(
      shouldShowLoadEarlierControl({
        historyCursor: null,
        hasMoreHistory: false,
        loading: false,
        error: "Could not load earlier activity.",
        expanded: true,
        latestLocalTurnOrdinal: null,
      }),
    ).toBe(true);
    expect(
      shouldShowLoadEarlierControl({
        historyCursor: null,
        hasMoreHistory: false,
        loading: false,
        error: null,
        expanded: false,
        latestLocalTurnOrdinal: null,
      }),
    ).toBe(false);
  });

  it("retains merged older rows when a live turn-item update arrives", () => {
    const recent = [row(2), row(3)];
    const projection = {
      ...v2Projection,
      turnItems: recent.map((entry) => entry.item),
      visibleTurnItems: recent.map((entry, position) => ({ ...entry, position })),
    };
    const merged = mergeOlderHistoryIntoProjection(projection, [row(0), row(1)]);
    const liveItem = {
      ...row(3).item,
      output: "streamed",
    };
    const next = applyOrchestrationV2ProjectionEvent(merged, {
      id: "event-live-item" as never,
      type: "turn-item.updated",
      threadId: v2ThreadId,
      occurredAt: NOW,
      payload: liveItem,
    } as never);
    expect(next?.visibleTurnItems.map((entry) => entry.sourceItemId)).toEqual([
      "item-0",
      "item-1",
      "item-2",
      "item-3",
    ]);
    expect(next?.visibleTurnItems[3]?.item).toEqual(liveItem);
  });

  it("keeps a history-page interrupt result visible when its request was retained at cold open", () => {
    // Cold bounded window: only a recent filler. Request was retained in
    // turnItems (not visible). Result arrives later via load-earlier merge.
    const runId = "run-interrupt-cold" as never;
    const nodeId = "node-interrupt-cold" as never;
    const recent = row(5);
    const requestItem = {
      id: "item-interrupt-request" as never,
      type: "run_interrupt_request" as const,
      threadId: v2ThreadId,
      runId,
      nodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed" as const,
      title: null,
      message: "Stopping",
      startedAt: NOW,
      completedAt: NOW,
      updatedAt: NOW,
    };
    const resultItem = {
      id: "item-interrupt-result" as never,
      type: "run_interrupt_result" as const,
      threadId: v2ThreadId,
      runId,
      nodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 2,
      status: "completed" as const,
      title: null,
      message: "Stopped",
      startedAt: NOW,
      completedAt: NOW,
      updatedAt: NOW,
    };
    const resultRow = {
      position: 0,
      visibility: "local" as const,
      sourceThreadId: v2ThreadId,
      sourceItemId: resultItem.id,
      item: resultItem,
    };
    const coldOpen = {
      ...v2Projection,
      runs: [
        {
          id: runId,
          threadId: v2ThreadId,
          ordinal: 1,
          providerInstanceId: "codex" as never,
          modelSelection: { instanceId: "codex" as never, model: "gpt-5" },
          providerThreadId: null,
          userMessageId: "message-1" as never,
          rootNodeId: nodeId,
          activeAttemptId: null,
          status: "running" as const,
          requestedAt: NOW,
          startedAt: NOW,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        },
      ],
      attempts: [
        {
          id: "attempt-1" as never,
          runId,
          attemptOrdinal: 1,
          rootNodeId: nodeId,
          providerInstanceId: "codex" as never,
          providerThreadId: "provider-thread-1" as never,
          providerTurnId: null,
          reason: "initial" as const,
          status: "running" as const,
          startedAt: NOW,
          completedAt: null,
        },
      ],
      // Request retained from full projection; no result yet in the window.
      turnItems: [requestItem, recent.item],
      visibleTurnItems: [{ ...recent, position: 0 }],
    };

    const requestMerged = mergeOlderHistoryIntoProjection(coldOpen, [
      {
        position: 0,
        visibility: "local",
        sourceThreadId: v2ThreadId,
        sourceItemId: requestItem.id,
        item: requestItem,
      },
    ]);
    expect(requestMerged.visibleTurnItems.map((entry) => String(entry.sourceItemId))).toEqual([
      "item-interrupt-request",
      "item-5",
    ]);

    const rolledBackRequestMerged = mergeOlderHistoryIntoProjection(
      {
        ...coldOpen,
        runs: coldOpen.runs.map((run) => ({
          ...run,
          status: "rolled_back" as const,
          completedAt: NOW,
        })),
      },
      [
        {
          position: 0,
          visibility: "local",
          sourceThreadId: v2ThreadId,
          sourceItemId: requestItem.id,
          item: requestItem,
        },
      ],
    );
    expect(
      rolledBackRequestMerged.visibleTurnItems.map((entry) => String(entry.sourceItemId)),
    ).toEqual(["item-5"]);

    const merged = mergeOlderHistoryIntoProjection(coldOpen, [resultRow]);
    expect(merged.visibleTurnItems.map((entry) => String(entry.sourceItemId))).toEqual([
      "item-interrupt-result",
      "item-5",
    ]);
    expect(merged.turnItems.some((item) => item.type === "run_interrupt_request")).toBe(true);
    expect(merged.turnItems.some((item) => item.type === "run_interrupt_result")).toBe(true);

    const attemptSuperseded = applyOrchestrationV2ProjectionEvent(
      merged,
      {
        id: "event-attempt-superseded" as never,
        type: "run-attempt.updated",
        threadId: v2ThreadId,
        runId,
        occurredAt: NOW,
        payload: {
          id: "attempt-1" as never,
          runId,
          attemptOrdinal: 1,
          rootNodeId: nodeId,
          providerInstanceId: "codex" as never,
          providerThreadId: "provider-thread-1" as never,
          providerTurnId: null,
          reason: "initial",
          status: "superseded",
          startedAt: NOW,
          completedAt: NOW,
        },
      } as never,
      { partialTimeline: true },
    );

    expect(attemptSuperseded?.visibleTurnItems.map((entry) => String(entry.sourceItemId))).toEqual([
      "item-interrupt-result",
      "item-5",
    ]);

    // Without the cold-open retained request, the same update would hide the result.
    const withoutRequest = {
      ...merged,
      turnItems: merged.turnItems.filter((item) => item.type !== "run_interrupt_request"),
    };
    const hidden = applyOrchestrationV2ProjectionEvent(
      withoutRequest,
      {
        id: "event-attempt-superseded-missing" as never,
        type: "run-attempt.updated",
        threadId: v2ThreadId,
        runId,
        occurredAt: NOW,
        payload: {
          id: "attempt-1" as never,
          runId,
          attemptOrdinal: 1,
          rootNodeId: nodeId,
          providerInstanceId: "codex" as never,
          providerThreadId: "provider-thread-1" as never,
          providerTurnId: null,
          reason: "initial",
          status: "superseded",
          startedAt: NOW,
          completedAt: NOW,
        },
      } as never,
      { partialTimeline: true },
    );
    expect(hidden?.visibleTurnItems.map((entry) => String(entry.sourceItemId))).toEqual(["item-5"]);
  });
});
