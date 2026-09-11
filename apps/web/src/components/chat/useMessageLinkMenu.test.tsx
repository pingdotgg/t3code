import { act, createRef, useImperativeHandle } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { useMessageLinkMenu } from "./useMessageLinkMenu";

let renderer: ReactTestRenderer | undefined;

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("message link menu positioning", () => {
  it.each([
    { position: { x: 0, y: 0 }, expected: { x: 120, y: 260 } },
    { position: { x: 145, y: 245 }, expected: { x: 145, y: 245 } },
    { position: { x: 0, y: 245 }, expected: { x: 0, y: 245 } },
    { position: { x: 145, y: 0 }, expected: { x: 145, y: 0 } },
  ])("anchors a menu opened at $position to $expected", async ({ position, expected }) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "DOMRect",
      class {
        constructor(
          readonly x: number,
          readonly y: number,
          readonly width: number,
          readonly height: number,
        ) {}
      },
    );
    const linkMenuRef = createRef<ReturnType<typeof useMessageLinkMenu>>();
    function TestLinkMenu() {
      const linkMenu = useMessageLinkMenu();
      useImperativeHandle(linkMenuRef, () => linkMenu, [linkMenu]);
      return null;
    }
    const trigger = {
      getBoundingClientRect: () => ({ left: 120, bottom: 260 }),
    } as HTMLElement;

    await act(() => {
      renderer = create(<TestLinkMenu />);
    });
    await act(() => {
      void linkMenuRef.current!.show([{ id: "copy-link", label: "Copy Link" }], position, trigger);
    });

    // Evaluate the virtual anchor consumed by the popup's positioning engine.
    const popup = linkMenuRef.current!.menu?.props.children;
    expect(popup.props.anchor.getBoundingClientRect()).toMatchObject({
      ...expected,
      width: 0,
      height: 0,
    });
  });
});
