import { expect, it } from "vite-plus/test";

import { render } from "../../test/render";
import { contextStripGroupWidth } from "./contextStripMeasurement";

it("measures a chip with its icon and padding, and a stretched group by its content", async () => {
  await using screen = await render(
    <div style={{ display: "flex", width: 800, columnGap: 4 }}>
      <span
        data-testid="chip"
        style={{
          display: "inline-flex",
          alignItems: "center",
          columnGap: 6,
          padding: "0 8px",
          border: "1px solid transparent",
        }}
      >
        <svg width={12} height={12} style={{ flexShrink: 0 }} />
        <span>oliverpad</span>
      </span>
      <div data-testid="stretched" style={{ display: "flex", flexGrow: 1, columnGap: 2 }}>
        <span style={{ display: "inline-block", width: 40, flexShrink: 0 }} />
      </div>
    </div>,
  );

  const element = (testId: string) => {
    const found = screen.getByTestId(testId).element();
    if (!(found instanceof HTMLElement)) throw new Error(`missing ${testId}`);
    return found;
  };
  const chip = element("chip");
  expect(contextStripGroupWidth(chip)).toBe(chip.offsetWidth);
  expect(contextStripGroupWidth(element("stretched"))).toBe(40);
});
