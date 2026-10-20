import { describe, expect, it, vi } from "vite-plus/test";

import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { act, render as renderUi } from "../../../test/render";
import { ExpandedImageDialogHost, openExpandedImagePreview } from "./ExpandedImageDialog";

const preview = {
  images: [
    { src: "data:image/gif;base64,R0lGODlhAQABAAAAACw=", name: "one.png" },
    { src: "data:image/gif;base64,R0lGODlhAQABAAAAACw=", name: "two.png" },
  ],
  index: 0,
};

const host = (threadKey: string) => (
  <AppAtomRegistryProvider>
    <ExpandedImageDialogHost threadKey={threadKey} />
  </AppAtomRegistryProvider>
);

const dialog = () => document.querySelector('[role="dialog"]');

describe("ExpandedImageDialogHost", () => {
  it("opens for its thread, steps with arrows, and closes on Escape with focus back on the opener", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    using _opener = { [Symbol.dispose]: () => opener.remove() };
    await using _screen = await renderUi(host("env:a"));
    opener.focus();

    await act(() => openExpandedImagePreview("env:a", preview));
    expect(dialog()?.textContent).toContain("one.png (1/2)");

    await act(() => {
      dialog()?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(dialog()?.textContent).toContain("two.png (2/2)");

    await act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it("ignores another thread's preview and drops its own when the thread changes", async () => {
    await using screen = await renderUi(host("env:a"));
    await act(() => openExpandedImagePreview("env:b", preview));
    expect(dialog()).toBeNull();

    await act(() => openExpandedImagePreview("env:a", preview));
    expect(dialog()).not.toBeNull();

    await screen.rerender(host("env:b"));
    await vi.waitFor(() => expect(dialog()).toBeNull());
  });
});
