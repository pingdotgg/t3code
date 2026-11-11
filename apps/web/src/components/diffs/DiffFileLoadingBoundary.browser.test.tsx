import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { DiffFileLoadingBoundary } from "./DiffFileLoadingBoundary";

function stubIntersectionObserver() {
  let observeCount = 0;
  // Like the real observer, every observe() reports the target's current state; this boundary
  // is always in range.
  class InRangeIntersectionObserver {
    constructor(readonly callback: IntersectionObserverCallback) {}
    observe(target: Element) {
      observeCount += 1;
      this.callback(
        [{ target, isIntersecting: true } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver,
      );
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("IntersectionObserver", InRangeIntersectionObserver);
  return {
    get observeCount() {
      return observeCount;
    },
    [Symbol.dispose]: () => vi.unstubAllGlobals(),
  };
}

describe("DiffFileLoadingBoundary", () => {
  it("observes once and loads once while its parent re-renders with a new load", async () => {
    using observer = stubIntersectionObserver();
    const load = vi.fn();
    // DiffPanel hands over a new loadNextFiles whenever any file patch changes.
    await using screen = await render(<DiffFileLoadingBoundary load={() => load()} count={8} />, {
      router: false, // the boundary does not touch routing
    });
    await screen.rerender(<DiffFileLoadingBoundary load={() => load()} count={8} />);
    await screen.rerender(<DiffFileLoadingBoundary load={() => load()} count={8} />);
    await screen.rerender(<DiffFileLoadingBoundary load={() => load()} count={8} />);

    await expect.element(screen.getByRole("status", { name: "Loading diff…" })).toBeInTheDocument();
    expect(observer.observeCount).toBe(1);
    expect(load).toHaveBeenCalledTimes(1);

    // A settled batch leaves the boundary in range, so it asks for the next one.
    await screen.rerender(<DiffFileLoadingBoundary load={() => load()} count={4} />);
    expect(observer.observeCount).toBe(1);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
