import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  AntigravitySwarmNotification,
  agentAdvertisesAntigravitySwarm,
  makeAntigravitySwarmTracker,
} from "./AntigravitySwarm.ts";

describe("AntigravitySwarm", () => {
  it("detects advertised swarm capability on initialize responses", () => {
    expect(agentAdvertisesAntigravitySwarm({ _meta: { antigravity: { swarm: true } } })).toBe(true);
    expect(
      agentAdvertisesAntigravitySwarm({ _meta: { antigravity: { swarm: { enabled: true } } } }),
    ).toBe(true);
    expect(
      agentAdvertisesAntigravitySwarm({ _meta: { antigravity: { swarm: { enabled: false } } } }),
    ).toBe(false);
    expect(agentAdvertisesAntigravitySwarm({ _meta: { antigravity: { swarm: false } } })).toBe(
      false,
    );
    expect(agentAdvertisesAntigravitySwarm({ _meta: { antigravity: { tier: true } } })).toBe(false);
    expect(agentAdvertisesAntigravitySwarm(undefined)).toBe(false);
  });

  it("tracks multi-round worker lifecycles, board reports, helpers, and coordinator wakes", () => {
    const decode = Schema.decodeUnknownSync(AntigravitySwarmNotification);
    const tracker = makeAntigravitySwarmTracker();

    const launched = tracker.applyNotification(
      decode({
        sessionId: "root-1",
        title: "API Audit",
        head: 1,
        activeWorkers: 2,
        workingWorkers: 2,
        waitingWorkers: 0,
        members: [
          {
            name: "alpha",
            role: "worker",
            conversationId: "worker-a",
            toolCallId: "call-1",
            brief: "Audit auth routes",
            model: "model-pro",
            modelLabel: "Model Pro",
            state: "working",
            addedBy: "coordinator",
          },
          {
            name: "helper",
            role: "worker",
            conversationId: "worker-h",
            state: "working",
            addedBy: "alpha",
          },
        ],
        posts: [
          {
            seq: 1,
            agent: "alpha",
            kind: "brief",
            text: "@helper Check rate limiter config",
          },
        ],
      }),
    );

    expect(launched.activeBackgroundWork).toBe(true);
    expect(launched.subagents).toEqual([
      {
        nativeTaskId: "swarm:worker-a",
        childSessionId: "worker-a",
        title: "@alpha",
        prompt: "Audit auth routes",
        model: "Model Pro",
        status: "running",
        result: null,
        suppressNormalTool: true,
      },
      {
        nativeTaskId: "swarm:worker-h",
        childSessionId: "worker-h",
        title: "@helper via @alpha",
        prompt: "@helper Check rate limiter config",
        model: null,
        status: "running",
        result: null,
        suppressNormalTool: true,
      },
    ]);
    expect(
      tracker.partitionTaskIds("root-1", ["swarm:worker-a", "swarm:worker-h", "other-call"]),
    ).toEqual({
      runningSwarmTaskIds: ["swarm:worker-a", "swarm:worker-h"],
      unmanagedTaskIds: ["other-call"],
    });

    // Workers report and park while coordinator still has a pending doorbell wake.
    const handoff = tracker.applyNotification(
      decode({
        sessionId: "root-1",
        head: 3,
        activeWorkers: 0,
        workingWorkers: 0,
        waitingWorkers: 2,
        coordinatorPendingWake: true,
        members: [
          {
            name: "alpha",
            role: "worker",
            conversationId: "worker-a",
            state: "waiting",
          },
          {
            name: "helper",
            role: "worker",
            conversationId: "worker-h",
            state: "waiting",
          },
        ],
        posts: [
          { seq: 2, agent: "alpha", text: "@coordinator Auth routes look solid." },
          { seq: 3, agent: "helper", text: "@alpha Rate limiter uses token bucket." },
        ],
      }),
    );

    expect(handoff.activeBackgroundWork).toBe(true);
    expect(handoff.subagents[0]).toMatchObject({
      status: "idle",
      result: "Auth routes look solid.",
    });
    expect(handoff.subagents[1]).toMatchObject({
      status: "idle",
      result: "@alpha Rate limiter uses token bucket.",
    });
    expect(tracker.partitionTaskIds("root-1", ["swarm:worker-a", "swarm:worker-h"])).toEqual({
      runningSwarmTaskIds: [],
      unmanagedTaskIds: [],
    });

    // Coordinator processes wake, then wakes @alpha for round 2 while killing @helper cleanly.
    const round2 = tracker.applyNotification(
      decode({
        sessionId: "root-1",
        head: 4,
        activeWorkers: 1,
        workingWorkers: 1,
        waitingWorkers: 0,
        coordinatorPendingWake: false,
        members: [
          { name: "alpha", role: "worker", conversationId: "worker-a", state: "working" },
          { name: "helper", role: "worker", conversationId: "worker-h", state: "killed" },
        ],
      }),
    );

    expect(round2.activeBackgroundWork).toBe(true);
    expect(round2.subagents[0]).toMatchObject({ status: "running", result: null });
    expect(round2.subagents[1]).toMatchObject({
      status: "completed",
      result: "@alpha Rate limiter uses token bucket.",
    });

    // A never-reporting worker killed mid-turn maps to cancelled; a failed worker maps to failed.
    const terminal = tracker.applyNotification(
      decode({
        sessionId: "root-1",
        head: 4,
        activeWorkers: 0,
        workingWorkers: 0,
        waitingWorkers: 0,
        members: [
          {
            name: "alpha",
            role: "worker",
            conversationId: "worker-a",
            state: "failed",
            failure: "quota exhausted",
          },
          {
            name: "scratch",
            role: "narrator",
            conversationId: "worker-n",
            state: "killed",
          },
        ],
      }),
    );

    expect(terminal.activeBackgroundWork).toBe(false);
    expect(terminal.subagents[0]).toMatchObject({ status: "failed", result: "quota exhausted" });
    expect(terminal.subagents[1]).toMatchObject({
      title: "@scratch (narrator)",
      status: "cancelled",
      result: null,
    });
  });
});
