import { describe, expect, it } from "vite-plus/test";

import { deliveryOf, effortOptionId, subagentStatusOf } from "./handlers.ts";

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
