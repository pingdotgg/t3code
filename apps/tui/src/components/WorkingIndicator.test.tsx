import { describe, expect, it } from "bun:test";
import * as React from "react";
import { testRender } from "@opentui/react/test-utils";

import { WorkingIndicator } from "./WorkingIndicator.tsx";

describe("WorkingIndicator", () => {
  it("Given a start time, then it shows a spinner frame and the elapsed label", async () => {
    const started = new Date(Date.now() - 7_000).toISOString();
    const t = await testRender(<WorkingIndicator startedAt={started} />, { width: 30, height: 3 });
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect(frame).toContain("Working…");
    expect(frame).toContain("7s");
    // One of the braille spinner frames is present.
    expect(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u.test(frame)).toBe(true);
    t.renderer.destroy();
  });

  it("Given no start time, then it shows a bare Working label", async () => {
    const t = await testRender(<WorkingIndicator startedAt={null} />, { width: 30, height: 3 });
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect(frame).toContain("Working…");
    expect(frame).not.toContain("s");
    t.renderer.destroy();
  });
});
