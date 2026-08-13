import {
  MessageId,
  NodeId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  buildBoundedThreadProjection,
  boundedTimelineEncodedBytes,
  computeLatestLocalTurnOrdinal,
  decodeThreadHistoryCursor,
  encodeThreadHistoryCursor,
  InvalidThreadHistoryCursorError,
  projectedRowBoundedSnapshotEncodedBytes,
  projectedRowEncodedBytes,
  selectHistoryPageFromCursor,
  selectRecentTimelineWindow,
  THREAD_HISTORY_CURSOR_MAX_LENGTH,
  THREAD_HISTORY_PAGE_POLICY,
} from "./threadHistoryPaging.ts";

const NOW = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
const THREAD = ThreadId.make("thread-1");
const RUN = RunId.make("run-interrupt-1");
const NODE = NodeId.make("node-interrupt-1");

function makeRow(
  index: number,
  options?: { readonly outputBytes?: number },
): OrchestrationV2ProjectedTurnItem {
  const id = TurnItemId.make(`item-${index}`);
  const output =
    options?.outputBytes !== undefined ? "x".repeat(options.outputBytes) : `output-${index}`;
  return {
    position: index,
    visibility: "local",
    sourceThreadId: THREAD,
    sourceItemId: id,
    item: {
      id,
      type: "command_execution",
      threadId: THREAD,
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
      output,
      exitCode: 0,
      startedAt: NOW,
      completedAt: NOW,
      updatedAt: NOW,
    },
  };
}

function interruptItem(
  id: string,
  type: "run_interrupt_request" | "run_interrupt_result",
  ordinal: number,
): OrchestrationV2TurnItem {
  return {
    id: TurnItemId.make(id),
    type,
    threadId: THREAD,
    runId: RUN,
    nodeId: NODE,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed",
    title: type,
    message: type === "run_interrupt_request" ? "Stopping" : "Stopped",
    startedAt: NOW,
    completedAt: NOW,
    updatedAt: NOW,
  } as OrchestrationV2TurnItem;
}

function interruptRow(
  index: number,
  type: "run_interrupt_request" | "run_interrupt_result",
): OrchestrationV2ProjectedTurnItem {
  const item = interruptItem(
    type === "run_interrupt_request" ? "interrupt-req" : "interrupt-res",
    type,
    index + 1,
  );
  return {
    position: index,
    visibility: "local",
    sourceThreadId: THREAD,
    sourceItemId: item.id,
    item,
  };
}

function makeProjection(visibleTurnItems: OrchestrationV2ProjectedTurnItem[]) {
  return {
    thread: {
      id: THREAD,
      projectId: "project-1",
      title: "Thread",
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: THREAD,
      },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      deletedAt: null,
      settledOverride: null,
      settledAt: null,
    },
    runs: [{ id: "run-1" }],
    attempts: [{ id: "attempt-1" }],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [{ id: "req-1" }],
    messages: [],
    plans: [],
    turnItems: visibleTurnItems.map((row) => row.item),
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems,
    updatedAt: NOW,
  } as unknown as Parameters<typeof buildBoundedThreadProjection>[0]["projection"];
}

describe("threadHistoryPaging", () => {
  it("encodes opaque cursors with stable source identity", () => {
    const cursor = encodeThreadHistoryCursor({
      snapshotSequence: 9,
      sourceThreadId: THREAD,
      sourceItemId: TurnItemId.make("item-3"),
      position: 3,
    });
    expect(cursor.includes("{")).toBe(false);
    expect(decodeThreadHistoryCursor(cursor)).toEqual({
      v: 1,
      seq: 9,
      st: "thread-1",
      si: "item-3",
      p: 3,
    });
  });

  it("rejects malformed cursors", () => {
    expect(() => decodeThreadHistoryCursor("not-valid")).toThrow(InvalidThreadHistoryCursorError);
    expect(() =>
      decodeThreadHistoryCursor(Buffer.from("{}", "utf8").toString("base64url")),
    ).toThrow(InvalidThreadHistoryCursorError);
  });

  it("rejects cursors longer than the maximum length before decoding", () => {
    const oversized = "A".repeat(THREAD_HISTORY_CURSOR_MAX_LENGTH + 1);
    expect(() => decodeThreadHistoryCursor(oversized)).toThrow(InvalidThreadHistoryCursorError);
  });

  it("selects a recent window by item count", () => {
    const items = Array.from({ length: 120 }, (_, index) => makeRow(index));
    const page = selectRecentTimelineWindow({
      items,
      snapshotSequence: 4,
      policy: { maxItems: 10, maxEncodedBytes: 10_000_000 },
    });
    expect(page.items).toHaveLength(10);
    expect(page.items[0]?.sourceItemId).toBe("item-110");
    expect(page.items[9]?.sourceItemId).toBe("item-119");
    expect(page.hasMoreHistory).toBe(true);
    expect(page.nextCursor).not.toBeNull();
    const cursor = decodeThreadHistoryCursor(page.nextCursor!);
    expect(cursor.si).toBe("item-110");
    expect(cursor.seq).toBe(4);
  });

  it("always includes at least one pathological oversized item", () => {
    const items = [makeRow(0, { outputBytes: 2_000_000 }), makeRow(1, { outputBytes: 10 })];
    const page = selectRecentTimelineWindow({
      items,
      snapshotSequence: 1,
      policy: { maxItems: 50, maxEncodedBytes: 1_024 },
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.sourceItemId).toBe("item-1");
    expect(page.hasMoreHistory).toBe(true);

    const older = selectHistoryPageFromCursor({
      items,
      cursor: page.nextCursor!,
      snapshotSequence: 1,
      policy: { maxItems: 50, maxEncodedBytes: 1_024 },
    });
    expect(older.items).toHaveLength(1);
    expect(older.items[0]?.sourceItemId).toBe("item-0");
    expect(older.hasMoreHistory).toBe(false);
    expect(older.nextCursor).toBeNull();
  });

  it("recovers identity-miss cursors when position is past a shrunken timeline", () => {
    const items = Array.from({ length: 5 }, (_, index) => makeRow(index));
    const cursor = encodeThreadHistoryCursor({
      snapshotSequence: 3,
      sourceThreadId: THREAD,
      sourceItemId: TurnItemId.make("item-deleted-long-ago"),
      position: 40,
    });
    const page = selectHistoryPageFromCursor({
      items,
      cursor,
      snapshotSequence: 3,
      policy: { maxItems: 2, maxEncodedBytes: 10_000_000 },
    });
    // Clamp exclusive end to items.length and page backward so the client can
    // dedupe and advance rather than permanently 400 on a dead cursor.
    expect(page.items.map((row) => row.sourceItemId)).toEqual(["item-3", "item-4"]);
    expect(page.hasMoreHistory).toBe(true);
    expect(page.nextCursor).not.toBeNull();
  });

  it("keeps cursor resolution stable when newer items append", () => {
    const initial = Array.from({ length: 20 }, (_, index) => makeRow(index));
    const recent = selectRecentTimelineWindow({
      items: initial,
      snapshotSequence: 2,
      policy: { maxItems: 5, maxEncodedBytes: 10_000_000 },
    });
    const cursor = recent.nextCursor!;
    const grown = [...initial, makeRow(20), makeRow(21)];
    const older = selectHistoryPageFromCursor({
      items: grown,
      cursor,
      snapshotSequence: 5,
      policy: { maxItems: 5, maxEncodedBytes: 10_000_000 },
    });
    expect(older.items.map((row) => row.sourceItemId)).toEqual([
      "item-10",
      "item-11",
      "item-12",
      "item-13",
      "item-14",
    ]);
    expect(older.hasMoreHistory).toBe(true);
  });

  it("builds a bounded projection that preserves non-timeline control state", () => {
    const full = makeProjection(Array.from({ length: 40 }, (_, index) => makeRow(index)));
    const bounded = buildBoundedThreadProjection({
      projection: full,
      snapshotSequence: 7,
      policy: { maxItems: 5, maxEncodedBytes: 10_000_000 },
    });
    expect(bounded.projection.runs).toEqual(full.runs);
    expect(bounded.projection.runtimeRequests).toEqual(full.runtimeRequests);
    expect(bounded.projection.attempts).toEqual(full.attempts);
    expect(bounded.projection.visibleTurnItems).toHaveLength(5);
    expect(bounded.projection.turnItems).toHaveLength(5);
    expect(bounded.hasMoreHistory).toBe(true);
    expect(bounded.historyCursor).not.toBeNull();
    expect(bounded.projection.visibleTurnItems.map((row) => row.position)).toEqual([0, 1, 2, 3, 4]);
    // Watermark comes from the full projection, not the trimmed window.
    expect(bounded.latestLocalTurnOrdinal).toBe(40);
    expect(computeLatestLocalTurnOrdinal(full.turnItems)).toBe(40);
  });

  it("carries a full-projection watermark when the bounded window is inherited-only", () => {
    const localOlder = makeRow(0);
    const localMid = makeRow(1);
    const inherited = {
      ...makeRow(2),
      visibility: "inherited" as const,
      sourceThreadId: ThreadId.make("parent-thread"),
      item: {
        ...makeRow(2).item,
        threadId: ThreadId.make("parent-thread"),
      },
    };
    // Full projection still has local turnItems even if the recent window is
    // only the inherited row (e.g. after aggressive byte budget on a large
    // local item that is not selected into the recent page). Use a synthetic
    // projection with local turnItems and inherited-only visible window.
    const full = makeProjection([localOlder, localMid, inherited]);
    // Force an inherited-only visible window by rebuilding with only inherited
    // visible rows while retaining full local turnItems for the watermark.
    const inheritedOnly = {
      ...full,
      visibleTurnItems: [inherited],
      turnItems: [localOlder.item, localMid.item],
    };
    const bounded = buildBoundedThreadProjection({
      projection: inheritedOnly,
      snapshotSequence: 2,
      policy: { maxItems: 1, maxEncodedBytes: 10_000_000 },
    });
    expect(bounded.projection.visibleTurnItems.map((row) => String(row.sourceItemId))).toEqual([
      String(inherited.sourceItemId),
    ]);
    expect(bounded.latestLocalTurnOrdinal).toBe(2);
    expect(computeLatestLocalTurnOrdinal([])).toBeNull();
  });

  it("retains an out-of-window run_interrupt_request needed by a visible result", () => {
    // Older request sits outside a 1-row recent window; result is visible alone.
    const request = interruptRow(0, "run_interrupt_request");
    const filler = makeRow(1);
    const result = interruptRow(2, "run_interrupt_result");
    const full = makeProjection([request, filler, result]);
    const bounded = buildBoundedThreadProjection({
      projection: full,
      snapshotSequence: 3,
      policy: { maxItems: 1, maxEncodedBytes: 10_000_000 },
    });

    expect(bounded.projection.visibleTurnItems.map((row) => String(row.sourceItemId))).toEqual([
      "interrupt-res",
    ]);
    expect(bounded.projection.turnItems.map((item) => String(item.id)).sort()).toEqual([
      "interrupt-req",
      "interrupt-res",
    ]);
    expect(bounded.hasMoreHistory).toBe(true);
  });

  it("retains all run_interrupt_request items even when no result is in the initial window", () => {
    // Cold open: recent window is only filler. Request and result both live on
    // older pages, but the request must still ride in turnItems so a later
    // history page can introduce the result safely under live attempt updates.
    const request = interruptRow(0, "run_interrupt_request");
    const result = interruptRow(1, "run_interrupt_result");
    const recent = makeRow(2);
    const full = makeProjection([request, result, recent]);
    const bounded = buildBoundedThreadProjection({
      projection: full,
      snapshotSequence: 4,
      policy: { maxItems: 1, maxEncodedBytes: 10_000_000 },
    });

    expect(bounded.projection.visibleTurnItems.map((row) => String(row.sourceItemId))).toEqual([
      "item-2",
    ]);
    expect(bounded.projection.turnItems.map((item) => String(item.id)).sort()).toEqual([
      "interrupt-req",
      "item-2",
    ]);
    expect(bounded.projection.turnItems.some((item) => item.type === "run_interrupt_request")).toBe(
      true,
    );
    expect(bounded.projection.turnItems.some((item) => item.type === "run_interrupt_result")).toBe(
      false,
    );
  });

  it("charges local row.item duplication when measuring bounded timeline bytes", () => {
    const rows = Array.from({ length: 8 }, (_, index) => makeRow(index, { outputBytes: 2_000 }));
    const full = makeProjection(rows);
    const maxEncodedBytes = 12_000;
    const bounded = buildBoundedThreadProjection({
      projection: full,
      snapshotSequence: 1,
      policy: { maxItems: 50, maxEncodedBytes },
    });

    const contribution = boundedTimelineEncodedBytes({
      visibleTurnItems: bounded.projection.visibleTurnItems,
      turnItems: bounded.projection.turnItems,
    });
    expect(contribution).toBeLessThanOrEqual(maxEncodedBytes);
    expect(bounded.projection.visibleTurnItems.length).toBeGreaterThan(0);
    expect(bounded.projection.visibleTurnItems.length).toBeLessThan(rows.length);

    // History pages only charge the projected row once (no turnItems copy).
    const historyPage = selectRecentTimelineWindow({
      items: rows,
      snapshotSequence: 1,
      policy: { maxItems: 50, maxEncodedBytes },
    });
    const historyBytes = historyPage.items.reduce(
      (sum, row) => sum + projectedRowEncodedBytes(row),
      0,
    );
    expect(historyBytes).toBeLessThanOrEqual(maxEncodedBytes);
    expect(historyPage.items.length).toBeGreaterThan(bounded.projection.visibleTurnItems.length);

    // Dual-cost for one local row exceeds the plain row cost.
    const sample = rows[0]!;
    expect(projectedRowBoundedSnapshotEncodedBytes(sample, THREAD)).toBeGreaterThan(
      projectedRowEncodedBytes(sample),
    );
  });

  it("allows a single pathological bounded row to exceed the configured cap", () => {
    const huge = makeRow(0, { outputBytes: 50_000 });
    const full = makeProjection([huge]);
    const maxEncodedBytes = 1_000;
    const bounded = buildBoundedThreadProjection({
      projection: full,
      snapshotSequence: 1,
      policy: { maxItems: 10, maxEncodedBytes },
    });
    expect(bounded.projection.visibleTurnItems).toHaveLength(1);
    const contribution = boundedTimelineEncodedBytes({
      visibleTurnItems: bounded.projection.visibleTurnItems,
      turnItems: bounded.projection.turnItems,
    });
    expect(contribution).toBeGreaterThan(maxEncodedBytes);
  });

  it("exposes conservative default page budgets", () => {
    expect(THREAD_HISTORY_PAGE_POLICY.maxItems).toBeGreaterThanOrEqual(50);
    expect(THREAD_HISTORY_PAGE_POLICY.maxItems).toBeLessThanOrEqual(100);
    expect(THREAD_HISTORY_PAGE_POLICY.maxEncodedBytes).toBe(1_048_576);
  });

  it("does not carry the full duplicated message table into a bounded snapshot", () => {
    const projection = makeProjection(Array.from({ length: 120 }, (_, index) => makeRow(index)));
    const full = {
      ...projection,
      messages: Array.from({ length: 2_000 }, (_, index) => ({
        id: MessageId.make(`message-${index}`),
        threadId: THREAD,
        runId: RunId.make(`old-run-${index}`),
        nodeId: null,
        role: "assistant" as const,
        text: "x".repeat(1_000),
        attachments: [],
        streaming: false,
        createdBy: "agent" as const,
        creationSource: "provider" as const,
        createdAt: NOW,
        updatedAt: NOW,
      })),
    } as typeof projection;

    const bounded = buildBoundedThreadProjection({
      projection: full,
      snapshotSequence: 9,
    });

    expect(bounded.projection.messages).toEqual([]);
    expect(Buffer.byteLength(JSON.stringify(bounded.projection), "utf8")).toBeLessThan(
      THREAD_HISTORY_PAGE_POLICY.maxEncodedBytes + 100_000,
    );
  });
});
