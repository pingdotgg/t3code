import { createElement, type ComponentType } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { FloatingPopoverProps } from "@t3tools/extension-sdk/environment";

// The pack is not a web dependency, so this project cannot type-check its
// source; the menu is loaded by path and typed by the props used here.
const { PageMenu, ZoomIndicator } = (await import(
  "../../../../packages/first-party-extensions/browser/pageMenu.tsx" as string
)) as {
  ZoomIndicator: ComponentType<{
    zoomFactor: number | null;
    zIndex: number;
    style: object;
    visible: boolean;
  }>;
  PageMenu: ComponentType<{
    host: object;
    session: object | null;
    blockReason: string | null;
    run: () => void;
    zoomStep: () => void;
    floating: { Popover: ComponentType<FloatingPopoverProps>; style: object };
    visible: boolean;
  }>;
};

// Stands in for the host layer, which portals the menu out of the panel: nothing
// the panel's hidden shell does can reach it.
function Popover({
  anchor: _anchor,
  elementRef: _elementRef,
  ...attributes
}: FloatingPopoverProps) {
  return createElement("div", attributes);
}

const session = {
  appearance: "system",
  zoomFactor: 1,
  audioMuted: false,
  devToolsOpen: false,
  pictureInPicture: false,
};

function menu(visible: boolean) {
  // No host tooltip: the trigger renders alone.
  return createElement(PageMenu, {
    host: {},
    session,
    blockReason: null,
    run: () => {},
    zoomStep: () => {},
    floating: { Popover, style: {} },
    visible,
  });
}

const openMenus = (renderer: ReactTestRenderer) =>
  renderer.root.findAll((node) => node.type === "div" && node.props.role === "menu");

function toggle(renderer: ReactTestRenderer) {
  const trigger = renderer.root.find((node) => node.props["aria-label"] === "Preview menu");
  act(() => trigger.props.onClick());
}

describe("Browser page menu", () => {
  // The open menu listens on the document for outside presses and Escape.
  beforeEach(() => {
    vi.stubGlobal("document", { addEventListener: () => {}, removeEventListener: () => {} });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("closes when the retained panel is hidden and stays closed when it returns", () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(menu(true));
    });
    toggle(renderer);
    expect(openMenus(renderer)).toHaveLength(1);

    act(() => renderer.update(menu(false)));
    expect(openMenus(renderer)).toHaveLength(0);

    act(() => renderer.update(menu(true)));
    expect(openMenus(renderer)).toHaveLength(0);

    toggle(renderer);
    expect(openMenus(renderer)).toHaveLength(1);
    act(() => renderer.unmount());
  });
});

describe("Browser zoom indicator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const pill = (zoomFactor: number, visible: boolean) =>
    createElement(ZoomIndicator, {
      zoomFactor,
      zIndex: 31,
      style: {},
      visible,
    });
  const pills = (renderer: ReactTestRenderer) =>
    renderer.root.findAll((node) => node.type === "div" && node.props.role === "status");

  // Native keeps its pill inside the panel, so hiding hides it and its timer runs on.
  it("never shows while the retained panel is hidden", () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(pill(1, true));
    });
    act(() => renderer.update(pill(1.25, true)));
    expect(pills(renderer)).toHaveLength(1);

    act(() => renderer.update(pill(1.25, false)));
    expect(pills(renderer)).toHaveLength(0);

    act(() => renderer.update(pill(1.5, false)));
    expect(pills(renderer)).toHaveLength(0);

    act(() => {
      vi.advanceTimersByTime(1500);
    });
    act(() => renderer.update(pill(1.5, true)));
    expect(pills(renderer)).toHaveLength(0);
    act(() => renderer.unmount());
  });
});
