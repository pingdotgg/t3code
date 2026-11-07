import { expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { render } from "../../test/render";
import { ComposerContextLabel } from "./ComposerContextLabel";

it("uses the available footer width before truncating a long branch in either direction", async () => {
  const branch = "t3/redesign-fix-workspace-hint-label-and-composer-footer-collapse";
  const footer = (width: number, compact: boolean) => (
    <div
      className="group/composer-context flex"
      data-compact={compact ? "labels" : undefined}
      style={{ width }}
    >
      <ComposerContextLabel compact="truncate">{branch}</ComposerContextLabel>
    </div>
  );
  await using screen = await render(footer(800, false));
  const label = screen.getByText(branch).element();
  const range = document.createRange();
  range.selectNodeContents(label);

  for (const widths of [
    [800, 600, 400, 200],
    [200, 400, 600, 800],
  ]) {
    for (const width of widths) {
      await screen.rerender(footer(width, width <= 400));
      await vi.waitFor(() => {
        const naturalWidth = range.getBoundingClientRect().width;
        expect(naturalWidth).toBeGreaterThan(240);
        expect(label.getBoundingClientRect().width).toBeCloseTo(Math.min(width, naturalWidth), 0);
      });
    }
  }
});
