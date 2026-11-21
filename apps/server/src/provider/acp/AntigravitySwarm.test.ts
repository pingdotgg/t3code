import { acpPermissionDisposition } from "@t3tools/provider-acp/server/clientPolicy";
import { parsePermissionRequest } from "@t3tools/provider-acp/server/runtimeModel";
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

  it("tracks multi-round lifecycles, monitor exclusion, hadActivity, coordinatorWorking, and session cleanup", () => {
    const decode = Schema.decodeUnknownSync(AntigravitySwarmNotification);
    const tracker = makeAntigravitySwarmTracker();

    tracker.setSessionProtocol("root-1", true);
    expect(tracker.usesNativeProtocol("root-1")).toBe(true);
    expect(tracker.usesNativeProtocol("root-2")).toBe(false);

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
            workspaces: ["/tmp/fork-a", "/tmp/fork-b"],
            addedBy: "coordinator",
          },
          {
            name: "helper",
            role: "worker",
            conversationId: "worker-h",
            state: "working",
            addedBy: "alpha",
          },
          {
            name: "monitor",
            role: "worker",
            conversationId: "worker-m",
            state: "working",
          },
        ],
        posts: [
          {
            seq: 1,
            time: "2026-11-21T12:00:00Z",
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
        subagent: {
          nativeTaskId: "swarm:worker-a",
          childSessionId: "worker-a",
          title: "@alpha",
          prompt: "Audit auth routes",
          model: "Model Pro",
          status: "running",
          result: null,
          suppressNormalTool: true,
        },
        wakeContinuation: true,
      },
      {
        subagent: {
          nativeTaskId: "swarm:worker-h",
          childSessionId: "worker-h",
          title: "@helper via @alpha",
          prompt: "@helper Check rate limiter config",
          model: null,
          status: "running",
          result: null,
          suppressNormalTool: true,
        },
        wakeContinuation: true,
      },
      {
        subagent: {
          nativeTaskId: "swarm:worker-m",
          childSessionId: "worker-m",
          title: "@monitor (monitor)",
          prompt: "Swarm monitor @monitor",
          model: null,
          status: "running",
          result: null,
          suppressNormalTool: true,
        },
        wakeContinuation: false,
      },
    ]);
    expect(
      tracker.partitionTaskIds("root-1", [
        "swarm:worker-a",
        "swarm:worker-h",
        "swarm:worker-m",
        "other-call",
      ]),
    ).toEqual({
      runningSwarmTaskIds: ["swarm:worker-a", "swarm:worker-h"],
      unmanagedTaskIds: ["other-call"],
    });

    // Workers park while out-of-turn coordinator is actively synthesizing (`coordinatorWorking`).
    const handoff = tracker.applyNotification(
      decode({
        sessionId: "root-1",
        head: 4,
        activeWorkers: 0,
        workingWorkers: 0,
        waitingWorkers: 2,
        coordinatorWorking: true,
        coordinatorPendingWake: false,
        members: [
          { name: "alpha", role: "worker", conversationId: "worker-a", state: "waiting" },
          { name: "helper", role: "worker", conversationId: "worker-h", state: "waiting" },
          { name: "monitor", role: "monitor", conversationId: "worker-m", state: "working" },
        ],
        posts: [
          { seq: 2, agent: "alpha", text: "@coordinator Auth routes look solid." },
          { seq: 3, agent: "helper", text: "@alpha Rate limiter uses token bucket." },
          {
            seq: 4,
            agent: "monitor",
            text: "archived #old",
            control: { op: "archive", channel: "old" },
          },
        ],
      }),
    );

    expect(handoff.activeBackgroundWork).toBe(true);
    expect(handoff.subagents[0]?.subagent).toMatchObject({
      status: "idle",
      result: "Auth routes look solid.",
    });
    expect(handoff.subagents[1]?.subagent).toMatchObject({
      status: "idle",
      result: "@alpha Rate limiter uses token bucket.",
    });

    // Periodic @monitor tick alone does NOT mark the session busy; hadActivity marks killed workers completed.
    const settled = tracker.applyNotification(
      decode({
        sessionId: "root-1",
        head: 4,
        activeWorkers: 0,
        workingWorkers: 0,
        waitingWorkers: 0,
        coordinatorWorking: false,
        coordinatorPendingWake: false,
        members: [
          {
            name: "alpha",
            role: "worker",
            conversationId: "worker-a",
            state: "failed",
            failure: "quota exhausted",
          },
          {
            name: "helper",
            role: "worker",
            conversationId: "worker-h",
            state: "killed",
          },
          {
            name: "resumed-done",
            role: "worker",
            conversationId: "worker-r",
            state: "killed",
            hadActivity: true,
          },
          {
            name: "scratch",
            role: "narrator",
            conversationId: "worker-n",
            state: "killed",
          },
          {
            name: "monitor",
            role: "monitor",
            conversationId: "worker-m",
            state: "working",
          },
        ],
      }),
    );

    expect(settled.activeBackgroundWork).toBe(false);
    expect(settled.subagents[0]?.subagent).toMatchObject({
      status: "failed",
      result: "quota exhausted",
    });
    expect(settled.subagents[1]?.subagent).toMatchObject({
      status: "completed",
      result: "@alpha Rate limiter uses token bucket.",
    });
    expect(settled.subagents[2]?.subagent).toMatchObject({
      status: "completed",
      result: null,
    });
    expect(settled.subagents[3]?.subagent).toMatchObject({
      title: "@scratch (narrator)",
      status: "cancelled",
      result: null,
    });
    expect(settled.subagents[4]?.wakeContinuation).toBe(false);

    tracker.clearSession("root-1");
    expect(tracker.hasLiveSwarm("root-1")).toBe(false);
    expect(tracker.usesNativeProtocol("root-1")).toBe(false);
  });

  it("preserves worker attribution on command approvals and honors worker worktree roots in workspaceWrite", () => {
    const parsed = parsePermissionRequest({
      sessionId: "root-1",
      toolCall: {
        toolCallId: "worker-cmd-1",
        kind: "execute",
        title: "[@alpha] pnpm test",
        rawInput: { CommandLine: "pnpm test" },
      },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      _meta: {
        antigravity: {
          childSessionId: "worker-a",
          swarm: { workerSessionId: "worker-a", workerName: "alpha" },
        },
      },
    });
    expect(parsed.detail).toBe("[@alpha] pnpm test");

    // Falls back to toolCall._meta.antigravity when top-level _meta.antigravity lacks childSessionId.
    const fallbackParsed = parsePermissionRequest({
      sessionId: "root-1",
      _meta: { antigravity: {} },
      toolCall: {
        toolCallId: "worker-cmd-2",
        kind: "execute",
        title: "pnpm lint",
        rawInput: { CommandLine: "pnpm lint" },
        _meta: {
          antigravity: {
            childSessionId: "worker-a",
            swarm: { workerSessionId: "worker-a", workerName: "alpha" },
          },
        },
      },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    });
    expect(fallbackParsed.detail).toBe("[@alpha] pnpm lint");

    const baseRequest = {
      sessionId: "root-1",
      toolCall: {
        toolCallId: "worker-edit-1",
        kind: "edit" as const,
        title: "[@alpha] Edit /tmp/isolated-worktree/file.ts",
        locations: [{ path: "/tmp/isolated-worktree/file.ts" }],
      },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" as const }],
    };
    const policy = {
      runtimeMode: "full-access" as const,
      cwd: "/tmp/main-workspace",
      sandboxPolicy: { type: "workspaceWrite" },
    };
    const tracker = makeAntigravitySwarmTracker();
    const childWorktreeRequest = {
      ...baseRequest,
      _meta: {
        antigravity: {
          childSessionId: "worker-a",
          workspaces: ["/tmp/isolated-worktree", "/"],
        },
      },
    };
    // Untracked metadata roots never widen workspaceWrite.
    expect(acpPermissionDisposition(policy, baseRequest)).toBe("deny");
    expect(acpPermissionDisposition(policy, childWorktreeRequest)).toBe("deny");
    expect(
      acpPermissionDisposition(policy, childWorktreeRequest, {
        extraWritableRoots: tracker.childPermissionWorkspaces(childWorktreeRequest),
      }),
    ).toBe("deny");

    // Once the session records worker-a's worktree (while rejecting root "/" paths),
    // edits inside the tracked worktree are allowed and outside paths remain denied.
    tracker.applyNotification({
      sessionId: "root-1",
      head: 1,
      activeWorkers: 1,
      workingWorkers: 1,
      waitingWorkers: 0,
      members: [
        {
          name: "alpha",
          role: "worker",
          conversationId: "worker-a",
          workspaces: ["/tmp/isolated-worktree", "/"],
          state: "working",
        },
      ],
    });
    expect(tracker.childPermissionWorkspaces(childWorktreeRequest)).toEqual([
      "/tmp/isolated-worktree",
    ]);
    expect(
      acpPermissionDisposition(policy, childWorktreeRequest, {
        extraWritableRoots: tracker.childPermissionWorkspaces(childWorktreeRequest),
      }),
    ).toBe("allow");
    expect(
      acpPermissionDisposition(
        policy,
        {
          ...childWorktreeRequest,
          toolCall: {
            ...childWorktreeRequest.toolCall,
            locations: [{ path: "/tmp/other-dir/escape.ts" }],
          },
        },
        { extraWritableRoots: tracker.childPermissionWorkspaces(childWorktreeRequest) },
      ),
    ).toBe("deny");
  });
});
