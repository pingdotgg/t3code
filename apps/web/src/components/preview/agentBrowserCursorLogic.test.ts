import { describe, expect, it } from "vite-plus/test";

import {
  agentBrowserCursorLabel,
  agentBrowserCursorOpacity,
  easeOutCubic,
  lerp,
} from "./agentBrowserCursorLogic";

describe("agentBrowserCursorOpacity", () => {
  it("keeps active movement fully visible", () => {
    expect(agentBrowserCursorOpacity(true, "agent")).toBe(1);
    expect(agentBrowserCursorOpacity(true, "human")).toBe(1);
  });

  it("settles to a visible idle state", () => {
    expect(agentBrowserCursorOpacity(false, "none")).toBe(0.35);
    expect(agentBrowserCursorOpacity(false, "agent")).toBe(0.35);
  });

  it("dims further while the human controls the page", () => {
    expect(agentBrowserCursorOpacity(false, "human")).toBe(0.18);
  });
});

describe("agentBrowserCursorLabel", () => {
  it("names a live move and a click, then hides when idle", () => {
    expect(agentBrowserCursorLabel("move", true)).toBe("Agent");
    expect(agentBrowserCursorLabel("click", true)).toBe("Click");
    expect(agentBrowserCursorLabel("click", false)).toBeNull();
  });
});

describe("cursor follow easing", () => {
  it("lerps and eases out without overshooting", () => {
    expect(lerp(0, 100, 0.25)).toBe(25);
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
  });
});
