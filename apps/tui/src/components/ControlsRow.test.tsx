import { describe, expect, it } from "bun:test";
import * as React from "react";
import { testRender } from "@opentui/react/test-utils";

import type { ComposerControls } from "../controls.ts";
import { ControlsRow } from "./ControlsRow.tsx";

async function frameOf(controls: ComposerControls): Promise<string> {
  const t = await testRender(<ControlsRow controls={controls} />, { width: 80, height: 3 });
  await t.renderOnce();
  const frame = t.captureCharFrame();
  t.renderer.destroy();
  return frame;
}

describe("ControlsRow", () => {
  it("Given control state, then it shows plan/build, runtime, model and reasoning with their keys", async () => {
    const frame = await frameOf({
      interactionMode: "plan",
      runtimeMode: "approval-required",
      model: "gpt-5",
      reasoning: "high",
    });
    expect(frame).toContain("^B Plan");
    expect(frame).toContain("^O Supervised");
    expect(frame).toContain("gpt-5");
    expect(frame).toContain("high");
    expect(frame).toContain("^K m model");
  });

  it("Given no model, then only the mode chips show", async () => {
    const frame = await frameOf({
      interactionMode: "default",
      runtimeMode: "full-access",
      model: null,
      reasoning: null,
    });
    expect(frame).toContain("^B Build");
    expect(frame).toContain("^O Full access");
  });
});
