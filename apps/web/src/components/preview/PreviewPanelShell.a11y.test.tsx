// @vitest-environment jsdom

import { Dialog } from "@base-ui/react/dialog";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { PanelLayoutControls } from "../chat/PanelLayoutControls";
import { PreviewPanelShell, type PreviewPanelMode } from "./PreviewPanelShell";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function renderPanel(
  open: boolean | undefined,
  mode: PreviewPanelMode = "inline",
  present = true,
) {
  await act(async () => {
    root.render(
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
                threadPanelHasAttention={false}
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
  });
  await act(async () => vi.advanceTimersToNextFrame());
}

async function enterFocusScope() {
  // Base UI's focus guard models Tab wrapping into the scope. Its production
  // focus manager chooses the first tabbable descendant, including inert rules
  // that jsdom's native focus() does not implement.
  const guards = document.querySelectorAll<HTMLElement>("[data-base-ui-focus-guard]");
  expect(guards.length).toBe(2);
  await act(async () => guards[1]!.focus());
  await act(async () => vi.advanceTimersToNextFrame());
}

describe("right panel keyboard access", () => {
  it("skips collapsed controls and restores access after reopening", async () => {
    await renderPanel(false);
    const outside = document.querySelector<HTMLElement>('[data-testid="outside"]')!;
    expect(document.activeElement).toBe(outside);
    await enterFocusScope();
    expect(document.activeElement).toBe(outside);

    await renderPanel(true);
    await enterFocusScope();
    expect(document.activeElement).toBe(document.querySelector('[aria-label="Preview URL"]'));

    await renderPanel(false);
    await enterFocusScope();
    expect(document.activeElement).toBe(outside);
  });

  it("returns focus to the right-panel toggle when a focused panel closes", async () => {
    await renderPanel(true);
    const input = document.querySelector<HTMLInputElement>('[aria-label="Preview URL"]')!;
    await act(async () => input.focus());
    await renderPanel(false);
    expect(document.activeElement).toBe(
      document.querySelector('[aria-label="Toggle right panel"]'),
    );
    await renderPanel(true);
    await enterFocusScope();
    expect(document.activeElement).toBe(input);
  });

  it("retains focus after the closing animation relocates the toggle", async () => {
    await renderPanel(true);
    await act(async () => {
      document.querySelector<HTMLInputElement>('[aria-label="Preview URL"]')!.focus();
    });
    await renderPanel(false);
    const closingToggle = document.querySelector('[aria-label="Toggle right panel"]');
    expect(document.activeElement).toBe(closingToggle);
    await renderPanel(false, "inline", false);
    const settledToggle = document.querySelector('[aria-label="Toggle right panel"]');
    expect(settledToggle).not.toBe(closingToggle);
    expect(document.activeElement).toBe(settledToggle);
  });

  it("returns focus when the panel closes without an animation", async () => {
    await renderPanel(true);
    await act(async () => {
      document.querySelector<HTMLInputElement>('[aria-label="Preview URL"]')!.focus();
    });
    await renderPanel(false, "inline", false);
    expect(document.activeElement).toBe(
      document.querySelector('[aria-label="Toggle right panel"]'),
    );
  });

  it("preserves focus moved outside while the closing animation settles", async () => {
    await renderPanel(true);
    await act(async () => {
      document.querySelector<HTMLInputElement>('[aria-label="Preview URL"]')!.focus();
    });
    await renderPanel(false);
    const outside = document.querySelector<HTMLButtonElement>('[data-testid="outside"]')!;
    await act(async () => outside.focus());
    await renderPanel(false, "inline", false);
    expect(document.activeElement).toBe(outside);
  });

  it("preserves focus outside the panel when it closes", async () => {
    await renderPanel(true);
    const outside = document.querySelector<HTMLButtonElement>('[data-testid="outside"]')!;
    await act(async () => outside.focus());
    await renderPanel(false);
    expect(document.activeElement).toBe(outside);
  });

  it.each(["sheet", "sidebar", "embedded"] as const)(
    "keeps %s controls reachable when the inline open flag is false",
    async (mode) => {
      await renderPanel(false, mode);
      expect(document.activeElement).toBe(document.querySelector('[aria-label="Preview URL"]'));
    },
  );

  it("keeps non-collapsible inline controls reachable", async () => {
    await renderPanel(undefined);
    expect(document.activeElement).toBe(document.querySelector('[aria-label="Preview URL"]'));
  });
});
