import { describe, expect, it } from "vite-plus/test";
import type { ServerSourceUpdateStatus } from "@t3tools/contracts";

import {
  canCancelSourceUpdate,
  canPullUpstream,
  canRunSourceUpdate,
  resolveSourceUpdatePhase,
  SOURCE_UPDATE_GIVE_UP_MS,
  sourceUpdatePillLabel,
} from "./sourceUpdate.logic";

const status = (overrides: Partial<ServerSourceUpdateStatus> = {}): ServerSourceUpdateStatus => ({
  head: { sha: "abc1234", subject: "feat: thing" },
  behindOrigin: 0,
  upstreamAhead: 0,
  unbuiltCommits: 0,
  fetchedAt: "2026-11-14T10:00:00.000Z",
  updateRunning: false,
  lastRunId: null,
  lastResult: null,
  updateUnavailableReason: null,
  pullUpstreamUnavailableReason: null,
  ...overrides,
});

const settled = (
  runId: string,
  outcome: "succeeded" | "failed",
  message: string,
): Partial<ServerSourceUpdateStatus> => ({
  lastRunId: runId,
  lastResult: { runId, outcome, finishedAt: "2026-11-13T10:00:00.000Z", message },
});

const run = { runId: "mine", startedAtMs: 1_000 };

describe("resolveSourceUpdatePhase", () => {
  it.each([
    ["nothing new", status(), null, null, 1_000, { kind: "idle" }],
    ["no status yet", null, null, null, 1_000, { kind: "idle" }],
    [
      "origin ahead",
      status({ behindOrigin: 3, upstreamAhead: 2 }),
      null,
      null,
      1_000,
      { kind: "available", behindOrigin: 3, upstreamAhead: 2, unbuilt: 0 },
    ],
    [
      "the checkout moved past the running build",
      status({ unbuiltCommits: 2 }),
      null,
      null,
      1_000,
      { kind: "available", behindOrigin: 0, upstreamAhead: 0, unbuilt: 2 },
    ],
    [
      "missing remote counts as none",
      status({ behindOrigin: null, upstreamAhead: 4 }),
      null,
      null,
      1_000,
      { kind: "available", behindOrigin: 0, upstreamAhead: 4, unbuilt: 0 },
    ],
    [
      "actions the server cannot run are not offered",
      status({
        behindOrigin: 3,
        upstreamAhead: 2,
        unbuiltCommits: 2,
        updateUnavailableReason: "no systemd",
        pullUpstreamUnavailableReason: "no Claude",
      }),
      null,
      null,
      1_000,
      { kind: "idle" },
    ],
    [
      "another client's update",
      status({ updateRunning: true, behindOrigin: 3 }),
      null,
      null,
      1_000,
      { kind: "running", cancellable: true },
    ],
    [
      "the first update ever, before the status refreshes",
      status({ behindOrigin: 3 }),
      run,
      null,
      1_000,
      { kind: "running", cancellable: false },
    ],
    [
      "an older run's result never reads as this run's outcome",
      status({ behindOrigin: 3, ...settled("older", "succeeded", "Updated to 1111111 old") }),
      run,
      null,
      1_000,
      { kind: "running", cancellable: false },
    ],
    [
      "reconnecting after the restart",
      null,
      run,
      null,
      1_000,
      { kind: "running", cancellable: false },
    ],
    [
      "the server never came back",
      null,
      run,
      null,
      run.startedAtMs + SOURCE_UPDATE_GIVE_UP_MS,
      {
        kind: "failed",
        runId: "mine",
        message:
          "The update never reported back; the server may not have restarted. Check its log.",
      },
    ],
    [
      "a stale running status past the server's limit",
      status({ updateRunning: true }),
      run,
      null,
      run.startedAtMs + SOURCE_UPDATE_GIVE_UP_MS,
      {
        kind: "failed",
        runId: "mine",
        message:
          "The update never reported back; the server may not have restarted. Check its log.",
      },
    ],
    [
      "the unit died before writing a result",
      status({ lastRunId: "mine" }),
      run,
      null,
      1_000,
      { kind: "failed", runId: "mine", message: "The update stopped without reporting a result." },
    ],
    [
      "this run succeeds",
      status({
        head: { sha: "def5678", subject: "new" },
        ...settled("mine", "succeeded", "Updated to def5678 new"),
      }),
      run,
      null,
      1_000,
      { kind: "succeeded", runId: "mine", sha: "def5678", message: "Updated to def5678 new" },
    ],
    [
      "this run fails",
      status({ behindOrigin: 3, ...settled("mine", "failed", "Uncommitted changes.") }),
      run,
      null,
      1_000,
      { kind: "failed", runId: "mine", message: "Uncommitted changes." },
    ],
    [
      "a run another client or an earlier page started",
      status({ ...settled("theirs", "succeeded", "Updated to abc1234 x") }),
      null,
      null,
      1_000,
      { kind: "succeeded", runId: "theirs", sha: "abc1234", message: "Updated to abc1234 x" },
    ],
    [
      "a dismissed outcome",
      status({ behindOrigin: 1, ...settled("theirs", "failed", "Broke") }),
      null,
      "theirs",
      1_000,
      { kind: "available", behindOrigin: 1, upstreamAhead: 0, unbuilt: 0 },
    ],
  ] as const)("%s", (_name, input, current, dismissedRunId, nowMs, expected) => {
    expect(
      resolveSourceUpdatePhase({ status: input, run: current, dismissedRunId, nowMs }),
    ).toEqual(expected);
  });
});

describe("source update actions", () => {
  it.each([
    [{ kind: "idle" }, null, false],
    [
      { kind: "available", behindOrigin: 1, upstreamAhead: 0, unbuilt: 0 },
      "Update · 1 new commit",
      true,
    ],
    [
      { kind: "available", behindOrigin: 0, upstreamAhead: 5, unbuilt: 0 },
      "Upstream · 5 new commits",
      false,
    ],
    [
      { kind: "available", behindOrigin: 0, upstreamAhead: 0, unbuilt: 2 },
      "Rebuild · 2 commits not built",
      true,
    ],
    [{ kind: "running", cancellable: true }, "Updating…", false],
    [{ kind: "succeeded", runId: "r", sha: "def5678", message: "" }, "Updated · def5678", false],
    [{ kind: "failed", runId: "r", message: "x" }, "Update failed", true],
  ] as const)("%j labels %s", (phase, label, canUpdate) => {
    expect(sourceUpdatePillLabel(phase)).toBe(label);
    expect(canRunSourceUpdate(status(), phase)).toBe(canUpdate);
  });

  it("offers Update only where the server can run it", () => {
    const phase = { kind: "failed", runId: "r", message: "x" } as const;
    expect(canRunSourceUpdate(status({ updateUnavailableReason: "no systemd" }), phase)).toBe(
      false,
    );
  });

  it("offers Cancel once the server confirms the run", () => {
    expect(canCancelSourceUpdate({ kind: "running", cancellable: true })).toBe(true);
    expect(canCancelSourceUpdate({ kind: "running", cancellable: false })).toBe(false);
  });

  it("offers Pull upstream only while no update runs and Claude can run it", () => {
    const ahead = status({ upstreamAhead: 2 });
    const phase = resolveSourceUpdatePhase({
      status: ahead,
      run: null,
      dismissedRunId: null,
      nowMs: 0,
    });
    expect(canPullUpstream(ahead, phase)).toBe(true);
    expect(canPullUpstream(ahead, { kind: "running", cancellable: true })).toBe(false);
    expect(canPullUpstream(status(), { kind: "idle" })).toBe(false);
    expect(
      canPullUpstream(status({ upstreamAhead: 2, pullUpstreamUnavailableReason: "x" }), phase),
    ).toBe(false);
  });
});
