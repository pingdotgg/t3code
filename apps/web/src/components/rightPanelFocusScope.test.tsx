import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { RightPanelFocusProvider } from "./RightPanelFocusProvider";
import { useRightPanelFocusScope } from "./rightPanelFocusScope";

function FocusScopeProbe() {
  const inRightPanelFocusScope = useRightPanelFocusScope();

  return <span data-in-right-panel-focus-scope={inRightPanelFocusScope} />;
}

describe("RightPanelFocusProvider", () => {
  it("does not claim content outside the right panel", () => {
    expect(renderToStaticMarkup(<FocusScopeProbe />)).toContain(
      'data-in-right-panel-focus-scope="false"',
    );
  });

  it("claims content rendered inside the right panel", () => {
    expect(
      renderToStaticMarkup(
        <RightPanelFocusProvider>
          <FocusScopeProbe />
        </RightPanelFocusProvider>,
      ),
    ).toContain('data-in-right-panel-focus-scope="true"');
  });
});
