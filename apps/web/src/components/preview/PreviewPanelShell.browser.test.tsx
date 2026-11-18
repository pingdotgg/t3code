import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render, type Screen } from "../../../test/render";
import { PreviewPanelShell } from "./PreviewPanelShell";

function Workspace(props: { open: boolean; present?: boolean; children?: ReactNode }) {
  return (
    <div>
      <div data-workspace-area="composer">
        <input aria-label="Message New thread" />
      </div>
      <button type="button" aria-label="Toggle right panel" data-right-panel-toggle />
      {(props.present ?? true) ? (
        <PreviewPanelShell mode="inline" open={props.open}>
          {props.children ?? <div role="region" aria-label="Open a surface" tabIndex={-1} />}
        </PreviewPanelShell>
      ) : null}
    </div>
  );
}

// Mirrors rightPanel.toggle from the composer: the panel opens and the shortcut focuses its content.
async function openPanelFromComposer(screen: Screen) {
  await userEvent.click(screen.getByRole("textbox", { name: "Message New thread" }));
  await screen.rerender(<Workspace open />);
  await act(() => screen.getByRole("region", { name: "Open a surface" }).element().focus());
}

describe("PreviewPanelShell focus", () => {
  it("returns focus to the composer when a panel opened from it collapses", async () => {
    await using screen = await render(<Workspace open={false} />);
    await openPanelFromComposer(screen);

    await screen.rerender(<Workspace open={false} />);

    await expect.element(screen.getByRole("textbox", { name: "Message New thread" })).toHaveFocus();
  });

  it("returns focus to the composer when a panel opened from it unmounts", async () => {
    await using screen = await render(<Workspace open={false} />);
    await openPanelFromComposer(screen);

    await screen.rerender(<Workspace open={false} present={false} />);

    await expect.element(screen.getByRole("textbox", { name: "Message New thread" })).toHaveFocus();
  });

  it("returns focus to the composer when the panel's content takes focus as it mounts", async () => {
    // A terminal surface focuses itself from its ref callback, before the shell's own ref attaches.
    const focusOnMount = (element: HTMLElement | null) => element?.focus();
    const panel = (present: boolean) => (
      <Workspace open present={present}>
        <div role="region" aria-label="Terminal" tabIndex={-1} ref={focusOnMount} />
      </Workspace>
    );
    await using screen = await render(panel(false));
    await userEvent.click(screen.getByRole("textbox", { name: "Message New thread" }));
    await screen.rerender(panel(true));
    await expect.element(screen.getByRole("region", { name: "Terminal" })).toHaveFocus();

    await screen.rerender(panel(false));

    await expect.element(screen.getByRole("textbox", { name: "Message New thread" })).toHaveFocus();
  });

  it("keeps the composer as the origin after focus visits a menu portalled from the panel", async () => {
    const panel = (open: boolean) => (
      <Workspace open={open}>
        <div role="region" aria-label="Open a surface" tabIndex={-1} />
        {createPortal(<button type="button">Add panel surface</button>, document.body)}
      </Workspace>
    );
    await using screen = await render(panel(false));
    await userEvent.click(screen.getByRole("textbox", { name: "Message New thread" }));
    await screen.rerender(panel(true));
    await act(() => screen.getByRole("region", { name: "Open a surface" }).element().focus());
    await act(() => page.getByRole("button", { name: "Add panel surface" }).element().focus());
    await act(() => screen.getByRole("region", { name: "Open a surface" }).element().focus());

    await screen.rerender(panel(false));

    await expect.element(screen.getByRole("textbox", { name: "Message New thread" })).toHaveFocus();
  });

  it("falls back to the toggle without scrolling when the origin has scrolled out of view", async () => {
    const layout = (open: boolean) => (
      <div>
        <div
          data-testid="timeline"
          data-workspace-area="conversation"
          style={{ height: 100, overflowY: "auto" }}
        >
          <button type="button">Copy message</button>
          <div style={{ height: 2000 }} />
        </div>
        <button type="button" aria-label="Toggle right panel" data-right-panel-toggle />
        <PreviewPanelShell mode="inline" open={open}>
          <div role="region" aria-label="Open a surface" tabIndex={-1} />
        </PreviewPanelShell>
      </div>
    );
    await using screen = await render(layout(false));
    await userEvent.click(screen.getByRole("button", { name: "Copy message" }));
    await screen.rerender(layout(true));
    await act(() => screen.getByRole("region", { name: "Open a surface" }).element().focus());
    const timeline = screen.getByTestId("timeline").element();
    timeline.scrollTop = 1500;

    await screen.rerender(layout(false));

    await expect.element(screen.getByRole("button", { name: "Toggle right panel" })).toHaveFocus();
    expect(timeline.scrollTop).toBe(1500);
  });

  it("falls back to the toggle when the origin's drawer is closing", async () => {
    // A closing drawer stays mounted for its exit animation but is no longer a workspace area.
    const layout = (open: boolean, drawerOpen: boolean) => (
      <div>
        <div data-workspace-area={drawerOpen ? "terminal" : undefined}>
          <input aria-label="Terminal input" />
        </div>
        <button type="button" aria-label="Toggle right panel" data-right-panel-toggle />
        <PreviewPanelShell mode="inline" open={open}>
          <div role="region" aria-label="Open a surface" tabIndex={-1} />
        </PreviewPanelShell>
      </div>
    );
    await using screen = await render(layout(false, true));
    await userEvent.click(screen.getByRole("textbox", { name: "Terminal input" }));
    await screen.rerender(layout(true, true));
    await act(() => screen.getByRole("region", { name: "Open a surface" }).element().focus());
    await screen.rerender(layout(true, false));

    await screen.rerender(layout(false, false));

    await expect.element(screen.getByRole("button", { name: "Toggle right panel" })).toHaveFocus();
  });

  it("does not return focus to the origin of an earlier open", async () => {
    await using screen = await render(<Workspace open={false} />);
    await openPanelFromComposer(screen);
    await screen.rerender(<Workspace open={false} />);
    const composer = screen.getByRole("textbox", { name: "Message New thread" });
    await expect.element(composer).toHaveFocus();
    await act(() => composer.element().blur());
    await screen.rerender(<Workspace open />);
    await act(() => screen.getByRole("region", { name: "Open a surface" }).element().focus());

    await screen.rerender(<Workspace open={false} />);

    await expect.element(screen.getByRole("button", { name: "Toggle right panel" })).toHaveFocus();
  });

  it("returns focus to the toggle when a panel opened from it collapses", async () => {
    await using screen = await render(<Workspace open={false} />);
    await userEvent.click(screen.getByRole("textbox", { name: "Message New thread" }));
    await userEvent.click(screen.getByRole("button", { name: "Toggle right panel" }));
    await screen.rerender(<Workspace open />);
    await act(() => screen.getByRole("region", { name: "Open a surface" }).element().focus());

    await screen.rerender(<Workspace open={false} />);

    await expect.element(screen.getByRole("button", { name: "Toggle right panel" })).toHaveFocus();
  });
});
