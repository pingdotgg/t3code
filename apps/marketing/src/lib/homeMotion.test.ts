import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { startHomeMotion } from "./homeMotion";

class ElementStub extends EventTarget {
  properties = new Map<string, string>();
  style = { setProperty: (name: string, value: string) => this.properties.set(name, value) };
  children: ElementStub[] = [];
  scrollLeft = 0;
  scrollWidth = 1_200;
  clientWidth = 400;
  matches = () => false;
  contains = (target: EventTarget | null) =>
    target === this || (target instanceof ElementStub && this.children.includes(target));
  querySelectorAll = () => this.children;
  getBoundingClientRect = vi.fn(() => ({ left: 0, top: 0, width: 400, height: 600 }));
  scrollTo = vi.fn((options: ScrollToOptions) => {
    this.scrollLeft = options.left ?? this.scrollLeft;
  });
}

let observers: ObserverStub[] = [];
class ObserverStub {
  constructor(private readonly callback: IntersectionObserverCallback) {
    observers.push(this);
  }
  observe = vi.fn();
  disconnect = vi.fn();
  report(target: ElementStub, isIntersecting: boolean) {
    this.callback(
      [{ target, isIntersecting } as unknown as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

let page = Object.assign(new EventTarget(), { visibilityState: "visible", activeElement: null });
let viewport = new EventTarget();
let reduced = Object.assign(new EventTarget(), { matches: false });
let fine = Object.assign(new EventTarget(), { matches: true });
let frames = new Map<number, FrameRequestCallback>();
let dispose: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  observers = [];
  frames = new Map();
  page = Object.assign(new EventTarget(), { visibilityState: "visible", activeElement: null });
  viewport = new EventTarget();
  reduced = Object.assign(new EventTarget(), { matches: false });
  fine = Object.assign(new EventTarget(), { matches: true });
  vi.stubGlobal("document", page);
  vi.stubGlobal(
    "window",
    Object.assign(viewport, {
      matchMedia: (query: string) => (query.includes("reduced-motion") ? reduced : fine),
    }),
  );
  vi.stubGlobal("Node", ElementStub);
  vi.stubGlobal("IntersectionObserver", ObserverStub);
  let frameId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function fixture() {
  const hero = new ElementStub();
  const field = new ElementStub();
  const mark = new ElementStub();
  const otherMark = new ElementStub();
  field.children = [mark, otherMark];
  const endorsements = new ElementStub();
  const caret = new ElementStub();
  dispose = startHomeMotion({ hero, field, endorsements, caret } as unknown as Parameters<
    typeof startHomeMotion
  >[0]);
  return { hero, field, mark, otherMark, endorsements, caret, observer: observers[0]! };
}

function movePointer(hero: ElementStub, x = 400, y = 600) {
  hero.dispatchEvent(Object.assign(new Event("pointermove"), { clientX: x, clientY: y }));
}

describe("homepage motion", () => {
  it("gates each mark and caret and batches pointer input into one frame", () => {
    const { hero, field, mark, otherMark, caret, observer } = fixture();
    expect(mark.properties.get("--home-motion-state")).toBe("paused");
    observer.report(mark, true);
    observer.report(caret, true);
    expect(mark.properties.get("--home-motion-state")).toBe("running");
    expect(otherMark.properties.get("--home-motion-state")).toBe("paused");
    expect(caret.properties.get("--home-motion-state")).toBe("running");

    movePointer(hero, 100, 100);
    movePointer(hero);
    expect(frames.size).toBe(1);
    expect(hero.getBoundingClientRect).not.toHaveBeenCalled();
    const [id, callback] = [...frames][0]!;
    frames.delete(id);
    callback(0);
    expect(field.properties.get("--px")).toBe("18.0px");
    expect(field.properties.get("--py")).toBe("14.0px");

    movePointer(hero);
    page.visibilityState = "hidden";
    page.dispatchEvent(new Event("visibilitychange"));
    expect(frames.size).toBe(0);
    expect(field.properties.get("--px")).toBe("0px");
    expect(mark.properties.get("--home-motion-state")).toBe("paused");
    expect(caret.properties.get("--home-motion-state")).toBe("paused");
    page.visibilityState = "visible";
    page.dispatchEvent(new Event("visibilitychange"));
    reduced.matches = true;
    reduced.dispatchEvent(new Event("change"));
    movePointer(hero);
    expect(frames.size).toBe(0);
    expect(mark.properties.get("--home-motion-state")).toBe("paused");
    reduced.matches = false;
    fine.matches = false;
    reduced.dispatchEvent(new Event("change"));
    movePointer(hero);
    expect(frames.size).toBe(0);
    expect(mark.properties.get("--home-motion-state")).toBe("running");
  });

  it("pages every eight seconds, reverses at the end, and has no timer without overflow", () => {
    const { endorsements, observer } = fixture();
    expect(vi.getTimerCount()).toBe(0);
    observer.report(endorsements, true);
    vi.advanceTimersByTime(7_999);
    expect(endorsements.scrollTo).not.toHaveBeenCalled();
    vi.advanceTimersByTime(16_001);
    expect(endorsements.scrollTo.mock.calls.map(([options]) => options.left)).toEqual([
      400, 800, 400,
    ]);
    expect(
      endorsements.scrollTo.mock.calls.every(([options]) => options.behavior === "smooth"),
    ).toBe(true);

    endorsements.clientWidth = endorsements.scrollWidth;
    viewport.dispatchEvent(new Event("resize"));
    expect(vi.getTimerCount()).toBe(0);
    expect(endorsements.scrollTo).toHaveBeenLastCalledWith({ left: 400, behavior: "instant" });
    endorsements.clientWidth = 400;
    viewport.dispatchEvent(new Event("resize"));
    expect(vi.getTimerCount()).toBe(1);
  });

  it("pauses paging for hover, focus, hidden content, and reduced motion", () => {
    const { endorsements, observer } = fixture();
    observer.report(endorsements, true);
    const changeVisibility = (visible: boolean) => {
      page.visibilityState = visible ? "visible" : "hidden";
      page.dispatchEvent(new Event("visibilitychange"));
    };
    const changeMotion = (matches: boolean) => {
      reduced.matches = matches;
      reduced.dispatchEvent(new Event("change"));
    };
    const pauses = [
      [
        () => endorsements.dispatchEvent(new Event("pointerenter")),
        () => endorsements.dispatchEvent(new Event("pointerleave")),
      ],
      [
        () => endorsements.dispatchEvent(new Event("focusin")),
        () =>
          endorsements.dispatchEvent(Object.assign(new Event("focusout"), { relatedTarget: null })),
      ],
      [() => changeVisibility(false), () => changeVisibility(true)],
      [() => observer.report(endorsements, false), () => observer.report(endorsements, true)],
      [() => changeMotion(true), () => changeMotion(false)],
    ] as const;
    for (const [pause, resume] of pauses) {
      pause();
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(16_000);
      resume();
      expect(vi.getTimerCount()).toBe(1);
    }
    expect(endorsements.scrollTo).not.toHaveBeenCalled();
    vi.advanceTimersByTime(8_000);
    expect(endorsements.scrollTo).toHaveBeenCalledWith({ left: 400, behavior: "smooth" });
    endorsements.dispatchEvent(new Event("pointerenter"));
    expect(endorsements.scrollTo).toHaveBeenLastCalledWith({ left: 400, behavior: "instant" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["wheel", "pointerdown", "keydown"])("hands control to the user after %s", (event) => {
    const { endorsements, observer } = fixture();
    observer.report(endorsements, true);
    endorsements.dispatchEvent(new Event(event));
    observer.report(endorsements, false);
    observer.report(endorsements, true);
    endorsements.dispatchEvent(new Event("pointerleave"));
    viewport.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(60_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(endorsements.scrollTo).not.toHaveBeenCalled();
  });

  it("cancels pending work and ignores events after cleanup", () => {
    const { hero, mark, endorsements, observer } = fixture();
    observer.report(mark, true);
    observer.report(endorsements, true);
    movePointer(hero);
    dispose?.();
    observer.report(mark, true);
    movePointer(hero);
    reduced.dispatchEvent(new Event("change"));
    expect(observer.disconnect).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(mark.properties.get("--home-motion-state")).toBe("paused");
  });
});
