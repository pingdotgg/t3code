import { describe, expect, it } from "vitest";
import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import { EventId, ThreadId, TurnId } from "@t3tools/contracts";
import { mapCodexProviderRuntimeEventToHarnessEvents } from "./codex";

describe("mapCodexProviderRuntimeEventToHarnessEvents", () => {
  it("maps plan and elicitation flows into canonical harness events", () => {
    const planEvent = {
      type: "turn.plan.updated",
      eventId: EventId.makeUnsafe("evt-plan"),
      provider: "codex",
      threadId: ThreadId.makeUnsafe("thread-1"),
      createdAt: "2026-03-09T00:00:00.000Z",
      turnId: TurnId.makeUnsafe("turn-1"),
      payload: {
        explanation: "Thinking through the steps",
        plan: [{ step: "Inspect repo", status: "completed" }],
      },
    } as unknown as ProviderRuntimeEvent;

    const mapped = mapCodexProviderRuntimeEventToHarnessEvents(planEvent);
    expect(mapped[0]?.type).toBe("plan.updated");
    if (mapped[0]?.type === "plan.updated") {
      expect(mapped[0].payload.steps[0]?.status).toBe("completed");
    }
  });

  it("maps runtime request events into canonical permissions", () => {
    const requestEvent = {
      type: "request.opened",
      eventId: EventId.makeUnsafe("evt-permission"),
      provider: "codex",
      threadId: ThreadId.makeUnsafe("thread-1"),
      createdAt: "2026-03-09T00:00:00.000Z",
      payload: {
        requestType: "exec_command_approval",
        detail: "Run bun lint",
      },
      requestId: "req-1",
    } as unknown as ProviderRuntimeEvent;

    const mapped = mapCodexProviderRuntimeEventToHarnessEvents(requestEvent);
    expect(mapped[0]?.type).toBe("permission.requested");
  });
});
