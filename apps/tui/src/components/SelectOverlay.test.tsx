import { describe, expect, it } from "bun:test";
import type { SelectOption } from "@opentui/core";
import * as React from "react";
import { testRender } from "@opentui/react/test-utils";

import { SelectOverlay, type SelectStatus } from "./SelectOverlay.tsx";

const options: SelectOption[] = [
  { name: "Supervised", description: "Ask first", value: "approval-required" },
  { name: "Full access", description: "No prompts", value: "full-access" },
];

describe("SelectOverlay", () => {
  it("Given options, then it renders them and Enter selects the highlighted one", async () => {
    let picked: unknown = null;
    const t = await testRender(
      <SelectOverlay
        title="access"
        status="ready"
        options={options}
        selectedIndex={1}
        height={6}
        onSelect={(_index, option) => {
          picked = option?.value;
        }}
      />,
      { width: 60, height: 8 },
    );
    await t.renderOnce();
    await t.flush();
    expect(t.captureCharFrame()).toContain("Supervised");
    expect(t.captureCharFrame()).toContain("Full access");
    t.mockInput.pressEnter();
    await t.flush();
    expect(picked).toBe("full-access");
    t.renderer.destroy();
  });

  it.each<SelectStatus>(["loading", "error", "empty"])(
    "Given %s status, then it shows the matching placeholder",
    async (status) => {
      const t = await testRender(
        <SelectOverlay title="model" status={status} options={[]} selectedIndex={0} height={4} onSelect={() => {}} />,
        { width: 50, height: 6 },
      );
      await t.renderOnce();
      const frame = t.captureCharFrame();
      const expected = status === "loading" ? "loading" : status === "error" ? "failed" : "nothing";
      expect(frame).toContain(expected);
      t.renderer.destroy();
    },
  );
});
