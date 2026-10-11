// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import { isPreviewFocused } from "~/lib/previewFocus";
import { PreviewChromeRow } from "./PreviewChromeRow";

const NOOP = () => {};

async function renderInPanel(onSubmit: (url: string) => void) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const panel = document.createElement("div");
  panel.dataset.previewPanelMode = "inline";
  document.body.append(panel);
  const root = createRoot(panel);
  await act(async () => {
    root.render(
      <PreviewChromeRow
        url="http://localhost:5173/"
        loading={false}
        canGoBack={false}
        canGoForward={false}
        refreshDisabled={false}
        onBack={NOOP}
        onForward={NOOP}
        onRefresh={NOOP}
        onSubmit={onSubmit}
      />,
    );
  });
  const input = panel.querySelector<HTMLInputElement>("[data-preview-url-input]")!;
  const cleanup = async () => {
    await act(async () => root.unmount());
    panel.remove();
    vi.unstubAllGlobals();
  };
  return { input, cleanup };
}

it.each(["Enter", "Escape"])("keeps preview focus after %s in the URL input", async (key) => {
  const onSubmit = vi.fn();
  const { input, cleanup } = await renderInPanel(onSubmit);
  try {
    await act(async () => input.focus());
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });
    expect(onSubmit).toHaveBeenCalledTimes(key === "Enter" ? 1 : 0);
    expect(document.activeElement).not.toBe(input);
    // mod+r refreshes the preview only while this holds.
    expect(isPreviewFocused()).toBe(true);
  } finally {
    await cleanup();
  }
});
