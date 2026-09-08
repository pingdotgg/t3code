import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { SidebarPullSurface } from "./SidebarPullSurface";

const hooks = vi.hoisted(() => ({
  refs: [] as unknown[],
  effect: undefined as (() => void | (() => void)) | undefined,
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useRef: () => ({ current: hooks.refs.shift() }),
  useLayoutEffect: (effect: () => void | (() => void)) => {
    hooks.effect = effect;
  },
}));

class TestElement extends EventTarget {
  scrollTop = 0;
  dataset: Record<string, string> = {};
  properties = new Map<string, string>();
  style = {
    transform: "",
    overflowY: "",
    overscrollBehaviorY: "contain",
    setProperty: (name: string, value: string) => this.properties.set(name, value),
  };
  querySelector = vi.fn();
  closest = vi.fn(() => null);
}

let cleanup: void | (() => void);

function mount(supportsScrollEnd = true) {
  const root = new TestElement();
  const surface = new TestElement();
  const scroller = new TestElement();
  const correction = new TestElement();
  const viewport = new TestElement();
  if (supportsScrollEnd) Object.assign(scroller, { onscrollend: null });
  root.querySelector.mockReturnValue(new TestElement());
  surface.querySelector.mockReturnValue(viewport);
  hooks.refs = [root, surface, scroller, correction];
  SidebarPullSurface({ header: null, footer: null, children: null });
  cleanup = hooks.effect?.();
  return { root, surface, scroller, correction, viewport };
}

function touch(target: TestElement, type: string, x: number, y: number) {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { touches: [{ clientX: x, clientY: y }] });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", new EventTarget());
  vi.stubGlobal("Element", TestElement);
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.unstubAllGlobals();
});

describe("sidebar pull gesture lifecycle", () => {
  it("returns native scrolling when a pull reverses past its starting point", () => {
    const { root, surface } = mount();
    touch(surface, "touchstart", 50, 100);
    expect(touch(surface, "touchmove", 50, 160).defaultPrevented).toBe(true);
    expect(root.dataset.pulling).toBe("true");
    expect(touch(surface, "touchmove", 50, 80).defaultPrevented).toBe(false);
    expect(root.dataset.pulling).toBe("false");
    expect(root.properties.get("--sidebar-pull-offset")).toBe("0px");
    expect(touch(surface, "touchmove", 50, 180).defaultPrevented).toBe(false);
  });

  it("releases an active pull when the gesture becomes horizontal", () => {
    const { root, surface } = mount();
    touch(surface, "touchstart", 50, 100);
    touch(surface, "touchmove", 50, 160);
    expect(touch(surface, "touchmove", 200, 160).defaultPrevented).toBe(false);
    expect(root.dataset.pulling).toBe("false");
  });

  it("disables decorative pulling without scrollend and preserves list scrolling", () => {
    const { root, surface, scroller, viewport } = mount(false);
    expect(scroller.style.overflowY).toBe("hidden");
    expect(scroller.scrollTop).toBe(720);
    expect(viewport.style.overscrollBehaviorY).toBe("contain");
    touch(surface, "touchstart", 50, 100);
    expect(touch(surface, "touchmove", 50, 160).defaultPrevented).toBe(false);
    const wheel = new Event("wheel", { cancelable: true });
    Object.assign(wheel, { deltaX: 0, deltaY: -100, buttons: 0 });
    surface.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
    expect(scroller.style.overflowY).toBe("hidden");
    expect(root.dataset.pulling).not.toBe("true");
  });

  it("holds a supported native pull until scrollend and restores it on cleanup", () => {
    const { root, scroller, correction, viewport } = mount();
    scroller.scrollTop = 620;
    scroller.dispatchEvent(new Event("scroll"));
    expect(root.dataset.pulling).toBe("true");
    expect(correction.style.transform).toBe("translateY(-100px)");
    scroller.dispatchEvent(new Event("scrollend"));
    expect(root.dataset.pulling).toBe("false");
    expect(scroller.scrollTop).toBe(720);
    expect(correction.style.transform).toBe("");
    cleanup?.();
    cleanup = undefined;
    expect(viewport.style.overscrollBehaviorY).toBe("contain");
    scroller.scrollTop = 620;
    scroller.dispatchEvent(new Event("scroll"));
    expect(root.dataset.pulling).toBe("false");
  });
});
