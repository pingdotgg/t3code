import type { PreviewViewportSetting } from "@t3tools/contracts";
import { useState } from "react";
import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { BrowserDeviceToolbar } from "./BrowserDeviceToolbar";

function Viewport({ width = 1920, height = 1080 }: { width?: number; height?: number }) {
  const [setting, setSetting] = useState<PreviewViewportSetting>({
    _tag: "freeform",
    width,
    height,
  });
  const [aspectRatio, setAspectRatio] = useState<number | null>(width / height);
  if (setting._tag === "fill") throw new Error("Expected fixed viewport");
  return (
    <>
      <BrowserDeviceToolbar
        setting={setting}
        width={800}
        aspectRatio={aspectRatio}
        onAspectRatioChange={setAspectRatio}
        onChange={async (next) => setSetting(next)}
      />
      <output aria-label="Saved viewport">
        {setting.width} × {setting.height}
      </output>
      <button type="button">Leave toolbar</button>
    </>
  );
}

it.each([
  { width: 1920, height: 1080, axis: "width", typed: "2560", expected: "2560 × 1440" },
  { width: 390, height: 844, axis: "height", typed: "2532", expected: "1170 × 2532" },
])("keeps each typed $axis digit until the locked size is committed", async (testCase) => {
  await using screen = await render(<Viewport {...testCase} />);
  const input = screen.getByRole("spinbutton", { name: `Viewport ${testCase.axis}` });
  await userEvent.clear(input);
  await userEvent.type(input, testCase.typed);
  await expect.element(input).toHaveValue(Number(testCase.typed));
  await screen.getByRole("button", { name: "Leave toolbar" }).click();
  await expect
    .element(screen.getByRole("status", { name: "Saved viewport" }))
    .toHaveTextContent(testCase.expected);
});

it("clamps a completed width below the locked minimum when leaving the toolbar", async () => {
  await using screen = await render(<Viewport />);
  const input = screen.getByRole("spinbutton", { name: "Viewport width" });
  await userEvent.clear(input);
  await userEvent.type(input, "256");
  await expect.element(input).toHaveValue(256);
  await screen.getByRole("button", { name: "Leave toolbar" }).click();
  await expect
    .element(screen.getByRole("status", { name: "Saved viewport" }))
    .toHaveTextContent("427 × 240");
});

it("still limits a completed locked size to the viewport area cap", async () => {
  await using screen = await render(<Viewport width={1920} height={1920} />);
  const input = screen.getByRole("spinbutton", { name: "Viewport width" });
  await userEvent.clear(input);
  await userEvent.type(input, "3840");
  await expect.element(input).toHaveValue(3840);
  await screen.getByRole("button", { name: "Leave toolbar" }).click();
  await expect
    .element(screen.getByRole("status", { name: "Saved viewport" }))
    .toHaveTextContent("2880 × 2880");
});
