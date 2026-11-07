import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render, type Screen } from "../../../test/render";
import { PreviewPanelShell } from "./PreviewPanelShell";

function Workspace(props: { open: boolean; present?: boolean }) {
  return (
    <div>
      <input aria-label="Message New thread" />
      <button type="button" aria-label="Toggle right panel" data-right-panel-toggle />
      {(props.present ?? true) ? (
        <PreviewPanelShell mode="inline" open={props.open}>
          <div role="region" aria-label="Open a surface" tabIndex={-1} />
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
