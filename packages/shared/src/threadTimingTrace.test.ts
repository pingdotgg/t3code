import { describe, expect, it } from "vite-plus/test";
import type {
  MessageId,
  OrchestrationV2TurnItem,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  buildCompressedTimingAxis,
  clampTimingViewWindow,
  deriveThreadTimingTrace,
  layoutThreadFlameChart,
  timingBarPlacement,
  timingViewZoomAt,
} from "./threadTimingTrace.ts";

const THREAD_ID = "thread-1" as ThreadId;
const NOW = Date.parse("2026-05-22T12:05:00.000Z");

function utc(iso: string) {
  return DateTime.makeUnsafe(iso);
}

function run(input: {
  id: string;
  ordinal: number;
  status?: "completed" | "running" | "queued" | "interrupted" | "failed" | "rolled_back";
  requestedAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  workStartedAt?: string;
  userMessageId?: string;
}) {
  return {
    id: input.id as RunId,
    ordinal: input.ordinal,
    status: input.status ?? "completed",
    userMessageId: (input.userMessageId ?? `msg-${input.id}`) as MessageId,
    requestedAt: utc(input.requestedAt),
    startedAt: input.startedAt === null ? null : utc(input.startedAt ?? input.requestedAt),
    completedAt:
      input.completedAt === undefined
        ? utc(input.requestedAt)
        : input.completedAt === null
          ? null
          : utc(input.completedAt),
    ...(input.workStartedAt ? { workStartedAt: utc(input.workStartedAt) } : {}),
  };
}

function item(
  overrides: Partial<OrchestrationV2TurnItem> &
    Pick<OrchestrationV2TurnItem, "id" | "type" | "runId" | "startedAt" | "completedAt">,
): OrchestrationV2TurnItem {
  return {
    threadId: THREAD_ID,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    title: null,
    updatedAt: overrides.completedAt ?? overrides.startedAt ?? utc("2026-05-22T12:00:00.000Z"),
    ...overrides,
  } as OrchestrationV2TurnItem;
}

describe("timingBarPlacement", () => {
  it("positions a span on the shared axis and keeps a visible sliver", () => {
    expect(timingBarPlacement(1_000, 2_000, 0, 10_000)).toEqual({
      offsetPct: 10,
      widthPct: 10,
    });
    expect(timingBarPlacement(0, 1, 0, 10_000).widthPct).toBe(1.5);
  });
});

describe("deriveThreadTimingTrace", () => {
  it("returns null when there are no usable runs", () => {
    expect(
      deriveThreadTimingTrace({
        runs: [
          run({
            id: "r1",
            ordinal: 1,
            status: "rolled_back",
            requestedAt: "2026-05-22T12:00:00.000Z",
          }),
        ],
        turnItems: [],
        nowMs: NOW,
      }),
    ).toBeNull();
  });

  it("builds queue and tool spans and thread totals", () => {
    const trace = deriveThreadTimingTrace({
      runs: [
        run({
          id: "r1",
          ordinal: 1,
          requestedAt: "2026-05-22T12:00:00.000Z",
          startedAt: "2026-05-22T12:00:05.000Z",
          completedAt: "2026-05-22T12:00:30.000Z",
          userMessageId: "user-1",
        }),
      ],
      messages: [
        {
          id: "user-1" as MessageId,
          role: "user",
          text: "Please fix the flaky timing test in MessagesTimeline",
        },
      ],
      turnItems: [
        item({
          id: "tool-1" as TurnItemId,
          type: "command_execution",
          runId: "r1" as RunId,
          title: "Ran npm test",
          startedAt: utc("2026-05-22T12:00:10.000Z"),
          completedAt: utc("2026-05-22T12:00:25.000Z"),
          input: "npm test",
        }),
        item({
          id: "wait-1" as TurnItemId,
          type: "approval_request",
          runId: "r1" as RunId,
          startedAt: utc("2026-05-22T12:00:25.000Z"),
          completedAt: utc("2026-05-22T12:00:28.000Z"),
          requestId: "req-1" as never,
          requestKind: "command" as never,
        }),
      ],
      nowMs: NOW,
    });

    expect(trace).not.toBeNull();
    expect(trace!.turns).toHaveLength(1);
    expect(trace!.turns[0]!.label).toBe("Please fix the flaky timing test in Mes…");
    expect(trace!.turns[0]!.queueWaitMs).toBe(5_000);
    expect(trace!.turns[0]!.waitMs).toBe(3_000);
    expect(trace!.turns[0]!.spans.map((span) => span.kind)).toEqual(["queue", "tool", "wait"]);
    expect(trace!.queueWaitMs).toBe(5_000);
    expect(trace!.waitMs).toBe(3_000);
    expect(trace!.workMs).toBe(22_000);
    expect(trace!.activeMs).toBe(30_000);
    expect(trace!.totalMs).toBe(30_000);
  });

  it("extends an active run to nowMs", () => {
    const trace = deriveThreadTimingTrace({
      runs: [
        run({
          id: "r1",
          ordinal: 1,
          status: "running",
          requestedAt: "2026-05-22T12:00:00.000Z",
          startedAt: "2026-05-22T12:00:00.000Z",
          completedAt: null,
        }),
      ],
      turnItems: [
        item({
          id: "think-1" as TurnItemId,
          type: "reasoning",
          runId: "r1" as RunId,
          status: "running",
          startedAt: utc("2026-05-22T12:00:01.000Z"),
          completedAt: null,
        }),
      ],
      nowMs: NOW,
    });

    expect(trace!.turns[0]!.endMs).toBe(NOW);
    expect(trace!.turns[0]!.spans[0]!.kind).toBe("reasoning");
    expect(trace!.turns[0]!.spans[0]!.endMs).toBe(NOW);
  });

  it("excludes idle gaps between turns from activeMs", () => {
    const trace = deriveThreadTimingTrace({
      runs: [
        run({
          id: "r1",
          ordinal: 1,
          requestedAt: "2026-05-22T12:00:00.000Z",
          startedAt: "2026-05-22T12:00:00.000Z",
          completedAt: "2026-05-22T12:00:10.000Z",
        }),
        run({
          id: "r2",
          ordinal: 2,
          requestedAt: "2026-05-22T13:00:00.000Z",
          startedAt: "2026-05-22T13:00:00.000Z",
          completedAt: "2026-05-22T13:00:05.000Z",
        }),
      ],
      turnItems: [],
      nowMs: NOW,
    });

    expect(trace!.totalMs).toBe(3_605_000);
    expect(trace!.activeMs).toBe(15_000);
    expect(trace!.workMs).toBe(15_000);
    expect(trace!.queueWaitMs).toBe(0);
    expect(trace!.waitMs).toBe(0);
  });

  it("counts overlapping turns once in activeMs", () => {
    const trace = deriveThreadTimingTrace({
      runs: [
        run({
          id: "r1",
          ordinal: 1,
          requestedAt: "2026-05-22T12:00:00.000Z",
          startedAt: "2026-05-22T12:00:00.000Z",
          completedAt: "2026-05-22T12:00:10.000Z",
        }),
        run({
          id: "r2",
          ordinal: 2,
          requestedAt: "2026-05-22T12:00:05.000Z",
          startedAt: "2026-05-22T12:00:05.000Z",
          completedAt: "2026-05-22T12:00:15.000Z",
        }),
      ],
      turnItems: [],
      nowMs: NOW,
    });

    expect(trace!.totalMs).toBe(15_000);
    expect(trace!.activeMs).toBe(15_000);
    expect(trace!.workMs).toBe(20_000);
  });

  it("treats never-started runs as queued through endMs", () => {
    const trace = deriveThreadTimingTrace({
      runs: [
        run({
          id: "r1",
          ordinal: 1,
          status: "interrupted",
          requestedAt: "2026-05-22T12:00:00.000Z",
          startedAt: null,
          completedAt: "2026-05-22T12:00:08.000Z",
        }),
      ],
      turnItems: [],
      nowMs: NOW,
    });

    expect(trace!.turns[0]!.queueWaitMs).toBe(8_000);
    expect(trace!.turns[0]!.workMs).toBe(0);
    expect(trace!.turns[0]!.spans).toEqual([
      expect.objectContaining({
        kind: "queue",
        startMs: Date.parse("2026-05-22T12:00:00.000Z"),
        endMs: Date.parse("2026-05-22T12:00:08.000Z"),
        durationMs: 8_000,
      }),
    ]);
  });
});

describe("layoutThreadFlameChart", () => {
  it("puts turns on depth 0 and nests contained spans", () => {
    const trace = deriveThreadTimingTrace({
      runs: [
        run({
          id: "r1",
          ordinal: 1,
          requestedAt: "2026-05-22T12:00:00.000Z",
          startedAt: "2026-05-22T12:00:00.000Z",
          completedAt: "2026-05-22T12:00:20.000Z",
        }),
      ],
      turnItems: [
        item({
          id: "tasks-1" as TurnItemId,
          type: "todo_list",
          runId: "r1" as RunId,
          title: "Tasks",
          startedAt: utc("2026-05-22T12:00:01.000Z"),
          completedAt: utc("2026-05-22T12:00:19.000Z"),
        }),
        item({
          id: "tool-1" as TurnItemId,
          type: "command_execution",
          runId: "r1" as RunId,
          title: "npm test",
          startedAt: utc("2026-05-22T12:00:05.000Z"),
          completedAt: utc("2026-05-22T12:00:10.000Z"),
          input: "npm test",
        }),
      ],
      nowMs: NOW,
    });

    const layout = layoutThreadFlameChart(trace!);
    expect(layout.nodes.find((node) => node.kind === "turn")?.depth).toBe(0);
    expect(layout.nodes.find((node) => node.id === "tasks-1")?.depth).toBe(1);
    expect(layout.nodes.find((node) => node.id === "tool-1")?.depth).toBe(2);
    expect(layout.maxDepth).toBe(2);
  });

  it("gives partially overlapping equal-duration spans distinct depths", () => {
    const trace = deriveThreadTimingTrace({
      runs: [
        run({
          id: "r1",
          ordinal: 1,
          requestedAt: "2026-05-22T12:00:00.000Z",
          startedAt: "2026-05-22T12:00:00.000Z",
          completedAt: "2026-05-22T12:00:20.000Z",
        }),
      ],
      turnItems: [
        item({
          id: "tool-a" as TurnItemId,
          type: "command_execution",
          runId: "r1" as RunId,
          title: "a",
          startedAt: utc("2026-05-22T12:00:00.000Z"),
          completedAt: utc("2026-05-22T12:00:10.000Z"),
          input: "a",
        }),
        item({
          id: "tool-b" as TurnItemId,
          type: "command_execution",
          runId: "r1" as RunId,
          title: "b",
          startedAt: utc("2026-05-22T12:00:05.000Z"),
          completedAt: utc("2026-05-22T12:00:15.000Z"),
          input: "b",
        }),
      ],
      nowMs: NOW,
    });

    const layout = layoutThreadFlameChart(trace!);
    const depthA = layout.nodes.find((node) => node.id === "tool-a")?.depth;
    const depthB = layout.nodes.find((node) => node.id === "tool-b")?.depth;
    expect(depthA).toBeDefined();
    expect(depthB).toBeDefined();
    expect(depthA).not.toBe(depthB);
  });
});

describe("timing view window", () => {
  it("clamps and zooms around an anchor", () => {
    expect(clampTimingViewWindow(-100, 5_000, 0, 10_000)).toEqual({
      startMs: 0,
      durationMs: 5_000,
    });
    expect(timingViewZoomAt(0, 10_000, 0, 10_000, 5_000, 2)).toEqual({
      startMs: 2_500,
      durationMs: 5_000,
    });
  });
});

describe("buildCompressedTimingAxis", () => {
  it("collapses long idle between turns into a short break", () => {
    const axis = buildCompressedTimingAxis(
      [
        { ordinal: 1, requestedAtMs: 0, endMs: 10_000 },
        { ordinal: 2, requestedAtMs: 3_600_000, endMs: 3_610_000 },
      ],
      { collapseAboveMs: 5_000, breakDisplayMs: 1_000 },
    );

    expect(axis.breaks).toHaveLength(1);
    expect(axis.breaks[0]!.idleMs).toBe(3_590_000);
    expect(axis.breaks[0]!.displayEndMs - axis.breaks[0]!.displayStartMs).toBe(1_000);
    expect(axis.collapsedIdleMs).toBe(3_590_000);
    // 10s turn + 1s break + 10s turn
    expect(axis.displayTotalMs).toBe(21_000);
    expect(axis.realToDisplay(0)).toBe(0);
    expect(axis.realToDisplay(10_000)).toBe(10_000);
    expect(axis.realToDisplay(3_600_000)).toBe(11_000);
    expect(axis.realToDisplay(3_610_000)).toBe(21_000);
  });

  it("keeps short gaps uncompressed", () => {
    const axis = buildCompressedTimingAxis(
      [
        { ordinal: 1, requestedAtMs: 0, endMs: 5_000 },
        { ordinal: 2, requestedAtMs: 6_000, endMs: 8_000 },
      ],
      { collapseAboveMs: 5_000, breakDisplayMs: 1_000 },
    );

    expect(axis.breaks).toHaveLength(0);
    expect(axis.displayTotalMs).toBe(8_000);
    expect(axis.realToDisplay(6_000)).toBe(6_000);
  });

  it("does not double-count overlapping turns on the compressed axis", () => {
    const axis = buildCompressedTimingAxis(
      [
        { ordinal: 1, requestedAtMs: 0, endMs: 100 },
        { ordinal: 2, requestedAtMs: 50, endMs: 150 },
      ],
      { collapseAboveMs: 5_000, breakDisplayMs: 1_000 },
    );

    expect(axis.displayTotalMs).toBe(150);
    expect(axis.realToDisplay(0)).toBe(0);
    expect(axis.realToDisplay(100)).toBe(100);
    expect(axis.realToDisplay(150)).toBe(150);
    expect(axis.realToDisplay(50)).toBe(50);
  });
});
