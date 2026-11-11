import { describe, expect, it, vi } from "vite-plus/test";

import { observeIntersection } from "./observeIntersection";

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly observed = new Set<Element>();
  disconnected = false;
  constructor(
    readonly callback: (entries: IntersectionObserverEntry[]) => void,
    readonly options: IntersectionObserverInit,
  ) {
    FakeIntersectionObserver.instances.push(this);
  }
  observe(element: Element) {
    this.observed.add(element);
  }
  unobserve(element: Element) {
    this.observed.delete(element);
  }
  disconnect() {
    this.observed.clear();
    this.disconnected = true;
  }
  emit(target: Element, isIntersecting: boolean) {
    this.callback([{ target, isIntersecting } as IntersectionObserverEntry]);
  }
}

function setup() {
  FakeIntersectionObserver.instances = [];
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  return {
    [Symbol.dispose]: () => vi.unstubAllGlobals(),
  };
}

const element = (name: string) => ({ name }) as unknown as Element;

describe("observeIntersection", () => {
  it("shares one observer across elements with the same root and options", () => {
    using _globals = setup();
    const first = element("first");
    const second = element("second");
    const onFirst = vi.fn();
    const onSecond = vi.fn();

    const stopFirst = observeIntersection(first, onFirst, { rootMargin: "160px 0px" });
    const stopSecond = observeIntersection(second, onSecond, { rootMargin: "160px 0px" });
    observeIntersection(first, () => {}, { rootMargin: "600px" })();

    expect(FakeIntersectionObserver.instances).toHaveLength(2);
    const [shared] = FakeIntersectionObserver.instances;
    shared!.emit(second, true);
    expect(onFirst).not.toHaveBeenCalled();
    expect(onSecond).toHaveBeenCalledWith(expect.objectContaining({ isIntersecting: true }));

    stopFirst();
    expect(shared!.disconnected).toBe(false);
    stopSecond();
    expect(shared!.disconnected).toBe(true);
  });

  it("gives a late subscriber the current state without repeating it to earlier ones", () => {
    using _globals = setup();
    const target = element("row");
    const early = vi.fn();
    const late = vi.fn();
    observeIntersection(target, early);
    const [observer] = FakeIntersectionObserver.instances;
    observer!.emit(target, true);

    observeIntersection(target, late);
    // The browser answers a re-observe with the unchanged state.
    observer!.emit(target, true);

    expect(early).toHaveBeenCalledTimes(1);
    expect(late).toHaveBeenCalledTimes(1);

    observer!.emit(target, false);
    expect(early).toHaveBeenCalledTimes(2);
    expect(late).toHaveBeenCalledTimes(2);
  });
});
