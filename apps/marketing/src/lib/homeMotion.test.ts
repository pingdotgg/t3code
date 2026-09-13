import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { startHomeMotion } from "./homeMotion";

class ElementStub extends EventTarget {
  properties = new Map<string, string>();
  style = { setProperty: (name: string, value: string) => this.properties.set(name, value) };
  children: ElementStub[] = [];
  querySelectorAll = () => this.children;
  getBoundingClientRect = vi.fn(() => ({ left: 0, top: 0, width: 400, height: 600 }));
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

let page = Object.assign(new EventTarget(), { visibilityState: "visible" });
let reduced = Object.assign(new EventTarget(), { matches: false });
let fine = Object.assign(new EventTarget(), { matches: true });
let frames = new Map<number, FrameRequestCallback>();
let dispose: (() => void) | undefined;

beforeEach(() => {
  observers = [];
  frames = new Map();
  page = Object.assign(new EventTarget(), { visibilityState: "visible" });
  reduced = Object.assign(new EventTarget(), { matches: false });
  fine = Object.assign(new EventTarget(), { matches: true });
  vi.stubGlobal("document", page);
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), {
      matchMedia: (query: string) => (query.includes("reduced-motion") ? reduced : fine),
    }),
  );
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
  vi.unstubAllGlobals();
});

function fixture() {
  const hero = new ElementStub();
  const field = new ElementStub();
  const mark = new ElementStub();
  const otherMark = new ElementStub();
  field.children = [mark, otherMark];
  const track = new ElementStub();
  const caret = new ElementStub();
  dispose = startHomeMotion({ hero, field, tracks: [track], caret } as unknown as Parameters<
    typeof startHomeMotion
  >[0]);
  return { hero, field, mark, otherMark, track, caret, observer: observers[0]! };
}

function movePointer(hero: ElementStub, x = 400, y = 600) {
  hero.dispatchEvent(Object.assign(new Event("pointermove"), { clientX: x, clientY: y }));
}

describe("homepage motion", () => {
  it("gates each mark, marquee track, and caret and batches pointer input into one frame", () => {
    const { hero, field, mark, otherMark, track, caret, observer } = fixture();
    expect(mark.properties.get("--home-motion-state")).toBe("paused");
    expect(track.properties.get("--home-motion-state")).toBe("paused");
    observer.report(mark, true);
    observer.report(track, true);
    observer.report(caret, true);
    expect(mark.properties.get("--home-motion-state")).toBe("running");
    expect(otherMark.properties.get("--home-motion-state")).toBe("paused");
    expect(track.properties.get("--home-motion-state")).toBe("running");
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
    expect(track.properties.get("--home-motion-state")).toBe("paused");
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

  it("cancels pending work and ignores events after cleanup", () => {
    const { hero, mark, track, observer } = fixture();
    observer.report(mark, true);
    observer.report(track, true);
    movePointer(hero);
    dispose?.();
    observer.report(mark, true);
    movePointer(hero);
    reduced.dispatchEvent(new Event("change"));
    expect(observer.disconnect).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
    expect(mark.properties.get("--home-motion-state")).toBe("paused");
    expect(track.properties.get("--home-motion-state")).toBe("paused");
  });
});
