import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SessionGridResizableLayout } from "./SessionGridResizableLayout";

function renderLayout(options: {
  readonly columns: number;
  readonly rows: number;
  resizable: boolean;
}) {
  return renderToStaticMarkup(
    <SessionGridResizableLayout
      columns={options.columns}
      layoutKey="test-project"
      onKeyDown={() => {}}
      resizable={options.resizable}
      rows={options.rows}
    >
      <div>Session</div>
    </SessionGridResizableLayout>,
  );
}

describe("SessionGridResizableLayout", () => {
  it("renders an accessible drag handle for every shared row and column edge", () => {
    const markup = renderLayout({ columns: 3, rows: 2, resizable: true });

    expect(markup.match(/data-session-grid-resize-handle="column"/g)).toHaveLength(2);
    expect(markup.match(/data-session-grid-resize-handle="row"/g)).toHaveLength(1);
    expect(markup).toContain('aria-label="Resize session grid columns 1 and 2. Use arrow keys');
    expect(markup).toContain('title="Drag to resize · double-click to reset"');
  });

  it("keeps the narrow stacked layout free of desktop resize handles", () => {
    const markup = renderLayout({ columns: 2, rows: 2, resizable: false });

    expect(markup).toContain('data-session-grid-resizable="false"');
    expect(markup).not.toContain("data-session-grid-resize-handle");
  });
});
