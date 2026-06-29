import { describe, expect, it } from "vite-plus/test";

import {
  canDetachThreadProviderSession,
  canForkProjectedAssistantItem,
  deriveThreadQueueWorkflowState,
} from "./threadWorkflows.ts";

const capabilities = (input?: {
  readonly queued?: boolean;
  readonly steer?: boolean;
  readonly restartSteer?: boolean;
  readonly nativeFork?: boolean;
  readonly portableFork?: boolean;
}) =>
  ({
    turns: {
      supportsQueuedMessages: input?.queued ?? false,
      supportsActiveSteering: input?.steer ?? false,
      supportsSteeringByInterruptRestart: input?.restartSteer ?? false,
    },
    threads: {
      canForkThread: input?.nativeFork ?? false,
      canForkFromTurn: input?.nativeFork ?? false,
    },
    identity: { nativeThreadIds: input?.nativeFork ? "strong" : "none" },
    context: { supportsFullThreadHandoff: input?.portableFork ?? false },
  }) as never;

describe("thread workflows", () => {
  it("sorts queued messages and gates reorder and promotion from capabilities", () => {
    const state = deriveThreadQueueWorkflowState({
      thread: { id: "thread", activeProviderThreadId: "provider-thread" },
      runs: [
        { id: "active", status: "running", providerThreadId: "provider-thread", ordinal: 1 },
        { id: "later", status: "queued", userMessageId: "message-later", ordinal: 3 },
        {
          id: "first",
          status: "queued",
          userMessageId: "message-first",
          ordinal: 2,
          queuePosition: 1,
        },
      ],
      messages: [
        { id: "message-first", text: "First" },
        { id: "message-later", text: "Later" },
      ],
      providerThreads: [
        {
          id: "provider-thread",
          appThreadId: "thread",
          providerSessionId: "provider-session",
        },
      ],
      providerSessions: [
        {
          id: "provider-session",
          status: "running",
          capabilities: capabilities({ queued: true, restartSteer: true }),
        },
      ],
    } as never);

    expect(state.queuedRuns.map(({ run, text }) => [run.id, text])).toEqual([
      ["first", "First"],
      ["later", "Later"],
    ]);
    expect(state.activeRun?.id).toBe("active");
    expect(state.canReorder).toBe(true);
    expect(state.canPromoteToSteer).toBe(true);
  });

  it("does not expose known unsupported queue or fork actions", () => {
    const projection = {
      thread: { id: "thread", activeProviderThreadId: "provider-thread" },
      runs: [{ id: "queued", status: "queued", userMessageId: "message", ordinal: 1 }],
      messages: [],
      providerThreads: [
        {
          id: "provider-thread",
          appThreadId: "thread",
          providerSessionId: "provider-session",
        },
      ],
      providerSessions: [
        {
          id: "provider-session",
          status: "ready",
          capabilities: capabilities(),
        },
      ],
    } as never;
    const queue = deriveThreadQueueWorkflowState(projection);
    const projectedItem = {
      item: { type: "assistant_message", runId: "run", status: "completed" },
    } as never;

    expect(queue.canReorder).toBe(false);
    expect(queue.canPromoteToSteer).toBe(false);
    expect(canForkProjectedAssistantItem({ projectedItem, capabilities: capabilities() })).toBe(
      false,
    );
    expect(canDetachThreadProviderSession(projection)).toBe(true);
  });

  it("allows native, portable, and capability-unknown exact-run forks", () => {
    const projectedItem = {
      item: { type: "assistant_message", runId: "run", status: "completed" },
    } as never;

    expect(
      canForkProjectedAssistantItem({
        projectedItem,
        capabilities: capabilities({ nativeFork: true }),
      }),
    ).toBe(true);
    expect(
      canForkProjectedAssistantItem({
        projectedItem,
        capabilities: capabilities({ portableFork: true }),
      }),
    ).toBe(true);
    expect(canForkProjectedAssistantItem({ projectedItem })).toBe(true);
    expect(
      canForkProjectedAssistantItem({
        projectedItem: {
          item: { type: "assistant_message", runId: "run", status: "running" },
        } as never,
      }),
    ).toBe(false);
  });
});
