import { describe, expect, it } from "bun:test";

import type { OrchestrationThreadShell } from "@t3tools/contracts";
import {
  ansi,
  relativeTime,
  resolveProjectStatus,
  resolveThreadStatus,
  statusGlyphColor,
} from "./theme.ts";

/** Minimal thread-shell fixture — only the fields the status resolvers read. */
const tshell = (over: Partial<OrchestrationThreadShell>): OrchestrationThreadShell =>
  ({
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    session: null,
    ...over,
  }) as unknown as OrchestrationThreadShell;

describe("resolveThreadStatus", () => {
  it("Given a pending approval, then it outranks a running session", () => {
    const status = resolveThreadStatus(
      tshell({ hasPendingApprovals: true, session: { status: "running" } as never }),
    );
    expect(status.key).toBe("pending-approval");
    expect(status.color).toBe("red");
  });

  it("Given awaiting input (no approval), then it resolves to awaiting-input", () => {
    expect(resolveThreadStatus(tshell({ hasPendingUserInput: true })).key).toBe("awaiting-input");
  });

  it("Given a running session and no flags, then it resolves to working", () => {
    expect(resolveThreadStatus(tshell({ session: { status: "running" } as never })).key).toBe(
      "working",
    );
  });

  it("Given no session, then it falls back to idle", () => {
    expect(resolveThreadStatus(tshell({ session: null })).key).toBe("idle");
  });
});

describe("resolveProjectStatus", () => {
  it("Given all-idle threads, then it returns null", () => {
    expect(resolveProjectStatus([tshell({}), tshell({})])).toBeNull();
  });

  it("Given a mix, then it returns the highest-priority (lowest rank) non-idle status", () => {
    const status = resolveProjectStatus([
      tshell({ session: { status: "running" } as never }), // working, rank 3
      tshell({ hasPendingApprovals: true }), // pending-approval, rank 0
    ]);
    expect(status?.key).toBe("pending-approval");
  });
});

describe("relativeTime", () => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

  it("Given < 60s, then 'now'", () => expect(relativeTime(ago(5_000))).toBe("now"));
  it("Given 90s, then '1m'", () => expect(relativeTime(ago(90_000))).toBe("1m"));
  it("Given ~3h, then '3h'", () => expect(relativeTime(ago(3 * 3_600_000))).toBe("3h"));
  it("Given ~2d, then '2d'", () => expect(relativeTime(ago(2 * 86_400_000))).toBe("2d"));
  it("Given a future timestamp, then 'now'", () =>
    expect(relativeTime(new Date(Date.now() + 60_000).toISOString())).toBe("now"));
});

describe("ansi", () => {
  it("Given a known colour name, then it returns an indexed-intent RGBA at that ANSI slot", () => {
    const red = ansi("red");
    expect(red.intent).toBe("indexed");
    expect(red.slot).toBe(1);
  });

  it("Given an unknown name, then it falls back to the terminal default foreground", () => {
    expect(ansi("chartreuse").intent).toBe("default");
  });
});

describe("statusGlyphColor", () => {
  it("Given each tone, then it returns the matching glyph", () => {
    expect(statusGlyphColor("success").glyph).toBe("✓");
    expect(statusGlyphColor("error").glyph).toBe("✗");
    expect(statusGlyphColor("busy").glyph).toBe("⟳");
    expect(statusGlyphColor("info").glyph).toBe("·");
  });

  it("Given a success tone, then the colour is the indexed green slot", () => {
    const { color } = statusGlyphColor("success");
    expect(color.intent).toBe("indexed");
    expect(color.slot).toBe(2);
  });
});

describe("applyTerminalColors", () => {
  it("Given a detected palette, then theme colours snapshot to the terminal's real colours", async () => {
    const { THEME, applyTerminalColors } = await import("./theme.ts");
    applyTerminalColors({
      palette: Array.from({ length: 16 }, (_, i) => (i === 6 ? "#ff66cc" : "#123456")),
      defaultForeground: "#eeeeee",
      defaultBackground: "#102030",
    } as never);
    const accent = THEME.accent;
    expect([Math.round(accent.r * 255), Math.round(accent.g * 255), Math.round(accent.b * 255)]).toEqual([
      255, 102, 204,
    ]);
    // Intent is preserved (still an indexed slot 6), so it also themes correctly.
    expect(accent.intent).toBe("indexed");
    expect(accent.slot).toBe(6);
  });
});
