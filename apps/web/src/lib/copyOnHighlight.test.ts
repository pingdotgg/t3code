// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { observeCopyOnHighlight } from "./copyOnHighlight";

describe("copy on highlight", () => {
  let dispose: (() => void) | undefined;
  let viewport: HTMLElement;
  const copy = vi.fn(async (_text: string) => true);
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(0), 0),
    );
    vi.stubGlobal("cancelAnimationFrame", window.clearTimeout.bind(window));
    document.body.innerHTML =
      '<div id="timeline"><p>Hello world</p><p>Second answer</p><div contenteditable="true">Draft text</div></div><p id="outside">Outside text</p>';
    viewport = document.getElementById("timeline")!;
    copy.mockClear();
    dispose = observeCopyOnHighlight(viewport, copy);
  });
  afterEach(() => {
    dispose?.();
    window.getSelection()?.removeAllRanges();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });
  const select = (node: Node, end = node.textContent!.length) => {
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, end);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  };
  const down = () =>
    viewport.dispatchEvent(
      Object.assign(new Event("pointerdown", { bubbles: true }), {
        isPrimary: true,
        button: 0,
      }),
    );
  const up = (detail = 1) => {
    window.dispatchEvent(Object.assign(new Event("pointerup"), { isPrimary: true, button: 0 }));
    window.dispatchEvent(new MouseEvent("mouseup", { button: 0, detail }));
  };
  const flush = () => vi.advanceTimersByTime(1);

  it("copies only the completed drag and leaves the highlight intact", () => {
    down();
    const text = viewport.querySelector("p")!.firstChild!;
    select(text, 5);
    flush();
    expect(copy).not.toHaveBeenCalled();
    select(text);
    up();
    flush();
    expect(copy).toHaveBeenCalledExactlyOnceWith("Hello world");
    expect(window.getSelection()!.toString()).toBe("Hello world");
  });
  it("waits for multi-click selection to finish", () => {
    down();
    select(viewport.querySelector("p")!.firstChild!, 5);
    up(2);
    vi.advanceTimersByTime(200);
    expect(copy).not.toHaveBeenCalled();
    select(viewport.querySelector("p")!.firstChild!);
    vi.advanceTimersByTime(301);
    expect(copy).toHaveBeenCalledExactlyOnceWith("Hello world");
  });
  it("supports keyboard selection and ignores duplicate selection notifications", () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true }));
    select(viewport.querySelector("p")!.firstChild!, 5);
    flush();
    document.dispatchEvent(new Event("selectionchange"));
    flush();
    expect(copy).toHaveBeenCalledExactlyOnceWith("Hello");
  });
  it.each(["#outside", "[contenteditable]"])("does not copy selection in %s", (selector) => {
    down();
    select(document.querySelector(selector)!.firstChild!);
    up();
    flush();
    expect(copy).not.toHaveBeenCalled();
  });
  it("restores the selection after the plain HTTP fallback and avoids a copy loop", () => {
    copy.mockImplementationOnce(async () => {
      window.getSelection()!.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
      return true;
    });
    down();
    select(viewport.querySelector("p")!.firstChild!);
    up();
    flush();
    document.dispatchEvent(new Event("selectionchange"));
    flush();
    expect(copy).toHaveBeenCalledTimes(1);
    expect(window.getSelection()!.toString()).toBe("Hello world");
  });
  it("stops copying when disabled", () => {
    dispose!();
    down();
    select(viewport.querySelector("p")!.firstChild!);
    up();
    flush();
    expect(copy).not.toHaveBeenCalled();
  });
});
