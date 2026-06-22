import { describe, expect, it } from "bun:test";
import * as React from "react";
import { testRender } from "@opentui/react/test-utils";

import type { ComposerControls } from "../controls.ts";
import { ControlsRow } from "./ControlsRow.tsx";

const noop = () => {};

const base = {
  working: false,
  onTogglePlan: noop,
  onOpenAccess: noop,
  onOpenModel: noop,
  onOpenReasoning: noop,
  onStop: noop,
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
    // The plan/build chip is no longer first (model leads now), and the row sits
    // one line down (marginTop) — locate "^B" instead of assuming a fixed cell.
    const lines = t.captureCharFrame().split("\n");
    const row = lines.findIndex((line) => line.includes("^B"));
    const col = (lines[row] ?? "").indexOf("^B") + 1;
    await t.mockMouse.click(col, row);
    await t.flush();
    expect(toggled).toBe(true);
    t.renderer.destroy();
  });

  const controls: ComposerControls = {
    interactionMode: "default",
    runtimeMode: "full-access",
    model: null,
    reasoning: null,
  };

  it("Given the agent is not working, then no stop button is shown", async () => {
    const t = await testRender(<ControlsRow {...base} controls={controls} working={false} />, {
      width: 80,
      height: 3,
    });
    await t.renderOnce();
    expect(t.captureCharFrame()).not.toContain("Stop");
    t.renderer.destroy();
  });

  it("Given the agent is working, then a red stop button appears and clicking it fires onStop", async () => {
    let stopped = false;
    const t = await testRender(
      <ControlsRow
        {...base}
        controls={controls}
        working={true}
        onStop={() => (stopped = true)}
      />,
      { width: 80, height: 3 },
    );
    await t.renderOnce();
    await t.flush();
    const frame = t.captureCharFrame();
    expect(frame).toContain("■ Stop");
    // The stop button is right-aligned; the row sits one line down (marginTop).
    const lines = frame.split("\n");
    const rowIndex = lines.findIndex((line) => line.includes("Stop"));
    const col = (lines[rowIndex] ?? "").indexOf("■");
    await t.mockMouse.click(col + 1, rowIndex);
    await t.flush();
    expect(stopped).toBe(true);
    t.renderer.destroy();
  });
});
