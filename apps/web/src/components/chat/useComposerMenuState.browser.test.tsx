import { act, StrictMode, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useComposerMenuState } from "./useComposerMenuState";

let root: Root;
let setOpen: ReturnType<typeof useComposerMenuState>[1];
let committedOpen: boolean[];
let closePopup = vi.fn<() => void>();

function MenuStateProbe({ hidden }: { hidden: boolean }) {
  const [open, updateOpen] = useComposerMenuState(hidden);
  useLayoutEffect(() => {
    setOpen = updateOpen;
    committedOpen.push(open);
    if (open) return closePopup;
  }, [open, updateOpen]);
  return null;
}

async function renderMenu(hidden: boolean) {
  await act(() => {
    root.render(
      <StrictMode>
        <MenuStateProbe hidden={hidden} />
      </StrictMode>,
    );
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  committedOpen = [];
  closePopup = vi.fn();
  root = createRoot(document.createElement("div"));
});

afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe("useComposerMenuState", () => {
  it("closes an open popup when its trigger hides and does not reopen when it returns", async () => {
    await renderMenu(false);
    await act(() => setOpen(true));
    expect(committedOpen.at(-1)).toBe(true);

    await renderMenu(true);
    expect(committedOpen.at(-1)).toBe(false);
    expect(closePopup).toHaveBeenCalledTimes(1);

    const afterClose = committedOpen.length;
    await renderMenu(false);
    expect(committedOpen).toHaveLength(afterClose);
    expect(committedOpen.at(-1)).toBe(false);

    await act(() => setOpen(true));
    expect(committedOpen.at(-1)).toBe(true);
    await act(() => setOpen(false));
    expect(committedOpen.at(-1)).toBe(false);
    expect(closePopup).toHaveBeenCalledTimes(2);
  });

  it("does not commit an open popup requested while its trigger is hidden", async () => {
    await renderMenu(true);
    await act(() => setOpen(true));
    await renderMenu(false);

    expect(committedOpen.every((open) => !open)).toBe(true);
    expect(closePopup).not.toHaveBeenCalled();
  });
});
