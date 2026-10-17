import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { ExpandedImageDialogHost, openExpandedImagePreview } from "./ExpandedImageDialog";

let root: Root;
let container: HTMLDivElement;

const preview = {
  images: [
    { src: "data:image/gif;base64,R0lGODlhAQABAAAAACw=", name: "one.png" },
    { src: "data:image/gif;base64,R0lGODlhAQABAAAAACw=", name: "two.png" },
  ],
  index: 0,
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

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
    await act(() => root.render(host("env:a")));
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
    opener.remove();
  });

  it("ignores another thread's preview and drops its own when the thread changes", async () => {
    await act(() => root.render(host("env:a")));
    await act(() => openExpandedImagePreview("env:b", preview));
    expect(dialog()).toBeNull();

    await act(() => openExpandedImagePreview("env:a", preview));
    expect(dialog()).not.toBeNull();

    await act(() => root.render(host("env:b")));
    await vi.waitFor(() => expect(dialog()).toBeNull());
  });
});
