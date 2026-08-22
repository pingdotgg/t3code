import { describe, expect, it } from "bun:test";
import * as React from "react";
import { testRender } from "@opentui/react/test-utils";

import { WorkingIndicator } from "./WorkingIndicator.tsx";

describe("WorkingIndicator", () => {
  it("shows a static working marker without a repainting timer", async () => {
    const t = await testRender(<WorkingIndicator />, { width: 30, height: 3 });
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect(frame).toContain("Working…");
    expect(frame).toContain("●");
    expect(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u.test(frame)).toBe(false);
    t.renderer.destroy();
  });
});
