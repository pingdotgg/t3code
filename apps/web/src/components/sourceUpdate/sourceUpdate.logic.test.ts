import { describe, expect, it } from "vite-plus/test";
import type { ServerSourceUpdateStatus } from "@t3tools/contracts";

import {
  canPullUpstream,
  canRunSourceUpdate,
  resolveSourceUpdatePhase,
  sourceUpdatePillLabel,
} from "./sourceUpdate.logic";

const status = (overrides: Partial<ServerSourceUpdateStatus> = {}): ServerSourceUpdateStatus => ({
  head: { sha: "abc1234", subject: "feat: thing" },
  behindOrigin: 0,
  upstreamAhead: 0,
  fetchedAt: "2026-11-14T10:00:00.000Z",
  updateRunning: false,
  lastResult: null,
  ...overrides,
});

const earlier = {
  outcome: "succeeded",
  finishedAt: "2026-11-13T10:00:00.000Z",
  message: "Updated to 1111111 old",
} as const;

describe("resolveSourceUpdatePhase", () => {
  it.each([
    ["nothing new", status(), null, { kind: "idle" }],
    ["no status yet", null, null, { kind: "idle" }],
    [
      "origin ahead",
      status({ behindOrigin: 3, upstreamAhead: 2 }),
      null,
      { kind: "available", behindOrigin: 3, upstreamAhead: 2 },
    ],
    [
      "missing remote counts as none",
      status({ behindOrigin: null, upstreamAhead: 4 }),
      null,
      { kind: "available", behindOrigin: 0, upstreamAhead: 4 },
    ],
    [
      "another client's update",
      status({ updateRunning: true, behindOrigin: 3 }),
      null,
      { kind: "running" },
    ],
    [
      "an old result never reads as this run's outcome",
      status({ behindOrigin: 3, lastResult: earlier }),
      { previousResultFinishedAt: earlier.finishedAt },
      { kind: "running" },
    ],
    [
      "reconnecting after the restart",
      null,
      { previousResultFinishedAt: earlier.finishedAt },
      { kind: "running" },
    ],
    [
      "the unit died before writing a result",
      status({ lastResult: null }),
      { previousResultFinishedAt: earlier.finishedAt },
      { kind: "failed", message: "The update stopped without reporting a result." },
    ],
    [
      "the unit is still writing its result",
      status({
        updateRunning: true,
        lastResult: { ...earlier, finishedAt: "2026-11-14T11:00:00.000Z" },
      }),
      { previousResultFinishedAt: earlier.finishedAt },
      { kind: "running" },
    ],
    [
      "first update ever succeeds",
      status({
        head: { sha: "def5678", subject: "new" },
        lastResult: { ...earlier, finishedAt: "2026-11-14T11:00:00.000Z" },
      }),
      { previousResultFinishedAt: null },
      { kind: "succeeded", sha: "def5678" },
    ],
    [
      "a new failure",
      status({
        behindOrigin: 3,
        lastResult: {
          outcome: "failed",
          finishedAt: "2026-11-14T11:00:00.000Z",
          message: "The checkout has uncommitted changes.",
        },
      }),
      { previousResultFinishedAt: earlier.finishedAt },
      { kind: "failed", message: "The checkout has uncommitted changes." },
    ],
  ] as const)("%s", (_name, input, run, expected) => {
    expect(resolveSourceUpdatePhase(input, run)).toEqual(expected);
  });
});

describe("source update actions", () => {
  it.each([
    [{ kind: "idle" }, null, false],
    [{ kind: "available", behindOrigin: 1, upstreamAhead: 0 }, "Update · 1 new commit", true],
    [{ kind: "available", behindOrigin: 0, upstreamAhead: 5 }, "Upstream · 5 new commits", false],
    [{ kind: "running" }, "Updating…", false],
    [{ kind: "succeeded", sha: "def5678" }, "Updated · def5678", false],
    [{ kind: "failed", message: "x" }, "Update failed", true],
  ] as const)("%j labels %s", (phase, label, canUpdate) => {
    expect(sourceUpdatePillLabel(phase)).toBe(label);
    expect(canRunSourceUpdate(phase)).toBe(canUpdate);
  });

  it("offers Pull upstream only while no update runs", () => {
    const ahead = status({ upstreamAhead: 2 });
    expect(canPullUpstream(ahead, resolveSourceUpdatePhase(ahead, null))).toBe(true);
    expect(canPullUpstream(ahead, { kind: "running" })).toBe(false);
    expect(canPullUpstream(status(), { kind: "idle" })).toBe(false);
  });
});
