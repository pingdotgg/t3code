import { ThreadId, type WorktreeSetupSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveVisibleWorktreeSetup } from "./worktreeSetup.ts";

const done = (stageIds: ReadonlyArray<"checkout" | "agent">): WorktreeSetupSnapshot => ({
  threadId: ThreadId.make("thread"),
  phase: "done",
  startedAt: "2026-11-24T00:00:00.000Z",
  endedAt: "2026-11-24T00:00:05.000Z",
  branch: null,
  baseRef: null,
  worktreePath: "/home/user/worktrees/app",
  setupScript: null,
  stages: stageIds.map((id) => ({
    id,
    status: "done",
    startedAt: null,
    endedAt: null,
    percent: null,
    detail: null,
    tail: [],
  })),
  error: null,
  sequence: 1,
});

describe("resolveVisibleWorktreeSetup", () => {
  it("keeps a finished setup in view until the agent's run starts", () => {
    const snapshot = done(["checkout", "agent"]);
    expect(
      resolveVisibleWorktreeSetup({
        live: snapshot,
        recorded: null,
        runs: [],
        followUpSent: false,
      }),
    ).toBe(snapshot);
  });

  it("drops a finished setup that hands off to no run, such as a moved thread's", () => {
    expect(
      resolveVisibleWorktreeSetup({
        live: done(["checkout"]),
        recorded: null,
        runs: [],
        followUpSent: false,
      }),
    ).toBeNull();
  });
});
