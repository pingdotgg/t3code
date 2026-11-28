import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { CommandShortcut } from "./command";
import { MenuShortcut } from "./menu";

import "~/index.css";

describe.each([
  ["MenuShortcut", MenuShortcut],
  ["CommandShortcut", CommandShortcut],
])("%s", (_name, Shortcut) => {
  it.each(["ltr", "rtl"] as const)("sits at the row's end in %s", async (direction) => {
    await using screen = await render(
      <div dir={direction} data-testid="row" style={{ display: "flex", width: 240 }}>
        <span>Label</span>
        <Shortcut data-testid="shortcut">⌘K</Shortcut>
      </div>,
    );
    const row = screen.getByTestId("row").element().getBoundingClientRect();
    const shortcut = screen.getByTestId("shortcut").element().getBoundingClientRect();

    if (direction === "ltr") expect(shortcut.right).toBeCloseTo(row.right, 0);
    else expect(shortcut.left).toBeCloseTo(row.left, 0);
  });
});
