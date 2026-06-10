import type { OrchestrationEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { isThreadDetailEvent } from "./threadDetailEvents.ts";

function eventOf(type: OrchestrationEvent["type"]): OrchestrationEvent {
  return { type } as OrchestrationEvent;
}

describe("isThreadDetailEvent", () => {
  it("includes queued-turn lifecycle events in live thread detail streams", () => {
    expect(isThreadDetailEvent(eventOf("thread.queued-turn-created"))).toBe(true);
    expect(isThreadDetailEvent(eventOf("thread.queued-turn-updated"))).toBe(true);
    expect(isThreadDetailEvent(eventOf("thread.queued-turn-deleted"))).toBe(true);
    expect(isThreadDetailEvent(eventOf("thread.queued-turn-dispatched"))).toBe(true);
    expect(isThreadDetailEvent(eventOf("thread.queued-turn-failed"))).toBe(true);
  });

  it("excludes events that belong to shell or unrelated streams", () => {
    expect(isThreadDetailEvent(eventOf("thread.deleted"))).toBe(false);
    expect(isThreadDetailEvent(eventOf("project.created"))).toBe(false);
  });
});
