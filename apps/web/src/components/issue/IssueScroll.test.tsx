// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("~/lib/visibleAnimation", () => ({ observeVisibleAnimation: () => {} }));

import { IssueLoadMore, IssueScrollSentinel } from "./IssueLoadMore";

let container: HTMLDivElement;
let root: Root;
let observers: Array<{ intersect: () => void; disconnect: ReturnType<typeof vi.fn> }>;
const loadMore = vi.fn();
const page = {
  items: ["first"],
  hasMore: true,
  isPending: false,
  error: null as string | null,
  truncated: false,
  loadMore,
};
const render = (value = page, source = "first-account") =>
  act(async () =>
    root.render(<IssueLoadMore key={source} page={value} label="Load more history" />),
  );
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  observers = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      disconnect = vi.fn();
      constructor(callback: IntersectionObserverCallback) {
        observers.push({
          intersect: () =>
            callback(
              [{ isIntersecting: true } as IntersectionObserverEntry],
              this as unknown as IntersectionObserver,
            ),
          disconnect: this.disconnect,
        });
      }
      observe() {}
    },
  );
  loadMore.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("loads once per observed window without a visible load-more button", async () => {
  await render();
  expect(container.querySelector("button")).toBeNull();
  const observer = observers.at(-1)!;
  await act(async () => {
    observer.intersect();
    observer.intersect();
    observer.intersect();
  });
  expect(loadMore).toHaveBeenCalledTimes(1);
});

it("pauses while pending and reads the next window after completion", async () => {
  await render();
  const first = observers.at(-1)!;
  await act(async () => first.intersect());
  await render({ ...page, isPending: true });
  expect(first.disconnect).toHaveBeenCalledTimes(1);
  await act(async () => first.intersect());
  expect(loadMore).toHaveBeenCalledTimes(1);
  await render({ ...page, items: ["first", "second"] });
  await act(async () => observers.at(-1)!.intersect());
  expect(loadMore).toHaveBeenCalledTimes(2);
});

it("stops on errors and retries only on an explicit click, even after an empty page", async () => {
  await render();
  const first = observers.at(-1)!;
  await render({ ...page, items: [], error: "Tracker failed" });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Tracker failed");
  await act(async () => {
    first.intersect();
    first.intersect();
  });
  expect(loadMore).not.toHaveBeenCalled();
  await act(async () => {
    container.querySelector<HTMLButtonElement>("button")!.click();
    container.querySelector<HTMLButtonElement>("button")!.click();
  });
  expect(loadMore).toHaveBeenCalledTimes(1);
  await render({ ...page, isPending: true });
  await render();
  await act(async () => observers.at(-1)!.intersect());
  expect(loadMore).toHaveBeenCalledTimes(2);
});

it("disconnects on source changes and ignores the old source callback", async () => {
  const otherLoadMore = vi.fn();
  await render();
  const first = observers.at(-1)!;
  await render({ ...page, loadMore: otherLoadMore }, "second-account");
  expect(first.disconnect).toHaveBeenCalledTimes(1);
  await act(async () => {
    first.intersect();
    observers.at(-1)!.intersect();
  });
  expect(loadMore).not.toHaveBeenCalled();
  expect(otherLoadMore).toHaveBeenCalledTimes(1);
  await act(async () => root.render(null));
  const last = observers.at(-1)!;
  expect(last.disconnect).toHaveBeenCalledTimes(1);
  await act(async () => last.intersect());
  expect(otherLoadMore).toHaveBeenCalledTimes(1);
});

it("shows truncation without inventing a continuation", async () => {
  await render({ ...page, hasMore: false, truncated: true });
  expect(container.textContent).toContain("The tracker returned part of this list.");
  expect(observers).toHaveLength(0);
  expect(container.querySelector("button")).toBeNull();
});

it("exports the same sentinel for list and panel owners", async () => {
  await act(async () =>
    root.render(<IssueScrollSentinel hasMore isPending={false} error={null} loadMore={loadMore} />),
  );
  await act(async () => observers.at(-1)!.intersect());
  expect(loadMore).toHaveBeenCalledTimes(1);
});

it("shows a native truncation notice even when its bounded window has no rows", async () => {
  await render({ ...page, items: [], hasMore: false, truncated: true });
  expect(container.textContent).toContain("The tracker returned part of this list.");
  expect(container.querySelector("button")).toBeNull();
});
