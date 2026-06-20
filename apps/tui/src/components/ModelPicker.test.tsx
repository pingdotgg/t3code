import { describe, expect, it } from "bun:test";
import * as React from "react";
import { testRender } from "@opentui/react/test-utils";

import type { ModelOption } from "../models.ts";
import { ModelPicker, type ModelPickerStatus } from "./ModelPicker.tsx";

const options: ModelOption[] = [
  { instanceId: "codex", model: "gpt-5", label: "GPT-5", providerLabel: "Codex" },
  { instanceId: "claude", model: "opus", label: "Opus 4", providerLabel: "Claude" },
];

async function frameOf(props: {
  status: ModelPickerStatus;
  selected?: number;
  currentInstanceId?: string | null;
  currentModel?: string | null;
}): Promise<string> {
  const t = await testRender(
    <ModelPicker
      options={props.status === "ready" ? options : []}
      selected={props.selected ?? 0}
      status={props.status}
      currentInstanceId={props.currentInstanceId ?? null}
      currentModel={props.currentModel ?? null}
      width={70}
    />,
    { width: 80, height: 10 },
  );
  await t.renderOnce();
  const frame = t.captureCharFrame();
  t.renderer.destroy();
  return frame;
}

describe("ModelPicker", () => {
  it("Given a loaded list, then it lists models with provider labels and marks current + cursor", async () => {
    const frame = await frameOf({
      status: "ready",
      selected: 0,
      currentInstanceId: "claude",
      currentModel: "opus",
    });
    expect(frame).toContain("GPT-5");
    expect(frame).toContain("Codex");
    expect(frame).toContain("▸ ");
    expect(frame).toContain("✓ Opus 4");
  });

  it("Given a loading state, then it shows a loading hint", async () => {
    expect(await frameOf({ status: "loading" })).toContain("loading models");
  });

  it("Given an empty list, then it says no models", async () => {
    expect(await frameOf({ status: "empty" })).toContain("no models");
  });

  it("Given an error, then it shows the failure", async () => {
    expect(await frameOf({ status: "error" })).toContain("failed to load");
  });
});
