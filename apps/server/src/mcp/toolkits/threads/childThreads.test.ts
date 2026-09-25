import { describe, expect, it } from "vite-plus/test";

import {
  attributedMessage,
  deliveryOf,
  effortOptionId,
  isSettled,
  scopeRefusal,
  subagentStatusOf,
  threadIsInScope,
  threadShouldBeListed,
} from "./handlers.ts";

const session = (status: string) =>
  ({
    status,
    providerInstanceId: "codex",
    activeTurnId: null,
    lastError: null,
  }) as unknown as Parameters<typeof subagentStatusOf>[0];

describe("child thread status vocabulary", () => {
  it("maps a missing session to starting so the message guard holds", () => {
    expect(subagentStatusOf(null)).toBe("starting");
  });

  it("collapses provider session states onto the toolkit vocabulary", () => {
    expect(subagentStatusOf(session("starting"))).toBe("starting");
    expect(subagentStatusOf(session("running"))).toBe("running");
    expect(subagentStatusOf(session("idle"))).toBe("idle");
    expect(subagentStatusOf(session("ready"))).toBe("idle");
    expect(subagentStatusOf(session("error"))).toBe("failed");
    expect(subagentStatusOf(session("interrupted"))).toBe("stopped");
    expect(subagentStatusOf(session("stopped"))).toBe("stopped");
  });
});

describe("child thread effort routing", () => {
  it("uses each driver's advertised reasoning-effort option", () => {
    expect(effortOptionId("codex")).toBe("reasoningEffort");
    expect(effortOptionId("grok")).toBe("reasoningEffort");
    expect(effortOptionId("opencode")).toBe("variant");
  });

  it("falls back to effort for Claude, Cursor and Antigravity", () => {
    expect(effortOptionId("claudeAgent")).toBe("effort");
    expect(effortOptionId("cursor")).toBe("effort");
    expect(effortOptionId("antigravity")).toBe("effort");
  });
});

describe("child thread message delivery", () => {
  it("steers a running child and opens a turn everywhere else", () => {
    expect(deliveryOf("running")).toBe("steer");
    expect(deliveryOf("idle")).toBe("new-turn");
    expect(deliveryOf("failed")).toBe("new-turn");
    expect(deliveryOf("stopped")).toBe("new-turn");
    // starting never reaches deliveryOf: the message tool refuses it first.
    expect(deliveryOf("starting")).toBe("new-turn");
  });
});

const thread = (id: string, projectId: string, settledAt: string | null = null) =>
  ({ id, projectId, title: id, archivedAt: null, settledAt, settledOverride: null }) as const;

describe("thread scopes", () => {
  const caller = thread("caller", "project-a");
  const child = thread("sub.caller.123", "project-a");
  const peer = thread("peer", "project-a");
  const otherProject = thread("other", "project-b");
  const settled = thread("settled", "project-a", "2026-01-01T00:00:00.000Z");
  const archived = { ...peer, archivedAt: "2026-01-02T00:00:00.000Z" };

  it("keeps children narrow and allows project peers", () => {
    expect(threadIsInScope(child, caller, "children")).toBe(true);
    expect(threadIsInScope(peer, caller, "children")).toBe(false);
    expect(threadIsInScope(peer, caller, "project")).toBe(true);
    expect(threadIsInScope(otherProject, caller, "project")).toBe(false);
  });

  it("recognizes settled threads and names the wider scope on refusal", () => {
    expect(isSettled(settled)).toBe(true);
    expect(isSettled(peer)).toBe(false);
    expect(threadShouldBeListed(settled, caller, "project", false)).toBe(false);
    expect(threadShouldBeListed(settled, caller, "project", true)).toBe(true);
    expect(threadShouldBeListed(archived, caller, "project", true)).toBe(false);
    expect(scopeRefusal("peer", "children")).toContain('scope: "project"');
    expect(scopeRefusal("other", "project")).toContain("scope: project");
  });

  it("attributes messages sent outside the child scope", () => {
    expect(attributedMessage("hello", caller, child)).toBe("hello");
    expect(attributedMessage("hello", caller, peer)).toBe(
      "[Message from caller (thread caller)]\n\nhello",
    );
  });
});
