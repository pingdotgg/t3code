import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";

import type { PreviewPanelInlineSize } from "~/hooks/usePreviewPanelInlineSize";
import { PreviewPanelShell } from "./PreviewPanelShell";

const noop = () => {};
const INLINE_SIZE: PreviewPanelInlineSize = {
  width: 400,
  handlers: {
    ref: () => undefined,
    onPointerDown: noop,
    onPointerMove: noop,
    onPointerUp: noop,
    onPointerCancel: noop,
    onLostPointerCapture: noop,
  },
  observeRow: () => noop,
};

function Workspace(props: {
  open: boolean;
  showOpener?: boolean;
  openerInert?: boolean;
  showPanel?: boolean;
}) {
  return (
    <div className="flex h-96">
      <div className="flex-1">
        {props.showOpener === false ? null : (
          <input aria-label="Composer" inert={props.openerInert} />
        )}
        <button type="button" data-right-panel-toggle>
          Toggle right panel
        </button>
      </div>
      {props.showPanel === false ? null : (
        <PreviewPanelShell mode="inline" open={props.open} inlineSize={INLINE_SIZE}>
          <button type="button">Open a surface</button>
        </PreviewPanelShell>
      )}
    </div>
  );
}

describe("PreviewPanelShell", () => {
  it("returns focus to the element that had it before the panel opened when the panel closes", async () => {
    await using screen = await render(<Workspace open={false} />);
    const composer = page.getByRole("textbox", { name: "Composer" });
    composer.element().focus();

    await screen.rerender(<Workspace open />);
    // requestWorkspaceFocus moves focus into the panel after it opens.
    page.getByRole("button", { name: "Open a surface" }).element().focus();

    await screen.rerender(<Workspace open={false} />);
    await expect.element(composer).toHaveFocus();
  });

  it("returns focus to the opener when closing unmounts the panel without an exit animation", async () => {
    await using screen = await render(<Workspace open={false} showPanel={false} />);
    const composer = page.getByRole("textbox", { name: "Composer" });
    composer.element().focus();

    await screen.rerender(<Workspace open />);
    page.getByRole("button", { name: "Open a surface" }).element().focus();

    await screen.rerender(<Workspace open={false} showPanel={false} />);
    await expect.element(composer).toHaveFocus();
  });

  it("falls back to the panel toggle when the opener is gone by the time the panel closes", async () => {
    await using screen = await render(<Workspace open={false} />);
    page.getByRole("textbox", { name: "Composer" }).element().focus();

    await screen.rerender(<Workspace open />);
    page.getByRole("button", { name: "Open a surface" }).element().focus();
    await screen.rerender(<Workspace open showOpener={false} />);

    await screen.rerender(<Workspace open={false} showOpener={false} />);
    await expect.element(page.getByRole("button", { name: "Toggle right panel" })).toHaveFocus();
  });

  it("falls back to the panel toggle when the opener no longer takes focus", async () => {
    await using screen = await render(<Workspace open={false} />);
    page.getByRole("textbox", { name: "Composer" }).element().focus();

    await screen.rerender(<Workspace open />);
    page.getByRole("button", { name: "Open a surface" }).element().focus();
    await screen.rerender(<Workspace open openerInert />);

    await screen.rerender(<Workspace open={false} openerInert />);
    await expect.element(page.getByRole("button", { name: "Toggle right panel" })).toHaveFocus();
  });
});
