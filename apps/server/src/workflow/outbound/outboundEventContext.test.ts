import type { OutboundTrigger } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import {
  OUTBOUND_EVENT_TYPES,
  buildOutboundContext,
  contextForRule,
  matchesTrigger,
} from "./outboundEventContext.ts";

describe("outbound event context", () => {
  it("gates exactly the outbound-relevant event types", () => {
    expect(OUTBOUND_EVENT_TYPES.has("StepAwaitingUser")).toBe(true);
    expect(OUTBOUND_EVENT_TYPES.has("TicketBlocked")).toBe(true);
    expect(OUTBOUND_EVENT_TYPES.has("TicketMovedToLane")).toBe(true);
    expect(OUTBOUND_EVENT_TYPES.has("TicketAdmitted")).toBe(true);
    // StepFailed is NOT a first-class outbound event: step failures surface via the board's
    // retry/fail path → a TicketBlocked (`blocked`) or a failure-route TicketMovedToLane
    // (`lane_entered`), so gating StepFailed directly would double-fire.
    expect(OUTBOUND_EVENT_TYPES.has("StepFailed")).toBe(false);
  });
  it("every gated event type maps to an explicit (non-fallback) trigger", () => {
    const expected: Record<string, OutboundTrigger> = {
      StepAwaitingUser: "needs_attention",
      TicketBlocked: "blocked",
      TicketMovedToLane: "lane_entered",
      TicketAdmitted: "lane_entered",
    };
    for (const eventType of OUTBOUND_EVENT_TYPES) {
      expect(expected[eventType], `missing expected trigger for ${eventType}`).toBeDefined();
      const ctx = buildOutboundContext({
        eventType,
        ticketId: "t",
        boardId: "b",
        title: "x",
        fromLane: null,
        toLane: null,
        postStatus: "s",
        isTerminal: false,
        reason: undefined,
        occurredAt: "2026-06-14T00:00:00.000Z",
      });
      expect(ctx.trigger).toBe(expected[eventType]);
    }
  });
  it("StepAwaitingUser → needs_attention", () => {
    const ctx = buildOutboundContext({
      eventType: "StepAwaitingUser",
      ticketId: "t1",
      boardId: "b1",
      title: "Fix",
      fromLane: "in-progress",
      toLane: null,
      postStatus: "waiting_on_user",
      isTerminal: false,
      reason: undefined,
      occurredAt: "2026-06-14T00:00:00.000Z",
    });
    expect(ctx.trigger).toBe("needs_attention");
    expect(ctx.occurredAt).toBe("2026-06-14T00:00:00.000Z");
    expect(matchesTrigger({ on: "needs_attention" }, ctx)).toBe(true);
    expect(matchesTrigger({ on: "blocked" }, ctx)).toBe(false);
  });
  it("TicketBlocked → blocked, carries reason", () => {
    const ctx = buildOutboundContext({
      eventType: "TicketBlocked",
      ticketId: "t1",
      boardId: "b1",
      title: "Fix",
      fromLane: "in-progress",
      toLane: null,
      postStatus: "blocked",
      isTerminal: false,
      reason: "3 retries failed",
      occurredAt: "2026-06-14T00:00:00.000Z",
    });
    expect(ctx.trigger).toBe("blocked");
    expect(ctx.reason).toBe("3 retries failed");
    expect(matchesTrigger({ on: "blocked" }, ctx)).toBe(true);
  });
  it("TicketMovedToLane into a terminal lane → done AND lane_entered both match", () => {
    const ctx = buildOutboundContext({
      eventType: "TicketMovedToLane",
      ticketId: "t1",
      boardId: "b1",
      title: "Fix",
      fromLane: "review",
      toLane: "shipped",
      postStatus: "idle",
      isTerminal: true,
      reason: undefined,
      occurredAt: "2026-06-14T00:00:00.000Z",
    });
    expect(ctx.isTerminal).toBe(true);
    expect(matchesTrigger({ on: "done" }, ctx)).toBe(true);
    expect(matchesTrigger({ on: "lane_entered" }, ctx)).toBe(true);
  });
  it("TicketMovedToLane into a non-terminal lane → lane_entered only, not done", () => {
    const ctx = buildOutboundContext({
      eventType: "TicketMovedToLane",
      ticketId: "t1",
      boardId: "b1",
      title: "Fix",
      fromLane: "todo",
      toLane: "in-progress",
      postStatus: "running",
      isTerminal: false,
      reason: undefined,
      occurredAt: "2026-06-14T00:00:00.000Z",
    });
    expect(matchesTrigger({ on: "done" }, ctx)).toBe(false);
    expect(matchesTrigger({ on: "lane_entered" }, ctx)).toBe(true);
  });
  it("TicketAdmitted → lane_entered, fromLane null", () => {
    const ctx = buildOutboundContext({
      eventType: "TicketAdmitted",
      ticketId: "t1",
      boardId: "b1",
      title: "Fix",
      fromLane: null,
      toLane: "todo",
      postStatus: "queued",
      isTerminal: false,
      reason: undefined,
      occurredAt: "2026-06-14T00:00:00.000Z",
    });
    expect(ctx.trigger).toBe("lane_entered");
    expect(ctx.fromLane).toBeNull();
    expect(matchesTrigger({ on: "lane_entered" }, ctx)).toBe(true);
    expect(matchesTrigger({ on: "done" }, ctx)).toBe(false);
  });
  describe("contextForRule", () => {
    it("a done rule on a terminal ctx → trigger becomes done", () => {
      const ctx = buildOutboundContext({
        eventType: "TicketMovedToLane",
        ticketId: "t1",
        boardId: "b1",
        title: "Fix",
        fromLane: "review",
        toLane: "shipped",
        postStatus: "idle",
        isTerminal: true,
        reason: undefined,
        occurredAt: "2026-06-14T00:00:00.000Z",
      });
      expect(ctx.trigger).toBe("lane_entered");
      const ruleCtx = contextForRule({ on: "done" }, ctx);
      expect(ruleCtx.trigger).toBe("done");
      // Everything else is preserved.
      expect(ruleCtx.isTerminal).toBe(true);
      expect(ruleCtx.toLane).toBe("shipped");
      expect(ruleCtx.fromLane).toBe("review");
    });
    it("a lane_entered rule → returns the base ctx unchanged", () => {
      const ctx = buildOutboundContext({
        eventType: "TicketMovedToLane",
        ticketId: "t1",
        boardId: "b1",
        title: "Fix",
        fromLane: "review",
        toLane: "shipped",
        postStatus: "idle",
        isTerminal: true,
        reason: undefined,
        occurredAt: "2026-06-14T00:00:00.000Z",
      });
      expect(contextForRule({ on: "lane_entered" }, ctx)).toBe(ctx);
    });
    it("a blocked rule → returns the base ctx unchanged", () => {
      const ctx = buildOutboundContext({
        eventType: "TicketBlocked",
        ticketId: "t1",
        boardId: "b1",
        title: "Fix",
        fromLane: "in-progress",
        toLane: null,
        postStatus: "blocked",
        isTerminal: false,
        reason: "boom",
        occurredAt: "2026-06-14T00:00:00.000Z",
      });
      expect(contextForRule({ on: "blocked" }, ctx)).toBe(ctx);
    });
  });
});
