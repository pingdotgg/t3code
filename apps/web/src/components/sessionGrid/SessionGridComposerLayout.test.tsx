import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SessionGridComposerLayout } from "./SessionGridComposerLayout";

describe("SessionGridComposerLayout", () => {
  it("creates a dedicated compact hierarchy for grid panes", () => {
    const markup = renderToStaticMarkup(
      <SessionGridComposerLayout
        compact
        editor={<div data-editor>Prompt</div>}
        controls={<div data-controls>Controls</div>}
      />,
    );

    expect(markup).toContain('data-session-grid-composer-layout="true"');
    expect(markup.indexOf("data-editor")).toBeLessThan(markup.indexOf("data-controls"));
  });

  it("does not add layout chrome to the normal chat composer", () => {
    const markup = renderToStaticMarkup(
      <SessionGridComposerLayout
        compact={false}
        editor={<div data-editor>Prompt</div>}
        controls={<div data-controls>Controls</div>}
      />,
    );

    expect(markup).not.toContain("data-session-grid-composer-layout");
  });
});
