import { StrictMode } from "react";
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
const focusOnMount = (element: HTMLElement | null) => element?.focus();

function Workspace(props: {
  open: boolean;
  showOpener?: boolean;
  openerInert?: boolean;
  showPanel?: boolean;
  surfaceFocusesOnMount?: boolean;
}) {
  // The app renders in StrictMode, which replays layout effect cleanups on mount.
  return (
    <StrictMode>
      <div className="flex h-96">
        <div className="flex-1">
          <div className="h-24 overflow-auto" data-testid="history">
            <button type="button">View diff</button>
            <div className="h-[2000px]" />
          </div>
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
            {props.surfaceFocusesOnMount ? (
              <input aria-label="Terminal" ref={focusOnMount} />
            ) : null}
          </PreviewPanelShell>
        )}
      </div>
    </StrictMode>
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

  it("returns focus to the opener when a surface takes focus while the panel mounts", async () => {
    await using screen = await render(<Workspace open={false} showPanel={false} />);
    const composer = page.getByRole("textbox", { name: "Composer" });
    composer.element().focus();

    await screen.rerender(<Workspace open surfaceFocusesOnMount />);
    await expect.element(page.getByRole("textbox", { name: "Terminal" })).toHaveFocus();

    await screen.rerender(<Workspace open={false} showPanel={false} />);
    await expect.element(composer).toHaveFocus();
  });

  it("does not scroll an opener that left the view back into it", async () => {
    await using screen = await render(<Workspace open={false} />);
    page.getByRole("button", { name: "View diff" }).element().focus();

    await screen.rerender(<Workspace open />);
    page.getByRole("button", { name: "Open a surface" }).element().focus();
    const history = page.getByTestId("history").element();
    history.scrollTop = history.scrollHeight;
    const scrolledTo = history.scrollTop;

    await screen.rerender(<Workspace open={false} />);
    await expect.element(page.getByRole("button", { name: "Toggle right panel" })).toHaveFocus();
    expect(history.scrollTop).toBe(scrolledTo);
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
