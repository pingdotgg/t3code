import { createElement, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  BROWSER_SURFACE_OVERLAY_ATTRIBUTE,
  BROWSER_SURFACE_Z_INDEX,
} from "@t3tools/extension-sdk/catalogue";
import {
  resolveFloatingLayer,
  type FloatingPopoverProps,
} from "@t3tools/extension-sdk/environment";

import { FLOATING_LAYER_Z_INDEX, hostFloatingLayer } from "./hostFloatingLayer";
import { FLOATING_VIEWPORT_MARGIN } from "./placement";

// The test renderer has no DOM: a portal renders as a marker element that
// records the container it targets.
vi.mock("react-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-dom")>()),
  createPortal: (node: ReactNode, container: unknown) =>
    createElement("portal-root", { container }, node),
}));

const BORDER = 2;
const ITEM_HEIGHT = 45;

function fixture(options: {
  viewport: { width: number; height: number };
  anchor: { left: number; top: number; right: number; bottom: number };
  items: number;
}) {
  const listeners = new Map<string, Set<() => void>>();
  const view = {
    innerWidth: options.viewport.width,
    innerHeight: options.viewport.height,
    addEventListener: (type: string, listener: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener: (type: string, listener: () => void) => {
      listeners.get(type)?.delete(listener);
    },
  };
  const body = { nodeName: "BODY" };
  const state = { anchor: options.anchor, items: options.items };
  const anchor = {
    ownerDocument: { body, defaultView: view },
    getBoundingClientRect: () => state.anchor,
  } as unknown as HTMLElement;
  // The popover element: its natural content height follows the item count,
  // and its box follows the height cap the host last rendered.
  let renderedMaxHeight: number | undefined;
  const popover = {
    offsetWidth: 240,
    get scrollHeight() {
      return state.items * ITEM_HEIGHT;
    },
    get offsetHeight() {
      const natural = state.items * ITEM_HEIGHT + BORDER;
      return renderedMaxHeight === undefined ? natural : Math.min(natural, renderedMaxHeight);
    },
    get clientHeight() {
      return this.offsetHeight - BORDER;
    },
  };
  return {
    view,
    body,
    anchor,
    popover,
    listeners,
    state,
    setRenderedMaxHeight(value: number | undefined) {
      renderedMaxHeight = value;
    },
  };
}

type Fixture = ReturnType<typeof fixture>;

const observers = {
  resize: [] as Array<{ callback: () => void; targets: unknown[]; disconnected: boolean }>,
  mutation: [] as Array<{ callback: () => void; disconnected: boolean }>,
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  observers.resize = [];
  observers.mutation = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      entry = { callback: () => {}, targets: [] as unknown[], disconnected: false };
      constructor(callback: () => void) {
        this.entry.callback = callback;
        observers.resize.push(this.entry);
      }
      observe(target: unknown) {
        this.entry.targets.push(target);
      }
      disconnect() {
        this.entry.disconnected = true;
      }
    },
  );
  vi.stubGlobal(
    "MutationObserver",
    class {
      entry = { callback: () => {}, disconnected: false };
      constructor(callback: () => void) {
        this.entry.callback = callback;
        observers.mutation.push(this.entry);
      }
      observe() {}
      disconnect() {
        this.entry.disconnected = true;
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function Menu(
  props: { anchor: HTMLElement | null; items: number } & Partial<FloatingPopoverProps>,
) {
  const { Popover } = hostFloatingLayer;
  const { items, ...rest } = props;
  return (
    <Popover role="menu" aria-label="Page" style={{ padding: 8, zIndex: 1 }} {...rest}>
      {Array.from({ length: items }, (_, index) => (
        <button key={index} type="button" role="menuitem">
          Item {index}
        </button>
      ))}
    </Popover>
  );
}

function render(f: Fixture, element: ReturnType<typeof createElement>) {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element, {
      createNodeMock: (node) =>
        (node.props as { role?: string }).role === "menu" ? f.popover : null,
    });
  });
  return renderer;
}

/** The rendered popover element (not the `Popover` component instance). */
function popoverElement(renderer: ReactTestRenderer) {
  return renderer.root.find((node) => node.type === "div" && node.props.role === "menu");
}

function popoverStyle(renderer: ReactTestRenderer) {
  return popoverElement(renderer).props.style as Record<string, unknown>;
}

/** Re-runs every host re-placement trigger, as the browser would after layout. */
function relayout(f: Fixture, renderer: ReactTestRenderer) {
  const max = popoverStyle(renderer).maxHeight;
  f.setRenderedMaxHeight(typeof max === "number" ? max : undefined);
  act(() => {
    for (const observer of observers.resize) if (!observer.disconnected) observer.callback();
  });
}

describe("hostFloatingLayer", () => {
  it("is offered as a version 1 floating layer", () => {
    expect(resolveFloatingLayer({ floatingLayer: hostFloatingLayer })).toBe(hostFloatingLayer);
  });

  it("portals the popover into the anchor's document above presented surfaces", () => {
    const f = fixture({
      viewport: { width: 800, height: 600 },
      anchor: { left: 400, top: 40, right: 424, bottom: 64 },
      items: 3,
    });
    const renderer = render(f, <Menu anchor={f.anchor} items={3} />);
    const portal = renderer.root.findByType("portal-root" as never);
    expect(portal.props.container).toBe(f.body);
    const menu = popoverElement(renderer);
    expect(portal.findAll((node) => node === menu)).toHaveLength(1);
    expect(menu.props["aria-label"]).toBe("Page");
    // The occlusion probe keeps the page presented under the marked popover.
    expect(menu.props[BROWSER_SURFACE_OVERLAY_ATTRIBUTE]).toBe("");
    const style = popoverStyle(renderer);
    expect(style.position).toBe("fixed");
    expect(style.zIndex).toBe(FLOATING_LAYER_Z_INDEX);
    expect(FLOATING_LAYER_Z_INDEX).toBeGreaterThan(BROWSER_SURFACE_Z_INDEX);
    // Plugin styling survives; the host owns only placement.
    expect(style.padding).toBe(8);
    // End-aligned under the anchor, and visible once measured.
    expect(style.top).toBe(64 + 6);
    expect(style.left).toBe(424 - 240);
    expect(style.visibility).toBeUndefined();
  });

  it("renders nothing without an anchor", () => {
    const f = fixture({
      viewport: { width: 800, height: 600 },
      anchor: { left: 0, top: 0, right: 0, bottom: 0 },
      items: 3,
    });
    const renderer = render(f, <Menu anchor={null} items={3} />);
    expect(renderer.toJSON()).toBeNull();
  });

  it("caps a menu taller than the viewport at the available height, and every item scrolls into view", () => {
    const viewport = { width: 800, height: 300 };
    const f = fixture({
      viewport,
      anchor: { left: 400, top: 40, right: 424, bottom: 64 },
      items: 20,
    });
    const renderer = render(f, <Menu anchor={f.anchor} items={20} />);
    relayout(f, renderer);
    const style = popoverStyle(renderer);
    const top = style.top as number;
    const maxHeight = style.maxHeight as number;
    expect(style.overflowY).toBe("auto");
    expect(maxHeight).toBe(viewport.height - FLOATING_VIEWPORT_MARGIN - (64 + 6));
    // The whole popover box stays on screen...
    expect(top).toBeGreaterThanOrEqual(0);
    expect(top + maxHeight).toBeLessThanOrEqual(viewport.height);
    // ...and its scroll range brings each item fully into the visible body.
    const visible = f.popover.clientHeight;
    const scrollRange = f.popover.scrollHeight - visible;
    expect(scrollRange).toBeGreaterThan(0);
    for (let index = 0; index < 20; index += 1) {
      const needed = Math.max(0, (index + 1) * ITEM_HEIGHT - visible);
      expect(needed, `item ${index}`).toBeLessThanOrEqual(scrollRange);
      expect(index * ITEM_HEIGHT - needed, `item ${index}`).toBeGreaterThanOrEqual(0);
    }
  });

  it("flips above an anchor near the bottom when there is more room there", () => {
    const viewport = { width: 800, height: 600 };
    const f = fixture({
      viewport,
      anchor: { left: 400, top: 500, right: 424, bottom: 524 },
      items: 8,
    });
    const renderer = render(f, <Menu anchor={f.anchor} items={8} />);
    const style = popoverStyle(renderer);
    expect(style.maxHeight).toBe(500 - 6 - FLOATING_VIEWPORT_MARGIN);
    // The natural 360px fits above: its bottom meets the anchor's offset.
    expect((style.top as number) + 8 * ITEM_HEIGHT + BORDER).toBe(500 - 6);
  });

  it("re-caps when the content grows or the viewport shrinks, and detaches on close", () => {
    const f = fixture({
      viewport: { width: 800, height: 600 },
      anchor: { left: 400, top: 40, right: 424, bottom: 64 },
      items: 4,
    });
    const renderer = render(f, <Menu anchor={f.anchor} items={4} />);
    expect(popoverStyle(renderer).maxHeight).toBe(600 - 8 - 70);
    // An expanded section (e.g. the profile import form) adds content.
    f.state.items = 30;
    act(() => {
      for (const observer of observers.mutation) observer.callback();
    });
    expect(popoverStyle(renderer).top).toBe(70);
    // A shorter window lowers the cap.
    f.view.innerHeight = 250;
    act(() => {
      for (const listener of f.listeners.get("resize") ?? []) listener();
    });
    expect(popoverStyle(renderer).maxHeight).toBe(250 - 8 - 70);
    act(() => renderer.unmount());
    expect(observers.resize.every((observer) => observer.disconnected)).toBe(true);
    expect(observers.mutation.every((observer) => observer.disconnected)).toBe(true);
    expect(f.listeners.get("resize")?.size ?? 0).toBe(0);
    expect(f.listeners.get("scroll")?.size ?? 0).toBe(0);
  });

  it("places an inset pill inside the anchor's top corner", () => {
    const f = fixture({
      viewport: { width: 800, height: 600 },
      anchor: { left: 100, top: 100, right: 700, bottom: 500 },
      items: 1,
    });
    const renderer = render(f, <Menu anchor={f.anchor} items={1} side="inset" offset={12} />);
    const style = popoverStyle(renderer);
    expect(style.top).toBe(112);
    expect(style.left).toBe(700 - 12 - 240);
  });
});
