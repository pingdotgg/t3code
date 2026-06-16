import "../index.css";

import { describe, expect, it } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { DiffPanelShell } from "./DiffPanelShell";

describe("DiffPanelShell", () => {
  it("uses the shared compact surface subheader in embedded mode", async () => {
    const screen = await render(
      <DiffPanelShell mode="embedded" header={<span>Diff controls</span>}>
        <div>Diff content</div>
      </DiffPanelShell>,
    );
    const subheader = screen.container.querySelector<HTMLElement>("[data-surface-subheader]");

    expect(subheader).not.toBeNull();
    expect(subheader?.getBoundingClientRect().height).toBe(40);
    expect(window.getComputedStyle(subheader!).borderTopWidth).toBe("0px");
    expect(window.getComputedStyle(subheader!).borderBottomWidth).toBe("1px");
  });
});
