import { StrictMode, useLayoutEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { useComposerMenuState } from "./useComposerMenuState";

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

const menu = (hidden: boolean) => (
  <StrictMode>
    <MenuStateProbe hidden={hidden} />
  </StrictMode>
);

function setup() {
  committedOpen = [];
  closePopup = vi.fn();
}

describe("useComposerMenuState", () => {
  it("closes an open popup when its trigger hides and does not reopen when it returns", async () => {
    setup();
    await using screen = await render(menu(false));
    await act(() => setOpen(true));
    expect(committedOpen.at(-1)).toBe(true);

    await screen.rerender(menu(true));
    expect(committedOpen.at(-1)).toBe(false);
    expect(closePopup).toHaveBeenCalledTimes(1);

    const afterClose = committedOpen.length;
    await screen.rerender(menu(false));
    expect(committedOpen).toHaveLength(afterClose);
    expect(committedOpen.at(-1)).toBe(false);

    await act(() => setOpen(true));
    expect(committedOpen.at(-1)).toBe(true);
    await act(() => setOpen(false));
    expect(committedOpen.at(-1)).toBe(false);
    expect(closePopup).toHaveBeenCalledTimes(2);
  });

  it("does not commit an open popup requested while its trigger is hidden", async () => {
    setup();
    await using screen = await render(menu(true));
    await act(() => setOpen(true));
    await screen.rerender(menu(false));

    expect(committedOpen.every((open) => !open)).toBe(true);
    expect(closePopup).not.toHaveBeenCalled();
  });
});
