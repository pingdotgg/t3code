import { describe, expect, it } from "bun:test";
import type { SelectOption } from "@opentui/core";
import * as React from "react";
import { testRender } from "@opentui/react/test-utils";

import { SelectOverlay, type SelectStatus } from "./SelectOverlay.tsx";

const options: SelectOption[] = [
  { name: "Supervised", description: "Ask first", value: "approval-required" },
  { name: "Auto-accept edits", description: "Auto edits", value: "auto-accept-edits" },
  { name: "Full access", description: "No prompts", value: "full-access" },
];

describe("SelectOverlay", () => {
  it("Given options, then it renders names + descriptions and marks the selection", async () => {
    const t = await testRender(
      <SelectOverlay title="access" status="ready" options={options} selectedIndex={2} width={60} maxRows={8} onSelect={() => {}} />,
      { width: 64, height: 12 },
    );
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect(frame).toContain("Supervised");
    expect(frame).toContain("No prompts");
    expect(frame).toContain("▸ Full access");
    t.renderer.destroy();
  });

  it("Given an option is clicked, then onSelect fires for that row", async () => {
    let picked: unknown = null;
    const t = await testRender(
      <SelectOverlay
        title="access"
        status="ready"
        options={options}
        selectedIndex={0}
        width={60} maxRows={8}
        onSelect={(_index, option) => {
          picked = option?.value;
        }}
      />,
      { width: 64, height: 12 },
    );
    await t.renderOnce();
    await t.flush();
    // Row layout: border(0) · title(1) · opt0 name(2)/desc(3) · opt1 name(4).
    await t.mockMouse.click(5, 4);
    await t.flush();
    expect(picked).toBe("auto-accept-edits");
    t.renderer.destroy();
  });

  it.each<SelectStatus>(["loading", "error", "empty"])(
    "Given %s status, then it shows the matching placeholder",
    async (status) => {
      const t = await testRender(
        <SelectOverlay title="model" status={status} options={[]} selectedIndex={0} width={50} maxRows={6} onSelect={() => {}} />,
        { width: 52, height: 6 },
      );
      await t.renderOnce();
      const frame = t.captureCharFrame();
      const expected = status === "loading" ? "loading" : status === "error" ? "failed" : "nothing";
      expect(frame).toContain(expected);
      t.renderer.destroy();
    },
  );
});
