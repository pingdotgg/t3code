import { describe, expect, it } from "vitest";
import { renderOutbound } from "./outboundFormatters.ts";

const ctx = {
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
} as const;

const ABS_URL = "https://app.example.com/tickets/env1/b1/t1";

describe("outbound formatters", () => {
  it("generic envelope is stable JSON with event + ticket; url is the absolute ticketUrl when provided", () => {
    const { body, contentType } = renderOutbound("generic", ctx, {
      connection: { kind: "webhook", url: "https://x/y" },
      ticketUrl: ABS_URL,
    });
    expect(contentType).toBe("application/json");
    const p = JSON.parse(body);
    expect(p.event).toBe("blocked");
    expect(p.ticket.id).toBe("t1");
    expect(p.ticket.title).toBe("Fix login");
    expect(p.ticket.url).toBe(ABS_URL);
  });
  it("generic envelope ticket.url is null when no ticketUrl is provided", () => {
    const p = JSON.parse(
      renderOutbound("generic", ctx, { connection: { kind: "webhook", url: "https://x/y" } }).body,
    );
    expect(p.ticket.url).toBeNull();
    // The full context is still embedded so consumers can build their own link.
    expect(p.context.boardId).toBe("b1");
    expect(p.context.ticketId).toBe("t1");
  });
  it("slack body has header+section blocks and a text fallback", () => {
    const { body } = renderOutbound("slack", ctx, {
      connection: { kind: "slack", url: "https://hooks.slack.com/x" },
      ticketUrl: ABS_URL,
    });
    const p = JSON.parse(body);
    expect(Array.isArray(p.blocks)).toBe(true);
    expect(typeof p.text).toBe("string");
    expect(p.text).toContain("Fix login");
    expect(p.blocks.some((b: { type: string }) => b.type === "header")).toBe(true);
    expect(p.blocks.some((b: { type: string }) => b.type === "section")).toBe(true);
  });
  it("slack WITH ticketUrl has an actions block whose button url is the absolute url", () => {
    const p = JSON.parse(
      renderOutbound("slack", ctx, {
        connection: { kind: "slack", url: "https://hooks.slack.com/x" },
        ticketUrl: ABS_URL,
      }).body,
    );
    const actions = p.blocks.find((b: { type: string }) => b.type === "actions");
    expect(actions).toBeDefined();
    expect(actions.elements[0].type).toBe("button");
    expect(actions.elements[0].url).toBe(ABS_URL);
  });
  it("slack WITHOUT ticketUrl omits the actions block but keeps header+section+text", () => {
    const p = JSON.parse(
      renderOutbound("slack", ctx, {
        connection: { kind: "slack", url: "https://hooks.slack.com/x" },
      }).body,
    );
    expect(p.blocks.every((b: { type: string }) => b.type !== "actions")).toBe(true);
    expect(p.blocks.some((b: { type: string }) => b.type === "header")).toBe(true);
    expect(p.blocks.some((b: { type: string }) => b.type === "section")).toBe(true);
    expect(typeof p.text).toBe("string");
    expect(p.text).toContain("Fix login");
  });
  it("slack section includes reason when present and omits it when absent", () => {
    const withReason = JSON.parse(
      renderOutbound("slack", ctx, { connection: { kind: "slack", url: "https://x" } }).body,
    );
    expect(JSON.stringify(withReason)).toContain("3 retries failed");
    const noReason = JSON.parse(
      renderOutbound(
        "slack",
        { ...ctx, reason: undefined },
        {
          connection: { kind: "slack", url: "https://x" },
        },
      ).body,
    );
    expect(JSON.stringify(noReason)).not.toContain("Reason:");
  });
  it("generic ticket.lane reflects toLane", () => {
    const p = JSON.parse(
      renderOutbound(
        "generic",
        { ...ctx, toLane: "done" },
        {
          connection: { kind: "webhook", url: "https://x" },
        },
      ).body,
    );
    expect(p.ticket.lane).toBe("done");
  });
});
