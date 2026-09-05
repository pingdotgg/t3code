import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { observeVisibleAnimation } from "./visibleAnimation";

let page = Object.assign(new EventTarget(), { visibilityState: "visible" });
let motion = Object.assign(new EventTarget(), { matches: false });
let observers: TestIntersectionObserver[] = [];
let cleanups: Array<() => void> = [];

class TestIntersectionObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {
    observers.push(this);
  }

  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();

  report(target: Element, isIntersecting: boolean) {
    this.callback(
      [{ target, isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

function animationElement() {
  const properties = new Map<string, string>();
  const element = {
    style: { setProperty: (name: string, value: string) => properties.set(name, value) },
  } as unknown as HTMLElement;
  return {
    element,
    state: () => properties.get("--visible-animation-state"),
    willChange: () => properties.get("--visible-animation-will-change"),
  };
}

function attach(element: HTMLElement) {
  const cleanup = observeVisibleAnimation(element);
  if (cleanup) cleanups.push(cleanup);
  return cleanup;
}

beforeEach(() => {
  page = Object.assign(new EventTarget(), { visibilityState: "visible" });
  motion = Object.assign(new EventTarget(), { matches: false });
  observers = [];
  cleanups = [];
  vi.stubGlobal("document", page);
  vi.stubGlobal("window", { matchMedia: () => motion });
  vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
});

afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("observeVisibleAnimation", () => {
  it("runs only intersecting animations in a visible document with motion enabled", () => {
    const first = animationElement();
    const second = animationElement();
    attach(first.element);
    attach(second.element);
    expect(first.state()).toBe("paused");

    const observer = observers[0]!;
    observer.report(first.element, true);
    expect(first.state()).toBe("running");
    expect(second.state()).toBe("paused");

    page.visibilityState = "hidden";
    page.dispatchEvent(new Event("visibilitychange"));
    observer.report(second.element, true);
    expect(first.state()).toBe("paused");
    expect(first.willChange()).toBe("auto");
    expect(second.state()).toBe("paused");

    page.visibilityState = "visible";
    page.dispatchEvent(new Event("visibilitychange"));
    expect(first.state()).toBe("running");
    expect(second.state()).toBe("running");

    observer.report(first.element, false);
    motion.matches = true;
    motion.dispatchEvent(new Event("change"));
    expect(first.state()).toBe("paused");
    expect(second.state()).toBe("paused");

    motion.matches = false;
    motion.dispatchEvent(new Event("change"));
    expect(first.state()).toBe("paused");
    expect(second.state()).toBe("running");
  });

  it.each(["hidden", "reduced motion"])("starts paused with %s already active", (condition) => {
    page.visibilityState = condition === "hidden" ? "hidden" : "visible";
    motion.matches = condition === "reduced motion";
    const animation = animationElement();
    attach(animation.element);
    observers[0]!.report(animation.element, true);
    expect(animation.state()).toBe("paused");

    page.visibilityState = "visible";
    motion.matches = false;
    page.dispatchEvent(new Event("visibilitychange"));
    expect(animation.state()).toBe("running");
  });

  it("shares observers, releases the final ref, and ignores late callbacks after remount", () => {
    const addVisibility = vi.spyOn(page, "addEventListener");
    const removeVisibility = vi.spyOn(page, "removeEventListener");
    const addMotion = vi.spyOn(motion, "addEventListener");
    const removeMotion = vi.spyOn(motion, "removeEventListener");
    const first = animationElement();
    const second = animationElement();
    const detachFirst = attach(first.element);
    const detachSecond = attach(second.element);
    expect(observers).toHaveLength(1);
    expect(addVisibility).toHaveBeenCalledTimes(1);
    expect(addMotion).toHaveBeenCalledTimes(1);

    const previousObserver = observers[0]!;
    detachFirst?.();
    previousObserver.report(first.element, true);
    expect(first.state()).toBe("paused");
    expect(previousObserver.unobserve).toHaveBeenCalledWith(first.element);
    expect(previousObserver.disconnect).not.toHaveBeenCalled();

    detachSecond?.();
    expect(previousObserver.disconnect).toHaveBeenCalledTimes(1);
    expect(removeVisibility).toHaveBeenCalledTimes(1);
    expect(removeMotion).toHaveBeenCalledTimes(1);

    attach(second.element);
    expect(observers).toHaveLength(2);
    detachSecond?.();
    previousObserver.report(second.element, true);
    expect(second.state()).toBe("paused");
    observers[1]!.report(second.element, true);
    expect(second.state()).toBe("running");
  });

  it("keeps unknown visibility static when IntersectionObserver is unavailable", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const animation = animationElement();
    attach(animation.element);
    expect(animation.state()).toBe("paused");
    expect(animation.willChange()).toBe("auto");
    expect(observers).toHaveLength(0);
  });
});
