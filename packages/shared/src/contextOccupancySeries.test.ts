import { describe, expect, it } from "vite-plus/test";
import type { RunAttemptId, RunId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { deriveContextOccupancySeries } from "./contextOccupancySeries.ts";

function utc(iso: string) {
  return DateTime.makeUnsafe(iso);
}

describe("deriveContextOccupancySeries", () => {
  it("orders turn occupancy and compaction dips chronologically", () => {
    const series = deriveContextOccupancySeries({
      attempts: [{ id: "attempt-1" as RunAttemptId, runId: "run-1" as RunId }],
      providerTurns: [
        {
          runAttemptId: "attempt-1" as RunAttemptId,
          startedAt: utc("2026-05-22T12:00:00.000Z"),
          completedAt: utc("2026-05-22T12:00:10.000Z"),
          tokenUsage: {
            usedTokens: 40_000,
            maxTokens: 200_000,
            updatedAt: "2026-05-22T12:00:10.000Z",
          },
        },
        {
          runAttemptId: "attempt-1" as RunAttemptId,
          startedAt: utc("2026-05-22T12:01:00.000Z"),
          completedAt: utc("2026-05-22T12:01:20.000Z"),
          tokenUsage: {
            usedTokens: 90_000,
            maxTokens: 200_000,
            updatedAt: "2026-05-22T12:01:20.000Z",
          },
        },
      ],
      turnItems: [
        {
          type: "compaction",
          runId: "run-1" as RunId,
          startedAt: utc("2026-05-22T12:00:30.000Z"),
          completedAt: utc("2026-05-22T12:00:35.000Z"),
          updatedAt: utc("2026-05-22T12:00:35.000Z"),
          beforeTokenCount: 120_000,
          afterTokenCount: 25_000,
        },
      ],
    });

    expect(series.maxTokens).toBe(200_000);
    expect(series.peakUsedTokens).toBe(120_000);
    expect(series.points.map((point) => [point.kind, point.usedTokens, point.atMs])).toEqual([
      ["turn", 40_000, Date.parse("2026-05-22T12:00:10.000Z")],
      ["compaction-before", 120_000, Date.parse("2026-05-22T12:00:30.000Z")],
      ["compaction-after", 25_000, Date.parse("2026-05-22T12:00:35.000Z")],
      ["turn", 90_000, Date.parse("2026-05-22T12:01:20.000Z")],
    ]);
    expect(series.points.every((point) => point.runId === ("run-1" as RunId))).toBe(true);
  });

  it("nudges compaction-after when before and after share a timestamp", () => {
    const at = utc("2026-05-22T12:00:30.000Z");
    const series = deriveContextOccupancySeries({
      attempts: [],
      providerTurns: [],
      turnItems: [
        {
          type: "compaction",
          runId: "run-2" as RunId,
          startedAt: at,
          completedAt: at,
          updatedAt: at,
          beforeTokenCount: 80_000,
          afterTokenCount: 10_000,
        },
      ],
    });

    expect(series.points).toHaveLength(2);
    expect(series.points[0]?.kind).toBe("compaction-before");
    expect(series.points[1]?.kind).toBe("compaction-after");
    expect(series.points[1]?.atMs).toBe((series.points[0]?.atMs ?? 0) + 1);
  });

  it("skips turns without tokenUsage and non-compaction items", () => {
    const series = deriveContextOccupancySeries({
      attempts: [{ id: "attempt-1" as RunAttemptId, runId: "run-1" as RunId }],
      providerTurns: [
        {
          runAttemptId: "attempt-1" as RunAttemptId,
          startedAt: utc("2026-05-22T12:00:00.000Z"),
          completedAt: utc("2026-05-22T12:00:10.000Z"),
        },
      ],
      turnItems: [
        {
          type: "assistant_message",
          runId: "run-1" as RunId,
          startedAt: utc("2026-05-22T12:00:01.000Z"),
          completedAt: utc("2026-05-22T12:00:05.000Z"),
          updatedAt: utc("2026-05-22T12:00:05.000Z"),
        },
        {
          type: "compaction",
          runId: "run-1" as RunId,
          startedAt: utc("2026-05-22T12:00:08.000Z"),
          completedAt: utc("2026-05-22T12:00:09.000Z"),
          updatedAt: utc("2026-05-22T12:00:09.000Z"),
        },
      ],
    });

    expect(series.points).toEqual([]);
    expect(series.maxTokens).toBeNull();
    expect(series.peakUsedTokens).toBe(0);
  });

  it("falls back to turn completedAt when usage.updatedAt is missing", () => {
    const series = deriveContextOccupancySeries({
      attempts: [{ id: "attempt-1" as RunAttemptId, runId: "run-3" as RunId }],
      providerTurns: [
        {
          runAttemptId: "attempt-1" as RunAttemptId,
          startedAt: utc("2026-05-22T12:00:00.000Z"),
          completedAt: utc("2026-05-22T12:00:12.000Z"),
          tokenUsage: {
            usedTokens: 1_000,
            maxTokens: null,
            updatedAt: "",
          },
        },
      ],
      turnItems: [],
    });

    expect(series.points).toEqual([
      {
        atMs: Date.parse("2026-05-22T12:00:12.000Z"),
        usedTokens: 1_000,
        maxTokens: null,
        kind: "turn",
        runId: "run-3" as RunId,
      },
    ]);
  });
});
