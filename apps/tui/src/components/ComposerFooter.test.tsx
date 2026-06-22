import { describe, expect, it } from "bun:test";
import * as React from "react";
import { testRender } from "@opentui/react/test-utils";

import type { ComposerControls } from "../controls.ts";
import { ComposerFooter } from "./ComposerFooter.tsx";

const noop = () => {};

const base = {
  working: false,
  answering: false,
  hasText: false,
  onTogglePlan: noop,
  onOpenAccess: noop,
  onOpenModel: noop,
  onOpenReasoning: noop,
  onStop: noop,
  onSend: noop,
  onSubmitAnswer: noop,
} as const;

const controls: ComposerControls = {
  interactionMode: "plan",
  runtimeMode: "approval-required",
  model: "gpt-5",
  reasoning: "high",
};

async function render(node: React.ReactNode) {
  const t = await testRender(node, { width: 90, height: 3 });
  await t.renderOnce();
  await t.flush();
  return t;
}

describe("ComposerFooter", () => {
  it("Given control state, then it shows model, reasoning, mode and access — model first", async () => {
    const t = await render(<ComposerFooter {...base} controls={controls} />);
    const line = t.captureCharFrame().split("\n").find((l) => l.includes("model")) ?? "";
    expect(line).toContain("model gpt-5");
    expect(line).toContain("reasoning high");
    expect(line).toContain("^B Plan");
    expect(line).toContain("^O Supervised");
    expect(line.indexOf("model")).toBeLessThan(line.indexOf("^B"));
    t.renderer.destroy();
  });

  it("Given the default state, then the primary action is Send", async () => {
    const t = await render(<ComposerFooter {...base} controls={controls} />);
    expect(t.captureCharFrame()).toContain("Send");
    t.renderer.destroy();
  });

  it("Given the agent is working, then the primary action is Stop and clicking it fires onStop", async () => {
    let stopped = false;
    const t = await render(
      <ComposerFooter {...base} controls={controls} working onStop={() => (stopped = true)} />,
    );
    const lines = t.captureCharFrame().split("\n");
    const row = lines.findIndex((l) => l.includes("Stop"));
    const col = (lines[row] ?? "").indexOf("■");
    await t.mockMouse.click(col + 1, row);
    await t.flush();
    expect(stopped).toBe(true);
    t.renderer.destroy();
  });

  it("Given a pending question, then the primary action is Submit answer and clicking it fires onSubmitAnswer", async () => {
    let submitted = false;
    const t = await render(
      <ComposerFooter
        {...base}
        controls={controls}
        answering
        onSubmitAnswer={() => (submitted = true)}
      />,
    );
    const frame = t.captureCharFrame();
    expect(frame).toContain("Submit answer");
    const lines = frame.split("\n");
    const row = lines.findIndex((l) => l.includes("Submit answer"));
    const col = (lines[row] ?? "").indexOf("Submit");
    await t.mockMouse.click(col, row);
    await t.flush();
    expect(submitted).toBe(true);
    t.renderer.destroy();
  });

  it("Given the plan/build chip is clicked, then onTogglePlan fires", async () => {
    let toggled = false;
    const t = await render(
      <ComposerFooter {...base} controls={controls} onTogglePlan={() => (toggled = true)} />,
    );
    const lines = t.captureCharFrame().split("\n");
    const row = lines.findIndex((l) => l.includes("^B"));
    const col = (lines[row] ?? "").indexOf("^B") + 1;
    await t.mockMouse.click(col, row);
    await t.flush();
    expect(toggled).toBe(true);
    t.renderer.destroy();
  });
});
