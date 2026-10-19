import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useSidebarThreadListAutoAnimate } from "./useSidebarThreadListAutoAnimate";

let container: HTMLDivElement;
let root: Root;

function ThreadList({ rowCount }: { rowCount: number }) {
  return (
    <ul ref={useSidebarThreadListAutoAnimate(rowCount)}>
      {Array.from({ length: rowCount }, (_, index) => (
        <li key={index}>{index === 0 ? "Active thread" : `Thread ${index}`}</li>
      ))}
    </ul>
  );
}

async function render(rowCount: number) {
  await act(() =>
    root.render(
      <StrictMode>
        <ThreadList rowCount={rowCount} />
      </StrictMode>,
    ),
  );
}

async function finishAnimations() {
  await Promise.all(
    container.getAnimations({ subtree: true }).map(
      (animation) =>
        new Promise<void>((resolve) => {
          animation.addEventListener("finish", () => resolve(), { once: true });
          animation.finish();
        }),
    ),
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("legacy sidebar thread-list animation", () => {
  it("animates small lists, skips bulk removals, and resumes with the retained active row", async () => {
    const animate = vi.spyOn(Element.prototype, "animate");
    await render(101);
    await render(20);
    expect(animate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);

    await render(19);
    expect(animate).toHaveBeenCalled();
    expect(
      animate.mock.calls.every(
        ([, options]) => typeof options === "object" && options.duration === 180,
      ),
    ).toBe(true);
    await finishAnimations();
    await vi.advanceTimersByTimeAsync(250);
    animate.mockClear();

    await render(21);
    expect(animate).not.toHaveBeenCalled();
    const list = container.querySelector("ul")!;
    const activeRow = list.firstElementChild;
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => mutations.push(...records));
    observer.observe(list, { childList: true });
    try {
      await render(1);
      expect(animate).not.toHaveBeenCalled();
      expect(list.children).toHaveLength(1);
      expect(list.firstElementChild).toBe(activeRow);
      // disable() alone still reinserts removed rows even with zero animations.
      expect(mutations.flatMap((record) => [...record.addedNodes])).toEqual([]);
    } finally {
      observer.disconnect();
    }

    await vi.advanceTimersByTimeAsync(250);
    await render(2);
    await finishAnimations();
    await vi.advanceTimersByTimeAsync(250);
    animate.mockClear();
    await render(1);
    expect(animate).toHaveBeenCalled();
    expect(
      animate.mock.calls.every(
        ([, options]) => typeof options === "object" && options.duration === 180,
      ),
    ).toBe(true);
    await finishAnimations();
    expect(list.children).toHaveLength(1);
    expect(list.firstElementChild).toBe(activeRow);
  });
});
