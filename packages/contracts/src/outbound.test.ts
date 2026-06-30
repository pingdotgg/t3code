import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { OutboundConnectionView, OutboundEventContext } from "./outbound.ts";
import { WorkflowLintCode } from "./workflow.ts";

describe("outbound contracts", () => {
  it("WorkflowLintCode includes the outbound codes", () => {
    expect(() => Schema.decodeUnknownSync(WorkflowLintCode)("invalid_outbound")).not.toThrow();
    expect(() => Schema.decodeUnknownSync(WorkflowLintCode)("duplicate_outbound_id")).not.toThrow();
  });
  it("OutboundConnectionView decodes", () => {
    const v = Schema.decodeUnknownSync(OutboundConnectionView)({
      connectionRef: "conn-1",
      kind: "slack",
      displayName: "Eng alerts",
      createdAt: "2026-06-14T00:00:00.000Z",
    });
    expect(v.kind).toBe("slack");
  });
  it("OutboundEventContext decodes a blocked event", () => {
    const c = Schema.decodeUnknownSync(OutboundEventContext)({
      trigger: "blocked",
      ticketId: "t1",
      boardId: "b1",
      title: "Fix login",
      status: "blocked",
      fromLane: "in-progress",
      toLane: "in-progress",
      isTerminal: false,
      reason: "3 retries failed",
      occurredAt: "2026-06-14T00:00:00.000Z",
    });
    expect(c.trigger).toBe("blocked");
  });
  it("OutboundEventContext allows null fromLane/toLane and absent reason", () => {
    const c = Schema.decodeUnknownSync(OutboundEventContext)({
      trigger: "lane_entered",
      ticketId: "t1",
      boardId: "b1",
      title: "x",
      status: "queued",
      fromLane: null,
      toLane: "todo",
      isTerminal: false,
      occurredAt: "2026-06-14T00:00:00.000Z",
    });
    expect(c.fromLane).toBeNull();
    expect(c.reason).toBeUndefined();
  });
});
