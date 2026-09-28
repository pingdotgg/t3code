import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { classifyTaskAgentKind, ProviderRuntimeEvent } from "./providerRuntime.ts";

const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);

describe("ProviderRuntimeEvent", () => {
  it("requires input and output totals for complete turn usage", () => {
    const completeEvent = {
      type: "turn.completed",
      eventId: "event-complete-usage",
      provider: "codex",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        state: "completed",
        tokenUsage: {
          usageStatus: "complete",
          usageScope: "main_agent",
          hasSubagents: false,
        },
      },
    };

    expect(() => decodeRuntimeEvent(completeEvent)).toThrow();
    expect(
      decodeRuntimeEvent({
        ...completeEvent,
        payload: {
          ...completeEvent.payload,
          tokenUsage: {
            ...completeEvent.payload.tokenUsage,
            inputTokens: 10,
            outputTokens: 2,
          },
        },
      }).type,
    ).toBe("turn.completed");
    expect(
      decodeRuntimeEvent({
        ...completeEvent,
        payload: {
          ...completeEvent.payload,
          tokenUsage: {
            ...completeEvent.payload.tokenUsage,
            usageStatus: "partial",
          },
        },
      }).type,
    ).toBe("turn.completed");
  });

  it("accepts fork-provided driver kinds as branded slugs", () => {
    const parsed = decodeRuntimeEvent({
      type: "session.started",
      eventId: "event-ollama-session",
      provider: "ollama",
      providerInstanceId: "ollama_local",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      payload: {
        message: "started",
      },
    });

    expect(parsed.provider).toBe("ollama");
    expect(parsed.providerInstanceId).toBe("ollama_local");
  });

  it("rejects empty branded canonical ids", () => {
    expect(() =>
      decodeRuntimeEvent({
        type: "runtime.error",
        eventId: "event-5",
        provider: "codex",
        sessionId: "runtime-session-3",
        createdAt: "2026-02-28T00:00:03.000Z",
        threadId: "   ",
        payload: { message: "boom" },
      }),
    ).toThrow();
  });
});

describe("classifyTaskAgentKind", () => {
  it("classifies agent-flavored, watch-loop, and inert types", () => {
    expect(classifyTaskAgentKind({ taskType: "local_agent" })).toBe("agent");
    expect(classifyTaskAgentKind({ taskType: "local_workflow" })).toBe("agent");
    expect(classifyTaskAgentKind({ taskType: undefined })).toBe("agent");
    expect(classifyTaskAgentKind({ taskType: "brand_new_agent_type" })).toBe("agent");
    expect(classifyTaskAgentKind({ taskType: "local_bash" })).toBe("background");
    expect(classifyTaskAgentKind({ taskType: "monitor" })).toBe("background");
    expect(classifyTaskAgentKind({ taskType: "plan" })).toBe("background");
  });

  it("agent-owned tasks are background unless themselves agent-flavored", () => {
    expect(classifyTaskAgentKind({ taskType: "local_bash", agentId: "owner" })).toBe("background");
    expect(classifyTaskAgentKind({ taskType: undefined, agentId: "owner" })).toBe("background");
    // Nested agent: outlives its parent, stays in the roster.
    expect(classifyTaskAgentKind({ taskType: "local_agent", agentId: "owner" })).toBe("agent");
  });
});
