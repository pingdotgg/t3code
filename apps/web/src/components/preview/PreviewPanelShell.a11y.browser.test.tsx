import { act, render, type Screen } from "../../../test/render";
import { Dialog } from "@base-ui/react/dialog";
import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { PanelLayoutControls } from "../chat/PanelLayoutControls";
import { PreviewPanelShell, type PreviewPanelMode } from "./PreviewPanelShell";

async function renderPanel(
  screen: Screen,
  open: boolean | undefined,
  mode: PreviewPanelMode = "inline",
  present = true,
) {
  await screen.rerender(
    <Dialog.Root open>
      <Dialog.Portal>
        <Dialog.Popup aria-label="Workspace" finalFocus={false}>
          {present ? (
            <PreviewPanelShell mode={mode} {...(open === undefined ? {} : { open })}>
              <input aria-label="Preview URL" />
              <button type="button">Reload preview</button>
            </PreviewPanelShell>
          ) : null}
          <button type="button" data-testid="outside">
            Send message
          </button>
          <div key={present ? "root-controls" : "header-controls"}>
            <PanelLayoutControls
              showTerminalControl={false}
              showThreadPanelControl={false}
              terminalAvailable={false}
              terminalOpen={false}
              terminalShortcutLabel={null}
              threadPanelOpen={false}
              threadPanelPresentation="inline"
              threadPanelShortcutLabel={null}
              rightPanelAvailable
              rightPanelOpen={open ?? true}
              rightPanelShortcutLabel={null}
              onToggleTerminal={() => {}}
              onToggleThreadPanel={() => {}}
              onToggleRightPanel={() => {}}
            />
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>,
  );
  await act(nextFrame);
}

function nextFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

// Tabbing past the popup's last control wraps through Base UI's focus guard
// to the first tabbable descendant, which skips anything inert.
async function enterFocusScope() {
  const toggle = document.querySelector<HTMLElement>('[aria-label="Toggle right panel"]')!;
  await act(async () => toggle.focus());
  await act(() => userEvent.tab());
  await act(nextFrame);
}

describe("right panel keyboard access", () => {
  it("skips collapsed controls and restores access after reopening", async () => {
    await using screen = await render(null);
    await renderPanel(screen, false);
    const outside = document.querySelector<HTMLElement>('[data-testid="outside"]')!;
    expect(document.activeElement).toBe(outside);
    await enterFocusScope();
    expect(document.activeElement).toBe(outside);

    await renderPanel(screen, true);
    await enterFocusScope();
    expect(document.activeElement).toBe(document.querySelector('[aria-label="Preview URL"]'));

    await renderPanel(screen, false);
    await enterFocusScope();
    expect(document.activeElement).toBe(outside);
  });

  it("returns focus to the right-panel toggle when a focused panel closes", async () => {
    await using screen = await render(null);
    await renderPanel(screen, true);
    const input = document.querySelector<HTMLInputElement>('[aria-label="Preview URL"]')!;
    await act(async () => input.focus());
    await renderPanel(screen, false);
    expect(document.activeElement).toBe(
      document.querySelector('[aria-label="Toggle right panel"]'),
    );
    await renderPanel(screen, true);
    await enterFocusScope();
    expect(document.activeElement).toBe(input);
  });

  it("retains focus after the closing animation relocates the toggle", async () => {
    await using screen = await render(null);
    await renderPanel(screen, true);
    await act(async () => {
      document.querySelector<HTMLInputElement>('[aria-label="Preview URL"]')!.focus();
    });
    await renderPanel(screen, false);
    const closingToggle = document.querySelector('[aria-label="Toggle right panel"]');
    expect(document.activeElement).toBe(closingToggle);
    await renderPanel(screen, false, "inline", false);
    const settledToggle = document.querySelector('[aria-label="Toggle right panel"]');
    expect(settledToggle).not.toBe(closingToggle);
    expect(document.activeElement).toBe(settledToggle);
  });

  it("returns focus when the panel closes without an animation", async () => {
    await using screen = await render(null);
    await renderPanel(screen, true);
    await act(async () => {
      document.querySelector<HTMLInputElement>('[aria-label="Preview URL"]')!.focus();
    });
    await renderPanel(screen, false, "inline", false);
    expect(document.activeElement).toBe(
      document.querySelector('[aria-label="Toggle right panel"]'),
    );
  });

  it("preserves focus moved outside while the closing animation settles", async () => {
    await using screen = await render(null);
    await renderPanel(screen, true);
    await act(async () => {
      document.querySelector<HTMLInputElement>('[aria-label="Preview URL"]')!.focus();
    });
    await renderPanel(screen, false);
    const outside = document.querySelector<HTMLButtonElement>('[data-testid="outside"]')!;
    await act(async () => outside.focus());
    await renderPanel(screen, false, "inline", false);
    expect(document.activeElement).toBe(outside);
  });

  it("preserves focus outside the panel when it closes", async () => {
    await using screen = await render(null);
    await renderPanel(screen, true);
    const outside = document.querySelector<HTMLButtonElement>('[data-testid="outside"]')!;
    await act(async () => outside.focus());
    await renderPanel(screen, false);
    expect(document.activeElement).toBe(outside);
  });

  it.each(["sheet", "sidebar", "embedded"] as const)(
    "keeps %s controls reachable when the inline open flag is false",
    async (mode) => {
      await using screen = await render(null);
      await renderPanel(screen, false, mode);
      expect(document.activeElement).toBe(document.querySelector('[aria-label="Preview URL"]'));
    },
  );

  it("keeps non-collapsible inline controls reachable", async () => {
    await using screen = await render(null);
    await renderPanel(screen, undefined);
    expect(document.activeElement).toBe(document.querySelector('[aria-label="Preview URL"]'));
  });
});
