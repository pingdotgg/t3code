import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render, type Screen } from "../../../test/render";
import { PreviewPanelShell } from "./PreviewPanelShell";

function Workspace(props: { open: boolean; present?: boolean; children?: ReactNode }) {
  return (
    <div>
      <input aria-label="Message New thread" />
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
