import { describe, expect, it } from "bun:test";
import * as React from "react";
import { testRender } from "@opentui/react/test-utils";

import type { ComposerControls } from "../controls.ts";
import { ControlsRow } from "./ControlsRow.tsx";

const noop = () => {};

const base = {
  onTogglePlan: noop,
  onOpenAccess: noop,
  onOpenModel: noop,
  onOpenReasoning: noop,
} as const;

describe("ControlsRow", () => {
  it("Given control state, then it shows plan/build, access, model and reasoning chips", async () => {
    const controls: ComposerControls = {
      interactionMode: "plan",
      runtimeMode: "approval-required",
      model: "gpt-5",
      reasoning: "high",
    };
    const t = await testRender(<ControlsRow {...base} controls={controls} />, { width: 80, height: 3 });
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect(frame).toContain("^B Plan");
    expect(frame).toContain("^O Supervised");
    expect(frame).toContain("model gpt-5");
    expect(frame).toContain("reasoning high");
    t.renderer.destroy();
  });

  it("Given the plan chip is clicked, then onTogglePlan fires", async () => {
    let toggled = false;
    const controls: ComposerControls = {
      interactionMode: "default",
      runtimeMode: "full-access",
      model: null,
      reasoning: null,
    };
    const t = await testRender(
      <ControlsRow {...base} controls={controls} onTogglePlan={() => (toggled = true)} />,
      { width: 80, height: 3 },
    );
    await t.renderOnce();
    await t.flush();
    // The "^B Build" chip starts at the left padding (col 1), row 0.
    await t.mockMouse.click(3, 0);
    await t.flush();
    expect(toggled).toBe(true);
    t.renderer.destroy();
  });
});
