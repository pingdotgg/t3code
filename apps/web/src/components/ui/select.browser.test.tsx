import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./select";

import "~/index.css";

const rowStyle = { height: 40, minHeight: 40 };

describe("SelectPopup", () => {
  it("does not cover the last option when the list overflows by a fraction of a pixel", async () => {
    await using screen = await render(
      <Select defaultValue="local">
        <SelectTrigger aria-label="Run on">
          <SelectValue />
        </SelectTrigger>
        {/* Two 40px rows plus p-1 padding are 88px; 87.4px leaves a sub-pixel overflow. */}
        <SelectPopup alignItemWithTrigger={false} className="max-h-[87.4px]">
          <SelectItem value="local" style={rowStyle}>
            Local
          </SelectItem>
          <SelectItem value="remote" style={rowStyle}>
            Remote
          </SelectItem>
        </SelectPopup>
      </Select>,
    );

    await userEvent.click(screen.getByRole("combobox", { name: "Run on" }));
    const lastOption = page.getByRole("option", { name: "Remote" });
    await expect.element(lastOption).toBeVisible();

    const list = document.querySelector<HTMLElement>("[data-slot='select-list']");
    expect(list && list.scrollHeight - list.clientHeight).toBe(1);

    await vi.waitFor(() => {
      const option = lastOption.element();
      const rect = option.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      expect(hit && option.contains(hit) ? "option" : hit?.getAttribute("data-slot")).toBe(
        "option",
      );
    });
  });

  it("keeps the native scrollbar on a fallback list that overflows", async () => {
    const values = Array.from({ length: 12 }, (_, index) => `machine-${index}`);
    await using screen = await render(
      <Select defaultValue="machine-0">
        <SelectTrigger aria-label="Run on">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false} className="max-h-[120px]">
          {values.map((value) => (
            <SelectItem key={value} value={value} style={rowStyle}>
              {value}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>,
    );

    await userEvent.click(screen.getByRole("combobox", { name: "Run on" }));
    await expect.element(page.getByRole("option", { name: "machine-0" })).toBeVisible();

    const list = document.querySelector<HTMLElement>("[data-slot='select-list']");
    expect(list && list.scrollHeight > list.clientHeight).toBe(true);
    expect(list && getComputedStyle(list).scrollbarWidth).not.toBe("none");
  });
});
