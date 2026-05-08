import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToastStatusIcon } from "./toast";

describe("ToastStatusIcon", () => {
  it("uses the sidebar pixel grid loader for loading toasts", () => {
    const markup = renderToStaticMarkup(<ToastStatusIcon type="loading" />);

    expect(markup).toContain('data-slot="pixel-grid-loader"');
    expect(markup).toContain('data-pixel-grid-variant="sidebar"');
    expect(markup.match(/data-slot="pixel-grid-loader-cell"/g)).toHaveLength(9);
  });

  it("uses the sidebar completed glyph for success toasts", () => {
    const markup = renderToStaticMarkup(<ToastStatusIcon type="success" />);

    expect(markup).toContain('data-icon="sidebar-completed"');
  });
});
