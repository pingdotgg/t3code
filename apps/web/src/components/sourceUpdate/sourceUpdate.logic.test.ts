import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, type ServerSourceUpdateStatus, ThreadId } from "@t3tools/contracts";

import {
  canCancelSourceUpdate,
  canRunSourceUpdate,
  collectSourceUpdateMachines,
  resolveSourceUpdatePhase,
  SOURCE_UPDATE_GIVE_UP_MS,
  type SourceUpdatePhase,
  sourceUpdatePillLabel,
  sourceUpdateSummary,
  supportsSourceUpdate,
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
      "upstream alone is an update, since Update merges it",
      status({ upstreamAhead: 4, pullUpstreamUnavailableReason: "no Claude" }),
      null,
      null,
      1_000,
      { kind: "available", behindOrigin: 0, upstreamAhead: 4, unbuilt: 0 },
    ],
    [
      "nothing is offered where Update cannot run",
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

  it("points at the merge agent until upstream is merged into the checkout", () => {
    const conflictThreadId = ThreadId.make("merge-thread");
    const phase = (input: ServerSourceUpdateStatus) =>
      resolveSourceUpdatePhase({
        status: input,
        run: null,
        conflictThreadId,
        dismissedRunId: null,
        nowMs: 1_000,
      });
    expect(phase(status({ upstreamAhead: 2 }))).toEqual({
      kind: "resolving",
      threadId: conflictThreadId,
    });
    // The agent merged and pushed from the checkout; Update now builds it.
    expect(phase(status({ unbuiltCommits: 3 }))).toEqual({
      kind: "available",
      behindOrigin: 0,
      upstreamAhead: 0,
      unbuilt: 3,
    });
  });
});

describe("source update actions", () => {
  it.each([
    [{ kind: "idle" }, null, false],
    [
      { kind: "available", behindOrigin: 1, upstreamAhead: 2, unbuilt: 0 },
      "origin/main is 1 commit ahead · upstream/main is 2 commits ahead",
      true,
    ],
    [
      { kind: "available", behindOrigin: 0, upstreamAhead: 0, unbuilt: 2 },
      "2 commits not built",
      true,
    ],
    [{ kind: "resolving", threadId: ThreadId.make("t") }, null, true],
    [{ kind: "running", cancellable: true }, "Updating from source…", false],
    [{ kind: "succeeded", runId: "r", sha: "def5678", message: "" }, "Updated to def5678", false],
    [{ kind: "failed", runId: "r", message: "x" }, "Update failed: x", true],
  ] as const)("%j reads %s", (phase, summary, canUpdate) => {
    expect(sourceUpdateSummary(phase)).toBe(summary);
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

  it("swaps the Update action for every source-built environment, primary or remote", () => {
    const config = (sourceUpdate?: boolean) =>
      ({
        environment: { capabilities: sourceUpdate === undefined ? {} : { sourceUpdate } },
      }) as Parameters<typeof supportsSourceUpdate>[0];
    const configs = new Map([
      ["primary", config(true)],
      ["remote-fork", config(true)],
      ["remote-release", config()],
    ]);
    expect([...configs].filter(([, c]) => supportsSourceUpdate(c)).map(([id]) => id)).toEqual([
      "primary",
      "remote-fork",
    ]);
    expect(supportsSourceUpdate(undefined)).toBe(false);
  });
});

describe("sidebar source update pill", () => {
  const available = { kind: "available", behindOrigin: 1, upstreamAhead: 0, unbuilt: 0 } as const;
  const machines = (...phases: ReadonlyArray<readonly [string, SourceUpdatePhase]>) =>
    collectSourceUpdateMachines(
      phases.map(([label, phase]) => ({
        environmentId: EnvironmentId.make(label),
        label,
        status: status(),
        phase,
      })),
    );

  it("lists only environments with something to do or show", () => {
    const listed = machines(
      ["idle", { kind: "idle" }],
      ["done", { kind: "succeeded", runId: "r", sha: "abc", message: "" }],
      ["behind", available],
      ["running", { kind: "running", cancellable: true }],
      ["broken", { kind: "failed", runId: "r", message: "x" }],
      ["merging", { kind: "resolving", threadId: ThreadId.make("t") }],
    );
    expect(listed.map(({ label, canUpdate }) => [label, canUpdate])).toEqual([
      ["behind", true],
      ["running", false],
      ["broken", true],
      ["merging", true],
    ]);
  });

  it.each([
    [[], null],
    [[["idle", { kind: "idle" }]], null],
    [[["laptop", available]], "Update · laptop"],
    [
      [
        ["laptop", available],
        ["vps", available],
      ],
      "Update · 2 machines",
    ],
    [
      [
        ["laptop", available],
        ["vps", { kind: "running", cancellable: false }],
      ],
      "Updating…",
    ],
    [
      [
        ["vps", { kind: "running", cancellable: true }],
        ["laptop", { kind: "resolving", threadId: ThreadId.make("t") }],
      ],
      "Resolving conflicts…",
    ],
    [
      [
        ["laptop", { kind: "resolving", threadId: ThreadId.make("t") }],
        ["vps", { kind: "failed", runId: "r", message: "x" }],
      ],
      "Update failed",
    ],
  ] as const)("%j reads %s", (phases, label) => {
    expect(sourceUpdatePillLabel(machines(...phases))).toBe(label);
  });
});
