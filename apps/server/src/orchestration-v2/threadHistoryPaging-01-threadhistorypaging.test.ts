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
  deferWorkHistoryRows,
  boundedTimelineEncodedBytes,
  computeLatestLocalTurnOrdinal,
  decodeThreadHistoryCursor,
  encodeThreadHistoryCursor,
  projectedRowBoundedSnapshotEncodedBytes,
  projectedRowEncodedBytes,
  selectHistoryPageFromCursor,
  selectDeferredWorkPage,
  selectRecentTimelineWindow,
  THREAD_HISTORY_PAGE_POLICY,
} from "./threadHistoryPaging.ts";
import { projectThreadProjectionForWire } from "./WireProjection.ts";

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

function makeTurnStart(
  index: number,
  createdBy: "user" | "agent",
): OrchestrationV2ProjectedTurnItem {
  const row = makeRow(index);
  return {
    ...row,
    item: {
      ...row.item,
      type: "user_message",
      createdBy,
      creationSource: "provider",
      inputIntent: "turn_start",
      messageId: MessageId.make(`prompt-${index}`),
      text: `Prompt ${index}`,
      attachments: [],
    },
  } as OrchestrationV2ProjectedTurnItem;
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
  it("defers completed work above 150 items and keeps conversation and persistent rows", () => {
    const work = Array.from({ length: 151 }, (_, index) => {
      const row = makeRow(index);
      return { ...row, item: { ...row.item, runId: RUN, runStatus: "completed" } };
    });
    expect(deferWorkHistoryRows(work.slice(0, 150))).toHaveLength(150);
    const deferredWork = deferWorkHistoryRows(work)[0]!.item.deferredWork!;
    expect(deferredWork.itemCount).toBe(151);
    expect(decodeThreadHistoryCursor(deferredWork.cursor).p).toBe(151);
    const superseded = work.map((row) => ({
      ...row,
      item: { ...row.item, runStatus: "running", attemptId: "old", attemptStatus: "superseded" },
    }));
    const active = work.map((row, index) => ({
      ...row,
      sourceItemId: TurnItemId.make(`active-${index}`),
      position: row.position + work.length,
      item: { ...row.item, runStatus: "running", attemptId: "active", attemptStatus: "running" },
    }));
    const attempts = deferWorkHistoryRows([...superseded, ...active]);
    expect(attempts[0]?.item.deferredWork?.itemCount).toBe(151);
    expect(attempts.slice(1)).toEqual(active);
    const compaction = {
      ...work[0]!,
      sourceItemId: TurnItemId.make("compaction"),
      item: {
        ...work[0]!.item,
        type: "compaction" as const,
      },
    };
    const persistent = {
      ...work[0]!,
      sourceItemId: TurnItemId.make("render"),
      item: {
        ...work[0]!.item,
        type: "dynamic_tool" as const,
        persistentOutput: true,
      },
    };
    const deferred = deferWorkHistoryRows([
      ...work.slice(0, 30),
      compaction,
      persistent,
      ...work.slice(30),
    ]);
    expect(deferred.map((row) => row.sourceItemId)).toEqual(["item-0", "compaction", "render"]);
    expect(deferred[0]?.item.deferredWork?.itemCount).toBe(151);
    for (const runStatus of ["running", "failed", "interrupted", "cancelled"]) {
      expect(
        deferWorkHistoryRows(work.map((row) => ({ ...row, item: { ...row.item, runStatus } }))),
      ).toHaveLength(151);
    }
    const interrupted = {
      ...compaction,
      item: { ...compaction.item, type: "run_interrupt_result" as const },
    };
    expect(deferWorkHistoryRows([...work, interrupted])).toHaveLength(152);
    const failed = {
      ...compaction,
      item: {
        ...compaction.item,
        type: "error" as const,
        status: "failed" as const,
        nodeId: "root-node",
        parentItemId: null,
      },
    };
    expect(deferWorkHistoryRows([...work, failed])).toHaveLength(152);
  });
  it("keeps a human turn whole up to the turn row budget and pages a longer one from inside", () => {
    const humanTurn = (length: number) => {
      const items = Array.from({ length }, (_, index) => makeRow(index));
      items[0] = {
        ...items[0]!,
        item: {
          ...items[0]!.item,
          type: "user_message",
          createdBy: "user",
          creationSource: "web",
          inputIntent: "turn_start",
          messageId: MessageId.make("long-human-turn"),
          text: "Continue",
          attachments: [],
        },
      } as OrchestrationV2ProjectedTurnItem;
      return items;
    };

    const whole = selectRecentTimelineWindow({ items: humanTurn(180), snapshotSequence: 1 });
    expect(whole.items).toHaveLength(180);
    expect(whole.hasMoreHistory).toBe(false);

    const items = humanTurn(THREAD_HISTORY_PAGE_POLICY.maxTurnItems + 100);
    const recent = selectRecentTimelineWindow({ items, snapshotSequence: 1 });
    expect(recent.items).toHaveLength(THREAD_HISTORY_PAGE_POLICY.maxItems);
    const loaded = [...recent.items];
    let cursor = recent.nextCursor;
    for (let pages = 0; cursor !== null; pages += 1) {
      expect(pages).toBeLessThan(items.length);
      const page = selectHistoryPageFromCursor({ items, cursor, snapshotSequence: 1 });
      expect(page.items.length).toBeGreaterThan(0);
      expect(page.items.length).toBeLessThanOrEqual(
        page.items[0]?.item.type === "user_message"
          ? THREAD_HISTORY_PAGE_POLICY.maxTurnItems
          : THREAD_HISTORY_PAGE_POLICY.maxItems,
      );
      loaded.unshift(...page.items);
      cursor = page.nextCursor;
    }
    expect(loaded.map((row) => row.sourceItemId)).toEqual(items.map((row) => row.sourceItemId));

    const large = items
      .slice(0, 12)
      .map((row) =>
        row.item.type === "command_execution"
          ? { ...row, item: { ...row.item, output: "x".repeat(200_000) } }
          : row,
      );
    const bounded = buildBoundedThreadProjection({
      projection: makeProjection(large),
      snapshotSequence: 1,
    });
    expect(bounded.projection.visibleTurnItems.length).toBeLessThan(large.length);
    expect(boundedTimelineEncodedBytes(bounded.projection)).toBeLessThanOrEqual(
      THREAD_HISTORY_PAGE_POLICY.maxEncodedBytes,
    );
  });
  it("keeps background turns with user turns, with main's 150-turn fan-out ceiling", () => {
    const items = Array.from({ length: 161 }, (_, turn) => {
      const row = makeRow(turn * 2);
      if (row.item.type !== "command_execution") throw new Error("Expected command fixture");
      const prompt: OrchestrationV2ProjectedTurnItem = {
        ...row,
        item: {
          ...row.item,
          type: "user_message",
          createdBy: turn === 0 ? "user" : "agent",
          creationSource: "provider",
          inputIntent: "turn_start",
          messageId: MessageId.make(`prompt-${turn}`),
          text: `Prompt ${turn}`,
          attachments: [],
        },
      };
      return [prompt, makeRow(turn * 2 + 1)];
    }).flat();
    const policy = { ...THREAD_HISTORY_PAGE_POLICY, maxItems: 1_000, maxEncodedBytes: 10_000_000 };
    const first = selectRecentTimelineWindow({ items, snapshotSequence: 1, policy });
    expect(first.items).toHaveLength(300);
    expect(first.items[0]?.sourceItemId).toBe("item-22");
    const older = selectHistoryPageFromCursor({
      items,
      cursor: first.nextCursor!,
      snapshotSequence: 1,
      policy,
    });
    expect(older.items).toHaveLength(22);
    expect(older.hasMoreHistory).toBe(false);
    expect([...older.items, ...first.items].map((row) => row.sourceItemId)).toEqual(
      items.map((row) => row.sourceItemId),
    );
  });
  it("counts runs that a notification started toward the 150-turn ceiling", () => {
    const inRun = (index: number, run: number, item: object = {}) => {
      const row = makeRow(index);
      return {
        ...row,
        item: { ...row.item, runId: RunId.make(`run-${run}`), ...item },
      } as OrchestrationV2ProjectedTurnItem;
    };
    const notification = (summary: string) => ({
      type: "notification",
      source: { kind: "monitor" },
      outcome: "completed",
      summary,
    });
    const items = Array.from({ length: 161 }, (_, run) => [
      inRun(run * 4, run),
      inRun(
        run * 4 + 1,
        run,
        run === 0
          ? {
              type: "user_message",
              createdBy: "user",
              creationSource: "web",
              inputIntent: "turn_start",
              messageId: MessageId.make("prompt-0"),
              text: "Prompt 0",
              attachments: [],
            }
          : notification(`Wake ${run}`),
      ),
      inRun(run * 4 + 2, run, notification(`Steer ${run}`)),
      inRun(run * 4 + 3, run),
    ]).flat();
    const policy = {
      ...THREAD_HISTORY_PAGE_POLICY,
      maxItems: 1_000,
      maxTurnItems: 1_000,
      maxEncodedBytes: 10_000_000,
    };
    const first = selectRecentTimelineWindow({ items, snapshotSequence: 1, policy });
    expect(first.items).toHaveLength(150 * 4 - 1);
    expect(first.items[0]?.sourceItemId).toBe(`item-${11 * 4 + 1}`);
    const older = selectHistoryPageFromCursor({
      items,
      cursor: first.nextCursor!,
      snapshotSequence: 1,
      policy,
    });
    expect([...older.items, ...first.items].map((row) => row.sourceItemId)).toEqual(
      items.map((row) => row.sourceItemId),
    );
  });
  it("pages agent-only child transcripts instead of dropping their earlier activity", () => {
    const commandRows = Array.from({ length: 90 }, (_, index) => makeRow(index + 1));
    const first = makeRow(0);
    const prompt = {
      ...first,
      item: {
        ...first.item,
        type: "user_message" as const,
        createdBy: "agent" as const,
        creationSource: "provider" as const,
        inputIntent: "turn_start" as const,
        messageId: MessageId.make("child-prompt"),
        text: "Inspect this project",
        attachments: [],
      },
    } as OrchestrationV2ProjectedTurnItem;
    const items = [prompt, ...commandRows];
    const recent = selectRecentTimelineWindow({ items, snapshotSequence: 1 });

    expect(recent.items).toHaveLength(THREAD_HISTORY_PAGE_POLICY.maxItems);
    expect(recent.hasMoreHistory).toBe(true);
    const older = selectHistoryPageFromCursor({
      items,
      cursor: recent.nextCursor!,
      snapshotSequence: 1,
    });
    expect(older.items[0]?.item.type).toBe("user_message");
    expect([...older.items, ...recent.items]).toHaveLength(items.length);
  });
  it("always includes at least one pathological oversized item", () => {
    for (const humanTurn of [false, true]) {
      const oversized = makeRow(0, { outputBytes: 2_000_000 });
      const items = [
        humanTurn
          ? ({
              ...oversized,
              item: {
                ...oversized.item,
                type: "user_message",
                createdBy: "user",
                creationSource: "web",
                inputIntent: "turn_start",
                messageId: MessageId.make("oversized-human-turn"),
                text: "x".repeat(2_000_000),
                attachments: [],
              },
            } as OrchestrationV2ProjectedTurnItem)
          : oversized,
        makeRow(1, { outputBytes: 10 }),
      ];
      const policy = { ...THREAD_HISTORY_PAGE_POLICY, maxItems: 50, maxEncodedBytes: 1_024 };
      const page = selectRecentTimelineWindow({ items, snapshotSequence: 1, policy });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.sourceItemId).toBe("item-1");
      expect(page.hasMoreHistory).toBe(true);

      const older = selectHistoryPageFromCursor({
        items,
        cursor: page.nextCursor!,
        snapshotSequence: 1,
        policy,
      });
      expect(older.items).toHaveLength(1);
      expect(older.items[0]?.sourceItemId).toBe("item-0");
      expect(older.hasMoreHistory).toBe(false);
      expect(older.nextCursor).toBeNull();
      expect([...older.items, ...page.items].map((row) => row.sourceItemId)).toEqual(
        items.map((row) => row.sourceItemId),
      );
    }
  });
  it.each([
    {
      name: "item ceiling",
      items: Array.from({ length: 5 }, (_, index) => makeRow(index)),
      policy: { maxItems: 3, maxEncodedBytes: 1_000 },
      admitted: 3,
      measured: 3,
    },
    {
      name: "user turn ceiling",
      items: [makeRow(0), makeTurnStart(1, "user"), makeRow(2)],
      policy: { maxUserTurns: 1, maxItems: 100, maxEncodedBytes: 1_000 },
      admitted: 2,
      measured: 2,
    },
    {
      name: "raw turn ceiling",
      items: [
        makeTurnStart(0, "user"),
        ...Array.from({ length: 151 }, (_, index) => makeTurnStart(index + 1, "agent")),
      ],
      policy: { maxUserTurns: 10, maxItems: 1_000, maxEncodedBytes: 1_000_000 },
      admitted: 150,
      measured: 150,
    },
    {
      name: "byte budget, which still admits an exact fit",
      items: Array.from({ length: 5 }, (_, index) => makeRow(index)),
      policy: { maxItems: 100, maxEncodedBytes: 20 },
      admitted: 2,
      measured: 3,
    },
    {
      name: "byte budget, which still admits an oversized first row",
      items: Array.from({ length: 5 }, (_, index) => makeRow(index)),
      policy: { maxItems: 100, maxEncodedBytes: 5 },
      admitted: 1,
      measured: 2,
    },
  ])("measures only the rows needed to stop at the $name", (testCase) => {
    const measured: OrchestrationV2ProjectedTurnItem[] = [];
    const page = selectRecentTimelineWindow({
      items: testCase.items,
      snapshotSequence: 1,
      policy: testCase.policy,
      rowEncodedBytes: (row) => {
        measured.push(row);
        return 10;
      },
    });

    expect(page.items.map((row) => row.sourceItemId)).toEqual(
      testCase.items.slice(-testCase.admitted).map((row) => row.sourceItemId),
    );
    expect(measured).toHaveLength(testCase.measured);
    expect(page.hasMoreHistory).toBe(true);
    expect(decodeThreadHistoryCursor(page.nextCursor!).si).toBe(page.items[0]?.sourceItemId);
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
    expect(page.items.map((row) => row.sourceItemId)).toEqual(["item-3", "item-4"]);
    expect(page.hasMoreHistory).toBe(true);
    expect(page.nextCursor).not.toBeNull();
    const sparse = [makeRow(0), makeRow(10), makeRow(20)];
    const middle = selectHistoryPageFromCursor({
      items: sparse,
      cursor: encodeThreadHistoryCursor({
        snapshotSequence: 3,
        sourceThreadId: THREAD,
        sourceItemId: "item-hidden",
        position: 15,
      }),
      snapshotSequence: 3,
    });
    expect(middle.items.map((row) => row.sourceItemId)).toEqual(["item-0", "item-10"]);
    const work = Array.from({ length: 80 }, (_, index) => {
      const row = makeRow(index);
      return { ...row, item: { ...row.item, runId: RUN, ordinal: index + 100 } };
    });
    const tail = work[75]!;
    const deferred = selectDeferredWorkPage({
      items: work.filter((row) => row !== tail).map((row, position) => ({ ...row, position })),
      cursor: encodeThreadHistoryCursor({
        snapshotSequence: 3,
        sourceThreadId: THREAD,
        sourceItemId: tail.sourceItemId,
        position: tail.item.ordinal,
        inclusive: true,
      }),
      throughEntryId: work[0]!.sourceItemId,
      snapshotSequence: 3,
    });
    expect(deferred.items.map((row) => row.sourceItemId)).toEqual(
      work.slice(0, 75).map((row) => row.sourceItemId),
    );
    expect(deferred.nextCursor).toBeNull();
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
    const full = makeProjection([localOlder, localMid, inherited]);
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
});

