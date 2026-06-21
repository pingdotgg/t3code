import { describe, expect, it } from "vite-plus/test";

import {
  parseCodexRuntimeUsageLimits,
  resolveCodexRateLimitSnapshotUsageLimits,
} from "./codexUsageProbe.ts";

const CHECKED_AT = "2026-06-20T00:00:00.000Z";
// 1776448800 epoch seconds -> 2026-04-17T18:00:00.000Z
const PRIMARY_RESETS_AT_SECONDS = 1776448800;
const PRIMARY_RESETS_AT_ISO = "2026-04-17T18:00:00.000Z";

describe("codexUsageProbe", () => {
  describe("resolveCodexRateLimitSnapshotUsageLimits", () => {
    it("builds session and weekly windows from a full snapshot", () => {
      const usage = resolveCodexRateLimitSnapshotUsageLimits({
        checkedAt: CHECKED_AT,
        snapshot: {
          primary: {
            usedPercent: 25,
            resetsAt: PRIMARY_RESETS_AT_SECONDS,
            windowDurationMins: 300,
          },
          secondary: {
            usedPercent: 50,
            resetsAt: PRIMARY_RESETS_AT_SECONDS,
            windowDurationMins: 10080,
          },
        },
      });

      expect(usage).toEqual({
        source: "codexAppServer",
        available: true,
        checkedAt: CHECKED_AT,
        windows: [
          {
            kind: "session",
            label: "Session",
            usedPercent: 25,
            windowDurationMins: 300,
            resetsAt: PRIMARY_RESETS_AT_ISO,
          },
          {
            kind: "weekly",
            label: "Weekly",
            usedPercent: 50,
            windowDurationMins: 10080,
            resetsAt: PRIMARY_RESETS_AT_ISO,
          },
        ],
      });
    });

    it("applies fallback window durations when the snapshot omits them", () => {
      const usage = resolveCodexRateLimitSnapshotUsageLimits({
        checkedAt: CHECKED_AT,
        snapshot: {
          primary: { usedPercent: 25 },
          secondary: { usedPercent: 50 },
        },
      });

      expect(usage?.available).toBe(true);
      expect(usage?.windows).toEqual([
        {
          kind: "session",
          label: "Session",
          usedPercent: 25,
          windowDurationMins: 300,
        },
        {
          kind: "weekly",
          label: "Weekly",
          usedPercent: 50,
          windowDurationMins: 10080,
        },
      ]);
    });

    it("builds a session-only snapshot when only the primary window is present", () => {
      const usage = resolveCodexRateLimitSnapshotUsageLimits({
        checkedAt: CHECKED_AT,
        snapshot: {
          primary: { usedPercent: 70, windowDurationMins: 300 },
        },
      });

      expect(usage?.windows).toEqual([
        {
          kind: "session",
          label: "Session",
          usedPercent: 70,
          windowDurationMins: 300,
        },
      ]);
    });

    it("returns unavailable when the snapshot is missing", () => {
      expect(
        resolveCodexRateLimitSnapshotUsageLimits({
          checkedAt: CHECKED_AT,
        }),
      ).toEqual({
        source: "codexAppServer",
        available: false,
        reason: "No Codex subscription quota windows reported.",
        checkedAt: CHECKED_AT,
        windows: [],
      });
    });

    it("returns unavailable when the snapshot is null", () => {
      expect(
        resolveCodexRateLimitSnapshotUsageLimits({
          checkedAt: CHECKED_AT,
          snapshot: null,
        }),
      ).toEqual({
        source: "codexAppServer",
        available: false,
        reason: "No Codex subscription quota windows reported.",
        checkedAt: CHECKED_AT,
        windows: [],
      });
    });
  });

  describe("parseCodexRuntimeUsageLimits", () => {
    it("parses a nested rateLimits payload (account/rateLimits/updated shape)", () => {
      const usage = parseCodexRuntimeUsageLimits({
        checkedAt: CHECKED_AT,
        rateLimits: {
          rateLimits: {
            primary: { usedPercent: 25, windowDurationMins: 300 },
            secondary: { usedPercent: 50, windowDurationMins: 10080 },
          },
        },
      });

      expect(usage?.available).toBe(true);
      expect(usage?.source).toBe("codexAppServer");
      expect(usage?.windows).toEqual([
        {
          kind: "session",
          label: "Session",
          usedPercent: 25,
          windowDurationMins: 300,
        },
        {
          kind: "weekly",
          label: "Weekly",
          usedPercent: 50,
          windowDurationMins: 10080,
        },
      ]);
    });

    it("parses a bare snapshot payload (account/rateLimits/read shape)", () => {
      const usage = parseCodexRuntimeUsageLimits({
        checkedAt: CHECKED_AT,
        rateLimits: {
          primary: { usedPercent: 33, windowDurationMins: 300 },
        },
      });

      expect(usage?.available).toBe(true);
      expect(usage?.windows).toEqual([
        {
          kind: "session",
          label: "Session",
          usedPercent: 33,
          windowDurationMins: 300,
        },
      ]);
    });

    it("returns undefined when the payload carries no usable windows", () => {
      expect(
        parseCodexRuntimeUsageLimits({
          checkedAt: CHECKED_AT,
          rateLimits: {},
        }),
      ).toBeUndefined();
    });

    it("returns undefined when the payload is not an object", () => {
      expect(
        parseCodexRuntimeUsageLimits({
          checkedAt: CHECKED_AT,
          rateLimits: null,
        }),
      ).toBeUndefined();
    });

    it("returns undefined when the nested snapshot has no usable windows", () => {
      expect(
        parseCodexRuntimeUsageLimits({
          checkedAt: CHECKED_AT,
          rateLimits: {
            rateLimits: {
              primary: { windowDurationMins: 300 },
            },
          },
        }),
      ).toBeUndefined();
    });

    it("clamps out-of-range percentages", () => {
      const usage = parseCodexRuntimeUsageLimits({
        checkedAt: CHECKED_AT,
        rateLimits: {
          primary: { usedPercent: 250, windowDurationMins: 300 },
        },
      });

      expect(usage?.windows?.[0]?.usedPercent).toBe(100);
    });
  });
});
