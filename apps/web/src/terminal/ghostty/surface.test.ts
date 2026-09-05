import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ThreadId, type TerminalAttachStreamEvent } from "@t3tools/contracts";

import { writeTerminalClipboard } from "./clipboard";
import { GhosttyTerminalCore, type GhosttyCell, type GhosttyRow } from "./core";
import {
  DEFAULT_TERMINAL_FONT_FAMILY,
  DEFAULT_TERMINAL_FONT_SIZE,
  advanceTerminalSelectionClickSequence,
  applyTerminalCopyEvent,
  clearPrimedTerminalCopyInput,
  ghosttyMouseButton,
  isTerminalAltGraphText,
  isTerminalCompositionCommitInput,
  isTerminalCompositionKey,
  isTerminalCopyShortcut,
  isTerminalLinkPointerGesture,
  isTerminalPasteShortcut,
  loadTerminalFontFamily,
  primeTerminalCopyInput,
  resolveTerminalMouseData,
  resolveTerminalMouseTrackingState,
  shouldBlinkTerminalCursor,
  shouldReportTerminalMouse,
  terminalGridCellAt,
  terminalScrollbarGeometry,
  terminalScrollbarOffsetAtPointer,
  terminalLinkAtPositionWithRange,
  terminalContentOriginY,
  terminalFontFamily,
  terminalFontSize,
  terminalWheelArrowData,
  terminalWheelDeltaRows,
  GhosttyTerminalSurface,
  type GhosttyTerminalSurfaceOptions,
} from "./surface";

vi.mock("./vendor/ghostty-vt.wasm?url", async () => ({
  default: (await import("./vendor/ghostty-vt.wasm?inline")).default,
}));
vi.mock("./vendor/ghostty-write-pty.wasm?url&no-inline", async () => ({
  default: (await import("./vendor/ghostty-write-pty.wasm?inline")).default,
}));

const clipboardTarget = { threadId: ThreadId.make("thread"), terminalId: "terminal" };
const clipboardOutput = (data: string): TerminalAttachStreamEvent => ({
  type: "output",
  ...clipboardTarget,
  data,
});
const clipboardSnapshot = (history: string): TerminalAttachStreamEvent => ({
  type: "snapshot",
  snapshot: {
    ...clipboardTarget,
    cwd: "/tmp",
    worktreePath: null,
    status: "running",
    pid: 1,
    history,
    exitCode: null,
    exitSignal: null,
    label: "Terminal 1",
    updatedAt: "2026-09-05T00:00:00Z",
  },
});

describe("GhosttyTerminalSurface visibility", () => {
  const surfaces = new Set<GhosttyTerminalSurface>();

  // Keep the real surface, renderer, and WASM core. Only browser layout and
  // scheduling are replaced so tests can count work while the terminal is hidden.
  function createHarness() {
    vi.useFakeTimers();
    const frames = new Map<number, FrameRequestCallback>();
    const resizeCallbacks = new Set<() => void>();
    const paint = vi.fn((_operation: string, _args: ReadonlyArray<unknown>) => {});
    let frameId = 0;
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    });

    class TerminalTestElement extends EventTarget {
      style: Record<string, string> = {};
      parentElement: TerminalTestElement | null = null;
      clientWidth = 168;
      clientHeight = 104;
      width = 300;
      height = 150;
      value = "";
      private readonly captures = new Set<number>();

      setAttribute() {}
      select() {}
      append(...children: TerminalTestElement[]) {
        for (const child of children) child.parentElement = this;
      }
      replaceChildren(...children: TerminalTestElement[]) {
        this.append(...children);
      }
      remove() {
        this.parentElement = null;
      }
      getContext() {
        return context;
      }
      focus() {
        this.dispatchEvent(new Event("focus"));
      }
      setPointerCapture(pointerId: number) {
        this.captures.add(pointerId);
      }
      hasPointerCapture(pointerId: number) {
        return this.captures.has(pointerId);
      }
      releasePointerCapture(pointerId: number) {
        this.captures.delete(pointerId);
      }
      getBoundingClientRect() {
        return { left: 0, top: 0, right: 168, bottom: 104, width: 168, height: 104 };
      }
    }

    const canvas = new TerminalTestElement();
    const mount = new TerminalTestElement();
    const context = {
      canvas,
      beginPath() {},
      clip() {},
      rect() {},
      resetTransform() {},
      restore() {},
      save() {},
      setTransform() {},
      fillRect: (...args: number[]) => paint("fillRect", args),
      strokeRect: (...args: number[]) => paint("strokeRect", args),
      fillText: (...args: [string, number, number, number?]) => paint("fillText", args),
      measureText: (text: string) => ({
        width: text.length * 8,
        actualBoundingBoxAscent: 9,
        actualBoundingBoxDescent: 3,
      }),
    };
    vi.stubGlobal("document", {
      hasFocus: () => true,
      createElement: (tag: string) => (tag === "canvas" ? canvas : new TerminalTestElement()),
      fonts: Object.assign(new EventTarget(), { load: async () => [], add() {} }),
    });
    vi.stubGlobal(
      "window",
      Object.assign(new EventTarget(), {
        devicePixelRatio: 1,
        requestAnimationFrame: requestFrame,
        cancelAnimationFrame: (id: number) => frames.delete(id),
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        matchMedia: () => Object.assign(new EventTarget(), { matches: false }),
      }),
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private readonly callback: () => void) {
          resizeCallbacks.add(callback);
        }
        observe() {}
        disconnect() {
          resizeCallbacks.delete(this.callback);
        }
      },
    );
    const snapshot = vi.spyOn(GhosttyTerminalCore.prototype, "snapshot");
    const onData = vi.fn<(data: string) => void>();

    return {
      mount,
      frames,
      paint,
      requestFrame,
      snapshot,
      onData,
      get renderedSnapshot() {
        const result = snapshot.mock.results.at(-1);
        if (result?.type !== "return") throw new Error("No terminal snapshot was rendered");
        return result.value;
      },
      flushFrame() {
        const queued = [...frames.values()];
        frames.clear();
        for (const callback of queued) callback(0);
      },
      resize() {
        for (const callback of resizeCallbacks) callback();
      },
      pointer(
        type: string,
        clientX: number,
        buttons: number,
        shiftKey = false,
        clientY = 5,
        options: Partial<PointerEvent> = {},
      ) {
        canvas.dispatchEvent(
          Object.assign(new Event(type, { cancelable: true }), {
            clientX,
            clientY,
            pointerId: 1,
            button: 0,
            buttons,
            shiftKey,
            ...options,
          }),
        );
      },
      loseCapture(clientX = 5, clientY = 5) {
        canvas.releasePointerCapture(1);
        canvas.dispatchEvent(
          Object.assign(new Event("lostpointercapture"), {
            pointerId: 1,
            clientX,
            clientY,
            buttons: 0,
          }),
        );
      },
      wheel(deltaY = 1, deltaMode = 1) {
        canvas.dispatchEvent(
          Object.assign(new Event("wheel", { cancelable: true }), {
            deltaY,
            deltaMode,
            clientX: 5,
            clientY: 5,
            shiftKey: false,
          }),
        );
      },
      async create(options: Partial<GhosttyTerminalSurfaceOptions> = {}) {
        const surface = await GhosttyTerminalSurface.create(mount as unknown as HTMLElement, {
          theme: {
            foreground: { r: 255, g: 255, b: 255 },
            background: { r: 0, g: 0, b: 0 },
            cursor: { r: 255, g: 255, b: 255 },
          },
          onData,
          onResize() {},
          onSelectionChange() {},
          beforeKey: () => false,
          onLinkActivate() {},
          ...options,
          get visible() {
            return options.visible ?? true;
          },
        });
        surfaces.add(surface);
        return surface;
      },
    };
  }

  afterEach(() => {
    for (const surface of surfaces) surface.dispose();
    surfaces.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function key(
    surface: GhosttyTerminalSurface,
    value: string,
    code: string,
    modifiers: Partial<Pick<KeyboardEvent, "ctrlKey" | "shiftKey" | "altKey" | "metaKey">> = {},
    type = "keydown",
  ) {
    surface.input.dispatchEvent(
      Object.assign(new Event(type, { cancelable: true }), {
        key: value,
        code,
        repeat: false,
        isComposing: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        getModifierState: () => false,
        ...modifiers,
      }),
    );
  }

  it.each(["Linux x86_64", "Win32"])(
    "lets Ctrl+C interrupt after typing resumes on %s",
    async (platform) => {
      const harness = createHarness();
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", { platform, clipboard: { writeText } });
      const surface = await harness.create({ beforeKey: () => true });
      surface.write("hello world\r\nprompt: ");
      harness.flushFrame();
      harness.pointer("pointerdown", 5, 1);
      harness.pointer("pointerup", 37, 0);
      expect(surface.getSelection()).toBe("hello");
      key(surface, "x", "KeyX");
      surface.write("x");
      key(surface, "c", "KeyC", { ctrlKey: true });
      expect(surface.getSelection()).toBe("");
      expect(harness.onData.mock.calls).toEqual([["x"], ["\x03"]]);
      expect(writeText).not.toHaveBeenCalled();
    },
  );

  it.each([
    "input",
    "composition",
    "native paste",
    "menu paste",
    "shortcut paste",
    "forwarded shortcut",
  ])("retires a completed selection on %s", async (path) => {
    const harness = createHarness();
    vi.stubGlobal("navigator", {
      platform: "MacIntel",
      clipboard: { readText: async () => "text" },
    });
    const surface = await harness.create({ beforeKey: () => true });
    surface.write("\x1b[?2004hhello world");
    harness.flushFrame();
    harness.pointer("pointerdown", 5, 1);
    harness.pointer("pointerup", 37, 0);
    const paste = path.includes("paste");
    switch (path) {
      case "input":
        surface.input.value = "text";
        surface.input.dispatchEvent(new Event("input"));
        break;
      case "composition":
        surface.input.dispatchEvent(new Event("compositionstart"));
        surface.input.value = "text";
        surface.input.dispatchEvent(Object.assign(new Event("compositionend"), { data: "text" }));
        surface.input.dispatchEvent(
          Object.assign(new Event("input"), { data: "text", inputType: "insertFromComposition" }),
        );
        break;
      case "native paste":
        surface.input.dispatchEvent(
          Object.assign(new Event("paste", { cancelable: true }), {
            clipboardData: { getData: () => "text" },
          }),
        );
        break;
      case "menu paste":
        await surface.pasteFromClipboard(async () => "text");
        break;
      case "shortcut paste":
        key(surface, "v", "KeyV", { metaKey: true });
        await Promise.resolve();
        break;
      case "forwarded shortcut":
        surface.sendUserInput("\x01");
        break;
    }
    expect(surface.getSelection()).toBe("");
    expect(harness.onData.mock.calls).toEqual([
      [paste ? "\x1b[200~text\x1b[201~" : path === "forwarded shortcut" ? "\x01" : "text"],
    ]);
  });

  it("preserves selection for protocol replies, modifier events and native copy", async () => {
    const harness = createHarness();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { platform: "MacIntel", clipboard: { writeText } });
    const surface = await harness.create({ beforeKey: () => true });
    surface.write("hello world\x1b[>11u");
    harness.flushFrame();
    harness.pointer("pointerdown", 5, 1);
    harness.pointer("pointerup", 37, 0);
    surface.write("\x1b[5n");
    expect(harness.onData).toHaveBeenCalledWith("\x1b[0n");
    harness.onData.mockClear();
    key(surface, "Shift", "ShiftLeft", { shiftKey: true });
    key(surface, "Shift", "ShiftLeft", {}, "keyup");
    expect(harness.onData).toHaveBeenCalledTimes(2);
    expect(surface.getSelection()).toBe("hello");
    key(surface, "c", "KeyC", { metaKey: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(surface.getSelection()).toBe("hello");
  });

  it("does not let an older copy completion clear a newer selection", async () => {
    const harness = createHarness();
    let finishCopy!: () => void;
    const copied = new Promise<void>((resolve) => {
      finishCopy = resolve;
    });
    vi.stubGlobal("navigator", {
      platform: "Linux x86_64",
      clipboard: { writeText: () => copied },
    });
    const surface = await harness.create({ beforeKey: () => true });
    surface.write("hello world");
    harness.flushFrame();
    harness.pointer("pointerdown", 5, 1);
    harness.pointer("pointerup", 37, 0);
    key(surface, "c", "KeyC", { ctrlKey: true });
    await Promise.resolve();
    harness.pointer("pointerdown", 53, 1);
    harness.pointer("pointerup", 85, 0);
    expect(surface.getSelection()).toBe("world");
    finishCopy();
    await copied;
    expect(surface.getSelection()).toBe("world");
  });

  it("clears an unmoved selection when its pointer is cancelled", async () => {
    const harness = createHarness();
    const surface = await harness.create();
    surface.write("hello world");
    harness.flushFrame();
    harness.pointer("pointerdown", 5, 1);
    harness.pointer("pointercancel", 5, 0, false, 5, { button: -1 });
    expect(surface.getSelection()).toBe("");
    expect(surface.getSelectionPosition()).toBeNull();
  });

  it("allows a native selection after an application drag loses capture", async () => {
    const harness = createHarness();
    const surface = await harness.create();
    surface.write("\x1b[?1002h\x1b[?1006hhello world");
    harness.flushFrame();
    harness.pointer("pointerdown", 5, 1);
    harness.loseCapture(37);
    expect(harness.onData.mock.calls).toEqual([["\x1b[<0;1;1M"], ["\x1b[<0;5;1m"]]);
    harness.pointer("pointerup", 37, 0);
    expect(harness.onData).toHaveBeenCalledTimes(2);
    harness.onData.mockClear();
    harness.pointer("pointerdown", 5, 1, true);
    harness.pointer("pointermove", 37, 1, true);
    harness.pointer("pointerup", 37, 0, true);
    expect(surface.getSelection()).toBe("hello");
    expect(harness.onData).not.toHaveBeenCalled();
  });

  it("recognizes input focus acquired before asynchronous surface setup finishes", async () => {
    const harness = createHarness();
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag) => {
      const element = createElement(tag);
      if (tag === "textarea")
        Object.defineProperty(document, "activeElement", { value: element, configurable: true });
      return element;
    });
    const copy = vi.fn();
    const surface = await harness.create({ onClipboardWrite: copy });
    surface.observeClipboard(clipboardOutput("\x1b]52;c;aGVsbG8=\x07"));
    expect(copy).toHaveBeenCalledWith("hello", expect.any(Function));
  });

  it.each([1002, 1003])("keeps one application pointer owner in mouse mode %s", async (mode) => {
    const harness = createHarness();
    const surface = await harness.create();
    surface.write(`\x1b[?${mode}h\x1b[?1006hhello world`);
    harness.flushFrame();
    harness.pointer("pointerdown", 5, 1);
    harness.onData.mockClear();
    harness.pointer("pointerdown", 37, 1, false, 5, { pointerId: 2 });
    harness.pointer("pointermove", 45, 1, false, 5, { pointerId: 2 });
    harness.pointer("pointerup", 45, 0, false, 5, { pointerId: 2 });
    expect(harness.onData).not.toHaveBeenCalled();
    harness.pointer("pointerup", 5, 0);
    expect(harness.onData.mock.calls).toEqual([["\x1b[<0;1;1m"]]);
  });

  it("only repaints the cursor row for an application mouse press without selection", async () => {
    const harness = createHarness();
    const surface = await harness.create();
    surface.write("\x1b[?1002h\x1b[?1006hhello world\r\ncursor row");
    harness.flushFrame();
    harness.paint.mockClear();
    harness.pointer("pointerdown", 5, 1);
    harness.flushFrame();
    expect(harness.onData).toHaveBeenCalled();
    expect(
      harness.paint.mock.calls
        .filter(([operation]) => operation === "fillText")
        .map(([, args]) => args[0]),
    ).toEqual(["cursor row"]);
  });

  it("ends selection on left release while another mouse button remains held", async () => {
    const harness = createHarness();
    const surface = await harness.create();
    surface.write("hello world");
    harness.flushFrame();
    harness.pointer("pointerdown", 5, 1);
    harness.pointer("pointermove", 37, 1);
    // Chorded button changes arrive as pointermove until the final release.
    harness.pointer("pointermove", 37, 3, false, 5, { button: 2 });
    harness.pointer("pointermove", 37, 2, false, 5, { button: 0 });
    harness.pointer("pointermove", 85, 2);
    harness.pointer("pointerup", 85, 0, false, 5, { button: 2 });
    expect(surface.getSelection()).toBe("hello");
  });

  it.each([false, true])(
    "retires stale selection coordinates after scrollback eviction (dragging: %s)",
    async (dragging) => {
      const harness = createHarness();
      const surface = await harness.create();
      surface.write("hello world\r\n".repeat(11_000));
      harness.flushFrame();
      harness.pointer("pointerdown", 5, 1);
      harness.pointer("pointermove", 37, 1);
      if (!dragging) harness.pointer("pointerup", 37, 0);
      expect(surface.getSelection()).toBe("hello");
      surface.write("later output\r\n".repeat(500));
      expect(surface.getSelectionPosition()).toBeNull();
      expect(surface.getSelection()).toBe("");
      harness.pointer("pointerup", 85, 0);
      expect(surface.getSelection()).toBe("");
      expect(surface.getSelectionEndClientRect()).toBeNull();
    },
  );

  it.each([
    ["Fn", "Fn"],
    ["FnLock", "FnLock"],
    ["Super", "MetaLeft"],
    ["Hyper", "MetaRight"],
  ])("preserves a selection for the %s modifier", async (value, code) => {
    const harness = createHarness();
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    const surface = await harness.create({ beforeKey: () => true });
    surface.write("hello world\x1b[>11u");
    harness.flushFrame();
    harness.pointer("pointerdown", 5, 1);
    harness.pointer("pointerup", 37, 0);
    key(surface, value, code);
    key(surface, value, code, {}, "keyup");
    expect(surface.getSelection()).toBe("hello");
  });

  it.each([
    "release",
    "cancel",
    "capture loss",
    "hide",
    "input blur",
    "window blur",
    "reset",
    "dispose",
  ])("stops selection autoscroll on %s", async (end) => {
    const harness = createHarness();
    const surface = await harness.create();
    surface.write("hello world\r\n".repeat(20));
    harness.flushFrame();
    harness.pointer("pointerdown", 5, 1);
    harness.pointer("pointermove", 37, 1, false, 120);
    const selected = surface.getSelection();
    switch (end) {
      case "release":
        harness.pointer("pointerup", 37, 0, false, 120);
        break;
      case "cancel":
        harness.pointer("pointercancel", 37, 0, false, 120);
        break;
      case "capture loss":
        harness.loseCapture();
        break;
      case "hide":
        surface.setVisible(false);
        surface.setVisible(true);
        break;
      case "input blur":
        surface.input.dispatchEvent(new Event("blur"));
        break;
      case "window blur":
        window.dispatchEvent(new Event("blur"));
        break;
      case "reset":
        surface.resetAndWrite("new session");
        break;
      case "dispose":
        surface.dispose();
        break;
    }
    harness.flushFrame();
    harness.paint.mockClear();
    vi.advanceTimersByTime(240);
    harness.flushFrame();
    expect(harness.paint).not.toHaveBeenCalled();
    if (end !== "dispose") {
      expect(surface.getSelection()).toBe(end === "reset" ? "" : selected);
    }
  });

  it("stops hidden snapshots and paint while preserving live VT replies and the next cursor", async () => {
    const harness = createHarness();
    const surface = await harness.create();
    surface.focus();
    surface.write("ready\x1b[1 q");
    harness.flushFrame();
    vi.advanceTimersByTime(500);
    harness.flushFrame();
    surface.write("queued");
    expect(harness.frames.size).toBe(1);
    surface.setVisible(false);
    expect(harness.frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    harness.snapshot.mockClear();
    harness.paint.mockClear();
    harness.requestFrame.mockClear();

    surface.write("\x1b[2J\x1b[H\x1b[3");
    surface.write("1mhidden");
    surface.write("界🙂\x1b[0m\x1b[5n\x1b[6n");
    surface.fit();
    vi.advanceTimersByTime(2_000);
    harness.flushFrame();

    expect(harness.onData.mock.calls).toEqual([["\x1b[0n"], ["\x1b[1;11R"]]);
    expect(harness.snapshot).not.toHaveBeenCalled();
    expect(harness.paint).not.toHaveBeenCalled();
    expect(harness.requestFrame).not.toHaveBeenCalled();

    surface.setVisible(true);
    expect(harness.snapshot).toHaveBeenCalledTimes(1);
    expect(harness.renderedSnapshot).toMatchObject({ cursorX: 10, cursorY: 0 });
    expect(harness.renderedSnapshot.rowData[0]?.text).toContain("hidden");
    expect(harness.paint.mock.calls).toContainEqual(["fillRect", [84, 4, 8, 16]]);
    expect(harness.frames.size).toBe(0);
  });

  it("keeps the selection on reveal and applies a hidden selection clear", async () => {
    const harness = createHarness();
    const surface = await harness.create();
    surface.write("hello world");
    harness.flushFrame();
    harness.pointer("pointerdown", 5, 1);
    harness.pointer("pointermove", 37, 1);
    harness.pointer("pointerup", 37, 0);
    harness.flushFrame();
    expect(surface.getSelection()).toBe("hello");
    const position = surface.getSelectionPosition();

    surface.setVisible(false);
    harness.snapshot.mockClear();
    surface.setVisible(true);
    expect(harness.snapshot).toHaveBeenCalledTimes(1);
    expect(surface.getSelectionPosition()).toEqual(position);
    expect(
      harness.renderedSnapshot.rowData[0]?.cells.slice(0, 5).every((cell) => cell.selected),
    ).toBe(true);

    surface.setVisible(false);
    harness.snapshot.mockClear();
    surface.clearSelection();
    surface.write("!");
    expect(harness.snapshot).not.toHaveBeenCalled();
    surface.setVisible(true);
    expect(harness.snapshot).toHaveBeenCalledTimes(1);
    expect(surface.getSelection()).toBe("");
    expect(surface.getSelectionPosition()).toBeNull();
    expect(harness.renderedSnapshot.rowData[0]?.cells.some((cell) => cell.selected)).toBe(false);
  });

  it("finishes a native fullscreen drag after Shift is released", async () => {
    const harness = createHarness();
    const surface = await harness.create();
    surface.write("\x1b[?1049h\x1b[?1003h\x1b[?1006hhello world");
    harness.flushFrame();
    harness.pointer("pointerdown", 5, 1, true);
    harness.pointer("pointermove", 21, 1, true);
    harness.pointer("pointermove", 37, 1);
    harness.pointer("pointerup", 37, 0);
    expect(surface.getSelection()).toBe("hello");
    expect(harness.onData).not.toHaveBeenCalled();

    // After release, normal hover reporting resumes.
    harness.pointer("pointermove", 45, 0);
    expect(harness.onData).toHaveBeenCalledTimes(1);
    // Switching back to the application's selection must not leave a native
    // selection that would intercept the next Cmd+C.
    harness.pointer("pointerdown", 45, 1);
    expect(surface.getSelection()).toBe("");
    harness.pointer("pointerup", 45, 0);
  });

  it("keeps a large live clipboard frame across display resynchronization without replaying it", async () => {
    const harness = createHarness();
    const copy = vi.fn();
    const surface = await harness.create({ onClipboardWrite: copy });
    surface.focus();
    const text = "x".repeat(600 * 1024);
    const frame = `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`;
    surface.observeClipboard(clipboardOutput(frame.slice(0, -1)));
    surface.resetAndWrite(frame.slice(-100));
    surface.observeClipboard(clipboardOutput(frame.slice(-1)));
    surface.write(frame);
    surface.resetAndWrite(frame);
    expect(copy.mock.calls).toEqual([[text, expect.any(Function)]]);
    expect(copy.mock.calls[0]![1]()).toBe(true);
  });

  it("copies live OSC 52 only from the focused, visible terminal in the active window", async () => {
    const harness = createHarness();
    const copy = vi.fn();
    const surface = await harness.create({ onClipboardWrite: copy });
    const data = "\x1b]52;c;aGVsbG8=\x07";
    surface.observeClipboard(clipboardOutput(data));
    expect(copy).not.toHaveBeenCalled();
    surface.focus();
    surface.observeClipboard(clipboardSnapshot(data));
    surface.observeClipboard(clipboardSnapshot("\x1b]52;c;"));
    surface.observeClipboard(clipboardOutput("aGVsbG8=\x07"));
    expect(copy).not.toHaveBeenCalled();
    surface.observeClipboard(clipboardOutput(data));
    expect(copy.mock.calls).toEqual([["hello", expect.any(Function)]]);
    copy.mockClear();
    surface.setVisible(false);
    surface.observeClipboard(clipboardOutput(data));
    surface.setVisible(true);
    surface.input.dispatchEvent(new Event("blur"));
    surface.observeClipboard(clipboardOutput(data));
    surface.focus();
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    surface.observeClipboard(clipboardOutput(data));
    surface.dispose();
    surface.observeClipboard(clipboardOutput(data));
    expect(copy).not.toHaveBeenCalled();
    expect(harness.onData).not.toHaveBeenCalled();
  });

  it.each(["hide", "input blur", "window blur"])(
    "invalidates pending clipboard writes on %s even without intervening output",
    async (change) => {
      const harness = createHarness();
      const copy = vi.fn();
      const surface = await harness.create({ onClipboardWrite: copy });
      const data = "\x1b]52;c;aGVsbG8=\x07";
      surface.focus();
      surface.observeClipboard(clipboardOutput(data.slice(0, -1)));
      switch (change) {
        case "hide":
          surface.setVisible(false);
          surface.setVisible(true);
          break;
        case "input blur":
          surface.input.dispatchEvent(new Event("blur"));
          surface.focus();
          break;
        case "window blur":
          window.dispatchEvent(new Event("blur"));
          window.dispatchEvent(new Event("focus"));
          break;
      }
      surface.observeClipboard(clipboardOutput(data.slice(-1)));
      expect(copy).not.toHaveBeenCalled();
      surface.observeClipboard(clipboardOutput(data));
      expect(copy.mock.calls).toEqual([["hello", expect.any(Function)]]);
    },
  );

  it.each(["hide", "input blur", "window blur", "inactive window", "reset", "dispose"])(
    "drops a completed OSC copy queued before %s",
    async (change) => {
      const harness = createHarness();
      let finishFirst!: () => void;
      const first = new Promise<void>((resolve) => {
        finishFirst = resolve;
      });
      const writeText = vi.fn(() => first);
      vi.stubGlobal("navigator", { clipboard: { writeText } });
      const copy = vi.fn(writeTerminalClipboard);
      const surface = await harness.create({ onClipboardWrite: copy });
      surface.focus();
      surface.observeClipboard(clipboardOutput("\x1b]52;c;Zmlyc3Q=\x07\x1b]52;c;b2xk\x07"));
      switch (change) {
        case "hide":
          surface.setVisible(false);
          surface.setVisible(true);
          break;
        case "input blur":
          surface.input.dispatchEvent(new Event("blur"));
          surface.focus();
          break;
        case "window blur":
          window.dispatchEvent(new Event("blur"));
          window.dispatchEvent(new Event("focus"));
          break;
        case "inactive window":
          vi.spyOn(document, "hasFocus").mockReturnValue(false);
          break;
        case "reset":
          surface.observeClipboard(clipboardSnapshot(""));
          break;
        case "dispose":
          surface.dispose();
          break;
      }
      finishFirst();
      await Promise.all(copy.mock.results.map((result) => result.value));
      expect(writeText.mock.calls).toEqual([["first"]]);
      if (change !== "dispose" && change !== "inactive window") {
        surface.observeClipboard(clipboardOutput("\x1b]52;c;bmV3\x07"));
        await Promise.all(copy.mock.results.map((result) => result.value));
        expect(writeText.mock.calls).toEqual([["first"], ["new"]]);
      }
    },
  );

  it.each([
    ["mouse reports", "\x1b[?1049h\x1b[?1000h\x1b[?1006h", "\x1b[<65;1;1M"],
    ["arrow keys", "\x1b[?1049h", "\x1b[B"],
  ])("retires completed selection before forwarding wheel %s", async (_mode, setup, input) => {
    const harness = createHarness();
    vi.stubGlobal("navigator", { platform: "Linux x86_64" });
    const surface = await harness.create({ beforeKey: () => true });
    surface.write(setup + "hello world");
    harness.flushFrame();
    harness.pointer("pointerdown", 5, 1, true);
    harness.pointer("pointerup", 37, 0, true);
    expect(surface.getSelection()).toBe("hello");
    const selectedDuringInput: string[] = [];
    harness.onData.mockImplementation(() => {
      selectedDuringInput.push(surface.getSelection());
    });
    harness.wheel(2);
    expect(harness.onData.mock.calls.flat().join("")).toBe(input!.repeat(2));
    expect(selectedDuringInput.every((text) => text === "")).toBe(true);
    key(surface, "c", "KeyC", { ctrlKey: true });
    expect(harness.onData).toHaveBeenLastCalledWith("\x03");
  });

  it.each(["active drag", "local scrollback", "fractional wheel"])(
    "preserves selection during %s",
    async (mode) => {
      const harness = createHarness();
      const surface = await harness.create();
      surface.write((mode === "local scrollback" ? "" : "\x1b[?1049h") + "hello world");
      harness.flushFrame();
      harness.pointer("pointerdown", 5, 1, true);
      harness.pointer("pointermove", 37, 1, true);
      if (mode !== "active drag") harness.pointer("pointerup", 37, 0, true);
      harness.wheel(mode === "fractional wheel" ? 0.1 : 1, mode === "fractional wheel" ? 0 : 1);
      expect(surface.getSelection()).toBe("hello");
      if (mode !== "active drag") expect(harness.onData).not.toHaveBeenCalled();
    },
  );

  it("uses the release position when a trackpad drag has no intermediate motion", async () => {
    const harness = createHarness();
    const surface = await harness.create();
    surface.write("\x1b[?1049h\x1b[?1003h\x1b[?1006hhello world");
    harness.flushFrame();
    harness.pointer("pointerdown", 5, 1, true);
    harness.pointer("pointerup", 37, 0);
    expect(surface.getSelection()).toBe("hello");
    expect(harness.onData).not.toHaveBeenCalled();
  });

  it.each([2, 3])(
    "keeps a %s-click selection when output scrolls before release",
    async (clicks) => {
      const harness = createHarness();
      const surface = await harness.create();
      surface.write("hello world\r\nsecond line");
      harness.flushFrame();
      for (let click = 1; click < clicks; click += 1) {
        harness.pointer("pointerdown", 13, 1);
        harness.pointer("pointerup", 13, 0);
      }
      harness.pointer("pointerdown", 13, 1);
      const selected = surface.getSelection();
      expect(selected).toBe(clicks === 2 ? "hello" : "hello world");
      surface.write("\x1b[6;1H\r\n");
      harness.flushFrame();
      harness.pointer("pointerup", 13, 0);
      expect(surface.getSelection()).toBe(selected);
    },
  );

  it("agrees with Ghostty about leaving a control string before an OSC request", async () => {
    const harness = createHarness();
    const copy = vi.fn();
    const surface = await harness.create({ onClipboardWrite: copy });
    surface.focus();
    const data = "\x1bPtmux;\x1b\x1b]52;c;aGVsbG8=\x07visible\x1b\\";
    surface.observeClipboard(clipboardOutput(data));
    surface.write(data);
    harness.flushFrame();
    expect(copy.mock.calls).toEqual([["hello", expect.any(Function)]]);
    expect(harness.renderedSnapshot.rowData[0]?.text).toContain("visible");
    expect(harness.renderedSnapshot.rowData[0]?.text).not.toContain("aGVsbG8");
  });

  it("continues a native drag through fullscreen status redraws and clears it on reset", async () => {
    const harness = createHarness();
    const surface = await harness.create();
    surface.write("\x1b[?1049h\x1b[?1003h\x1b[?1006hhello world");
    harness.flushFrame();
    harness.pointer("pointerdown", 5, 1, true);
    harness.pointer("pointermove", 21, 1, true);
    surface.write("\x1b[2;1Hworking\x1b[1;1H");
    harness.flushFrame();
    harness.pointer("pointermove", 37, 1, true);
    harness.pointer("pointerup", 37, 0, true);
    expect(surface.getSelection()).toBe("hello");
    expect(harness.onData).not.toHaveBeenCalled();

    surface.resetAndWrite("restored session");
    expect(surface.getSelection()).toBe("");
    expect(surface.getSelectionPosition()).toBeNull();
  });

  it("keeps an application drag in the application when Shift is pressed midway", async () => {
    const harness = createHarness();
    const surface = await harness.create();
    surface.write("\x1b[?1049h\x1b[?1003h\x1b[?1006hhello world");
    harness.flushFrame();
    harness.pointer("pointerdown", 5, 1);
    harness.pointer("pointermove", 37, 1, true);
    harness.pointer("pointerup", 37, 0, true);
    expect(surface.getSelection()).toBe("");
    expect(harness.onData).toHaveBeenCalledTimes(3);
  });

  it("stops zero-size mounts and repaints when the same size returns", async () => {
    const harness = createHarness();
    const surface = await harness.create();
    surface.focus();
    surface.write("visible");
    harness.flushFrame();
    harness.snapshot.mockClear();
    harness.paint.mockClear();
    harness.mount.clientWidth = 0;
    surface.write("!");
    harness.flushFrame();
    harness.requestFrame.mockClear();
    for (let index = 0; index < 8; index += 1) surface.write("x");
    vi.advanceTimersByTime(2_000);

    expect(harness.snapshot).not.toHaveBeenCalled();
    expect(harness.paint).not.toHaveBeenCalled();
    expect(harness.requestFrame).not.toHaveBeenCalled();
    harness.mount.clientWidth = 168;
    harness.resize();
    expect(harness.snapshot).toHaveBeenCalledTimes(1);
    expect(harness.renderedSnapshot.rowData[0]?.text).toContain("visible!xxxxxxxx");
    expect(harness.paint).toHaveBeenCalled();
  });

  it.each([false, true])(
    "uses visibility %s if it changes while WASM initializes",
    async (visible) => {
      const harness = createHarness();
      let markCreated!: () => void;
      const created = new Promise<void>((resolve) => {
        markCreated = resolve;
      });
      let finishLoading!: () => void;
      const release = new Promise<void>((resolve) => {
        finishLoading = resolve;
      });
      const create = GhosttyTerminalCore.create;
      vi.spyOn(GhosttyTerminalCore, "create").mockImplementation(async (...args) => {
        const core = await create(...args);
        markCreated();
        await release;
        return core;
      });
      let currentVisible = !visible;
      const pending = harness.create({
        get visible() {
          return currentVisible;
        },
      });
      await created;
      currentVisible = visible;
      harness.paint.mockClear();
      finishLoading();
      const surface = await pending;

      expect(harness.snapshot).toHaveBeenCalledTimes(visible ? 1 : 0);
      if (!visible) expect(harness.paint).not.toHaveBeenCalled();
      surface.write("ready\x1b[5n");
      expect(harness.onData).toHaveBeenCalledWith("\x1b[0n");
      if (!visible) {
        expect(harness.frames.size).toBe(0);
        surface.setVisible(true);
      } else {
        harness.flushFrame();
      }
      expect(harness.renderedSnapshot.rowData[0]?.text).toContain("ready");
    },
  );
});

const cell = (text: string): GhosttyCell => ({
  text,
  wide: 0,
  foreground: { r: 255, g: 255, b: 255 },
  background: { r: 0, g: 0, b: 0 },
  bold: false,
  italic: false,
  invisible: false,
  strikethrough: false,
  overline: false,
  underline: false,
  selected: false,
});

describe("isTerminalAltGraphText", () => {
  it("defers printable AltGr output to the textarea input event", () => {
    expect(
      isTerminalAltGraphText({
        key: "@",
        getModifierState: (modifier) => modifier === "AltGraph",
      }),
    ).toBe(true);
    expect(
      isTerminalAltGraphText({
        key: "ArrowRight",
        getModifierState: (modifier) => modifier === "AltGraph",
      }),
    ).toBe(false);
  });
});

describe("terminalGridCellAt", () => {
  const options = {
    bounds: { left: 100, top: 200 },
    cols: 3,
    rows: 2,
    metrics: { width: 10, height: 20 },
    padding: 4,
    originY: 24,
  };

  it("maps points inside the rendered grid without clamping its padding", () => {
    expect(terminalGridCellAt({ ...options, clientX: 104, clientY: 224 })).toEqual({
      x: 0,
      y: 0,
    });
    expect(terminalGridCellAt({ ...options, clientX: 133, clientY: 263 })).toEqual({
      x: 2,
      y: 1,
    });
    expect(terminalGridCellAt({ ...options, clientX: 103, clientY: 224 })).toBeNull();
    expect(terminalGridCellAt({ ...options, clientX: 104, clientY: 223 })).toBeNull();
    expect(terminalGridCellAt({ ...options, clientX: 134, clientY: 224 })).toBeNull();
    expect(terminalGridCellAt({ ...options, clientX: 104, clientY: 264 })).toBeNull();
  });
});

describe("shouldBlinkTerminalCursor", () => {
  const blinking = {
    focused: true,
    cursorBlinking: true,
    cursorVisible: true,
    reducedMotion: false,
  };

  it("blinks a focused visible cursor the terminal asked to blink", () => {
    expect(shouldBlinkTerminalCursor(blinking)).toBe(true);
  });

  it("holds the cursor steady when blinking would be unwanted", () => {
    // Unfocused surfaces draw a steady hollow cursor, DECSCUSR steady styles and
    // DEC mode 12 turn blinking off, a hidden cursor has nothing to toggle, and
    // reduced-motion readers get no permanently animating element.
    expect(shouldBlinkTerminalCursor({ ...blinking, focused: false })).toBe(false);
    expect(shouldBlinkTerminalCursor({ ...blinking, cursorBlinking: false })).toBe(false);
    expect(shouldBlinkTerminalCursor({ ...blinking, cursorVisible: false })).toBe(false);
    expect(shouldBlinkTerminalCursor({ ...blinking, reducedMotion: true })).toBe(false);
  });
});

describe("terminalLinkAtPositionWithRange", () => {
  it("maps terminal cells to UTF-16 offsets after a wide emoji", () => {
    const cells = [
      cell("🙂"),
      cell(""),
      ...Array.from("https://t3.codes", (character) => cell(character)),
    ];
    const row: GhosttyRow = {
      cells,
      text: cells
        .map((value) => value.text || " ")
        .join("")
        .trimEnd(),
      isWrapContinuation: false,
      wrapsToNext: false,
    };

    expect(terminalLinkAtPositionWithRange([row], 0, 2)?.text).toBe("https://t3.codes");
    expect(terminalLinkAtPositionWithRange([row], 0, cells.length - 1)?.text).toBe(
      "https://t3.codes",
    );
    expect(terminalLinkAtPositionWithRange([row], 0, 0)).toBeNull();
    expect(terminalLinkAtPositionWithRange([row], 0, 8)?.range).toEqual({
      start: { x: 2, y: 0 },
      end: { x: cells.length - 1, y: 0 },
    });
  });

  it("uses shared path matching and reconstructs soft-wrapped links", () => {
    const row = (text: string, isWrapContinuation: boolean, wrapsToNext = false): GhosttyRow => ({
      cells: Array.from(text.padEnd(16), (character) => cell(character)),
      text: text.trimEnd(),
      isWrapContinuation,
      wrapsToNext,
    });
    const rows = [
      row("https://example.", false),
      row("com/reference", true),
      row("~/project/file", false),
      row("C:\\repo\\file.ts", false),
    ];

    expect(terminalLinkAtPositionWithRange(rows, 0, 8)?.text).toBe("https://example.com/reference");
    expect(terminalLinkAtPositionWithRange(rows, 1, 4)?.text).toBe("https://example.com/reference");
    expect(terminalLinkAtPositionWithRange(rows, 2, 2)?.text).toBe("~/project/file");
    expect(terminalLinkAtPositionWithRange(rows, 3, 4)?.text).toBe("C:\\repo\\file.ts");
    expect(terminalLinkAtPositionWithRange(rows, 1, 4)).toEqual({
      text: "https://example.com/reference",
      range: {
        start: { x: 0, y: 0 },
        end: { x: 12, y: 1 },
      },
    });
  });

  it("refuses links truncated at the viewport edges instead of mis-resolving", () => {
    const row = (text: string, isWrapContinuation: boolean, wrapsToNext = false): GhosttyRow => ({
      cells: Array.from(text.padEnd(16), (character) => cell(character)),
      text: text.trimEnd(),
      isWrapContinuation,
      wrapsToNext,
    });
    // The head of the wrapped line scrolled above the viewport.
    const headCut = [row("ple.com/missing", true), row("head", true)];
    expect(terminalLinkAtPositionWithRange(headCut, 0, 4)).toBeNull();
    // The bottom row soft-wraps on below the viewport.
    const tailCut = [row("https://t3.codes", false, true)];
    expect(terminalLinkAtPositionWithRange(tailCut, 0, 8)).toBeNull();
    // A partial bottom row is provably complete and still resolves.
    const complete = [row("https://t3.codes", false), row("", false)];
    expect(terminalLinkAtPositionWithRange(complete, 0, 8)?.text).toBe("https://t3.codes");
    // A wide grapheme earlier in the row must not break truncation detection:
    // the soft-wrap flag decides, not string-length-versus-cell-count.
    const wideFull: GhosttyRow = {
      cells: [
        { ...cell("🙂"), wide: 1 },
        { ...cell(""), wide: 2 },
        ...Array.from("https://t3.code", (character) => cell(character)),
      ],
      text: "🙂 https://t3.code",
      isWrapContinuation: false,
      wrapsToNext: true,
    };
    expect(terminalLinkAtPositionWithRange([wideFull], 0, 8)).toBeNull();
    // Unwritten trailing cells prove the bottom row is complete.
    const unwrittenTail: GhosttyRow = {
      cells: [
        ...Array.from("https://t3.codes", (character) => cell(character)),
        cell(""),
        cell(""),
      ],
      text: "https://t3.codes",
      isWrapContinuation: false,
      wrapsToNext: false,
    };
    expect(terminalLinkAtPositionWithRange([unwrittenTail], 0, 8)?.text).toBe("https://t3.codes");
  });
});

describe("isTerminalCopyShortcut", () => {
  const event = (overrides: Partial<Parameters<typeof isTerminalCopyShortcut>[0]> = {}) => ({
    ctrlKey: false,
    key: "c",
    metaKey: false,
    shiftKey: false,
    ...overrides,
  });

  it("keeps Ctrl+C available for SIGINT on macOS", () => {
    expect(isTerminalCopyShortcut(event({ ctrlKey: true }), "MacIntel")).toBe(false);
    expect(isTerminalCopyShortcut(event({ metaKey: true }), "MacIntel")).toBe(true);
  });

  it("copies with Ctrl+C and Ctrl+Shift+C elsewhere", () => {
    expect(isTerminalCopyShortcut(event({ ctrlKey: true }), "Linux x86_64")).toBe(true);
    expect(isTerminalCopyShortcut(event({ ctrlKey: true, shiftKey: true }), "Linux x86_64")).toBe(
      true,
    );
    expect(isTerminalCopyShortcut(event({}), "Linux x86_64")).toBe(false);
  });

  it("uses the produced character instead of the physical key position", () => {
    expect(isTerminalCopyShortcut(event({ key: "C", metaKey: true }), "MacIntel")).toBe(true);
    expect(isTerminalCopyShortcut(event({ key: "j", metaKey: true }), "MacIntel")).toBe(false);
  });
});

describe("applyTerminalCopyEvent", () => {
  it("writes the selection and claims the fallback when clipboardData is present", () => {
    const setData = vi.fn();
    expect(applyTerminalCopyEvent("ls -la", { setData })).toEqual({
      preventDefault: true,
      claimWriteFallback: true,
    });
    expect(setData).toHaveBeenCalledWith("text/plain", "ls -la");
  });

  it("leaves the writeText fallback alive when clipboardData is missing", () => {
    // Electron's edit-menu Copy often delivers a copy event with no
    // clipboardData. Claiming that event used to skip writeText and copy the
    // empty IME textarea, which is the blank clipboard users paste.
    expect(applyTerminalCopyEvent("ls -la", null)).toEqual({
      preventDefault: false,
      claimWriteFallback: false,
    });
    expect(applyTerminalCopyEvent("", { setData: vi.fn() })).toEqual({
      preventDefault: false,
      claimWriteFallback: false,
    });
  });

  it("primes the current selection before a copy event with no clipboardData", () => {
    const input = {
      value: "stale",
      selectionStart: 0,
      selectionEnd: 0,
      select() {
        this.selectionStart = 0;
        this.selectionEnd = this.value.length;
      },
    };
    primeTerminalCopyInput(input, "git status");
    expect(applyTerminalCopyEvent("git status", null)).toEqual({
      preventDefault: false,
      claimWriteFallback: false,
    });
    expect(input.value).toBe("git status");
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(10);
  });
});

describe("primeTerminalCopyInput", () => {
  it("selects the Ghostty selection in the hidden textarea so native copy has text", () => {
    const input = {
      value: "",
      selectionStart: 0,
      selectionEnd: 0,
      select() {
        this.selectionStart = 0;
        this.selectionEnd = this.value.length;
      },
    };
    primeTerminalCopyInput(input, "git status");
    expect(input.value).toBe("git status");
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(10);
    clearPrimedTerminalCopyInput(input, "git status");
    expect(input.value).toBe("");
  });

  it("does not wipe an IME candidate that replaced the primed copy", () => {
    const input = { value: "", select() {} };
    primeTerminalCopyInput(input, "git status");
    input.value = "あ";
    clearPrimedTerminalCopyInput(input, "git status");
    expect(input.value).toBe("あ");
  });
});

describe("isTerminalPasteShortcut", () => {
  const event = (overrides: Partial<Parameters<typeof isTerminalPasteShortcut>[0]> = {}) => ({
    ctrlKey: false,
    key: "v",
    metaKey: false,
    shiftKey: false,
    ...overrides,
  });

  it("uses Cmd+V on macOS", () => {
    expect(isTerminalPasteShortcut(event({ metaKey: true }), "MacIntel")).toBe(true);
    expect(isTerminalPasteShortcut(event({ ctrlKey: true }), "MacIntel")).toBe(false);
  });

  it("preserves Ctrl+V and uses Ctrl+Shift+V elsewhere", () => {
    expect(isTerminalPasteShortcut(event({ ctrlKey: true }), "Linux x86_64")).toBe(false);
    expect(isTerminalPasteShortcut(event({ ctrlKey: true, shiftKey: true }), "Linux x86_64")).toBe(
      true,
    );
  });

  it("supports the conventional Shift+Insert paste shortcut", () => {
    expect(isTerminalPasteShortcut(event({ key: "Insert", shiftKey: true }), "Linux x86_64")).toBe(
      true,
    );
    expect(isTerminalPasteShortcut(event({ key: "Insert" }), "Linux x86_64")).toBe(false);
    expect(
      isTerminalPasteShortcut(
        event({ key: "Insert", ctrlKey: true, shiftKey: true }),
        "Linux x86_64",
      ),
    ).toBe(false);
    expect(isTerminalPasteShortcut(event({ key: "Insert", shiftKey: true }), "MacIntel")).toBe(
      false,
    );
  });
});

describe("isTerminalCompositionCommitInput", () => {
  it("identifies browser composition follow-up input", () => {
    expect(isTerminalCompositionCommitInput({ inputType: "" })).toBe(true);
    expect(isTerminalCompositionCommitInput({ inputType: "insertCompositionText" })).toBe(true);
    expect(isTerminalCompositionCommitInput({ inputType: "insertFromComposition" })).toBe(true);
  });

  it("keeps a fast repeated input as legitimate text", () => {
    expect(isTerminalCompositionCommitInput({ inputType: "insertText" })).toBe(false);
  });
});

describe("isTerminalCompositionKey", () => {
  const event = (
    overrides: Partial<Pick<KeyboardEvent, "isComposing" | "key" | "keyCode">> = {},
  ) => ({
    isComposing: false,
    key: "a",
    keyCode: 65,
    ...overrides,
  });

  it("treats in-progress IME keydowns as composition so the copy primer cannot wipe them", () => {
    expect(isTerminalCompositionKey(event({ isComposing: true }), false)).toBe(true);
    expect(isTerminalCompositionKey(event(), true)).toBe(true);
    expect(isTerminalCompositionKey(event({ key: "Process" }), false)).toBe(true);
    expect(isTerminalCompositionKey(event({ keyCode: 229 }), false)).toBe(true);
  });

  it("lets ordinary keydowns clear a primed copy", () => {
    expect(isTerminalCompositionKey(event(), false)).toBe(false);
  });
});

describe("application mouse reporting", () => {
  const event = (overrides: Partial<Parameters<typeof shouldReportTerminalMouse>[1]> = {}) => ({
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...overrides,
  });

  it("keeps Shift and link activation modifiers available to the browser", () => {
    expect(shouldReportTerminalMouse(true, event())).toBe(true);
    expect(shouldReportTerminalMouse(true, event({ shiftKey: true }))).toBe(false);
    expect(shouldReportTerminalMouse(true, event({ ctrlKey: true }))).toBe(false);
    expect(shouldReportTerminalMouse(true, event({ metaKey: true }))).toBe(false);
    expect(shouldReportTerminalMouse(false, event())).toBe(false);
  });

  it("maps browser buttons to Ghostty's button enum", () => {
    expect([0, 1, 2, 3, 4, 5].map(ghosttyMouseButton)).toEqual([1, 3, 2, 4, 5, null]);
  });

  it("drops repeated motion reports until another mouse action resets the cell", () => {
    const first = resolveTerminalMouseData("motion", "\u001b[<35;8;4M", "");
    expect(first).toEqual({ send: true, nextMotionData: "\u001b[<35;8;4M" });

    const duplicate = resolveTerminalMouseData("motion", "\u001b[<35;8;4M", first.nextMotionData);
    expect(duplicate).toEqual({ send: false, nextMotionData: "\u001b[<35;8;4M" });

    const press = resolveTerminalMouseData("press", "\u001b[<0;8;4M", duplicate.nextMotionData);
    expect(press).toEqual({ send: true, nextMotionData: "" });

    expect(resolveTerminalMouseData("motion", "\u001b[<35;8;4M", press.nextMotionData)).toEqual({
      send: true,
      nextMotionData: "\u001b[<35;8;4M",
    });
  });

  it("clears the motion baseline when application mouse tracking changes", () => {
    expect(resolveTerminalMouseTrackingState(true, false, "\u001b[<35;8;4M")).toEqual({
      tracking: false,
      motionData: "",
    });
    expect(resolveTerminalMouseTrackingState(false, true, "\u001b[<35;8;4M")).toEqual({
      tracking: true,
      motionData: "",
    });
    expect(resolveTerminalMouseTrackingState(true, true, "\u001b[<35;8;4M")).toEqual({
      tracking: true,
      motionData: "\u001b[<35;8;4M",
    });
    expect(resolveTerminalMouseTrackingState(false, false, "\u001b[<35;8;4M")).toEqual({
      tracking: false,
      motionData: "\u001b[<35;8;4M",
    });
  });
});

describe("terminal font resolution", () => {
  it("validates the requested face after its styles load", async () => {
    let loaded = false;
    const load = vi.fn(async () => {
      loaded = true;
      return [];
    });
    const resolve = vi.fn(() => {
      expect(loaded).toBe(true);
      return DEFAULT_TERMINAL_FONT_FAMILY;
    });

    await expect(
      loadTerminalFontFamily("Proportional Test", 12, {
        load,
        resolve,
      }),
    ).resolves.toBe(DEFAULT_TERMINAL_FONT_FAMILY);
    expect(load).toHaveBeenCalledTimes(4);
    expect(resolve).toHaveBeenCalledWith("Proportional Test");
  });

  it("keeps the glyph fallbacks behind a custom text face", () => {
    expect(terminalFontFamily()).toBe(DEFAULT_TERMINAL_FONT_FAMILY);
    expect(terminalFontFamily("  ")).toBe(DEFAULT_TERMINAL_FONT_FAMILY);
    const custom = terminalFontFamily('"Fira Code"');
    expect(custom.startsWith('"Fira Code", ')).toBe(true);
    expect(custom).toContain('"Symbols Nerd Font Mono"');
    expect(custom.endsWith("monospace")).toBe(true);
  });

  it("ignores proportional families the cell grid cannot lay out", () => {
    // jsdom has no canvas metrics, so the probe answers "monospace" and the
    // family is kept; the guard is exercised in the browser instead. Assert the
    // shape stays intact so a rejected face still yields a usable stack.
    const stack = terminalFontFamily("Helvetica Neue");
    expect(stack.endsWith("monospace")).toBe(true);
  });

  it("quotes families the canvas font shorthand would otherwise reject", () => {
    expect(terminalFontFamily("3270 Nerd Font").startsWith('"3270 Nerd Font", ')).toBe(true);
    expect(terminalFontFamily("M+ 1m").startsWith('"M+ 1m", ')).toBe(true);
    expect(terminalFontFamily("Cascadia Code, Menlo").startsWith('"Cascadia Code", Menlo, ')).toBe(
      true,
    );
    expect(terminalFontFamily(" , ")).toBe(DEFAULT_TERMINAL_FONT_FAMILY);
  });

  it("clamps requested font sizes to the supported range", () => {
    expect(terminalFontSize()).toBe(DEFAULT_TERMINAL_FONT_SIZE);
    expect(terminalFontSize(Number.NaN)).toBe(DEFAULT_TERMINAL_FONT_SIZE);
    expect(terminalFontSize(13.4)).toBe(13);
    expect(terminalFontSize(2)).toBe(6);
    expect(terminalFontSize(90)).toBe(32);
  });
});

describe("terminalContentOriginY", () => {
  it("stays top-anchored like a fresh terminal until scrollback exists", () => {
    expect(terminalContentOriginY(100, 4, 5, 16, false)).toBe(4);
  });

  it("pins the grid to the bottom by moving the sub-row slack above row 0", () => {
    // 100px mount, 4px padding, 5 rows of 16px: 92 - 80 = 12px slack on top.
    expect(terminalContentOriginY(100, 4, 5, 16, true)).toBe(16);
    // Exact fit keeps the origin at the padding.
    expect(terminalContentOriginY(88, 4, 5, 16, true)).toBe(4);
    // A mount smaller than the grid never pushes the origin above the padding.
    expect(terminalContentOriginY(80, 4, 5, 16, true)).toBe(4);
  });

  it("keeps the prompt stationary while a drag crosses row boundaries", () => {
    // Growing the mount pixel by pixel: the bottom edge (origin + rows*cell)
    // tracks the mount bottom exactly until a new row fits.
    for (let height = 88; height < 104; height += 1) {
      const rows = Math.max(1, Math.floor((height - 8) / 16));
      const origin = terminalContentOriginY(height, 4, rows, 16, true);
      expect(origin + rows * 16).toBe(height - 4);
    }
  });
});

describe("terminalWheelDeltaRows", () => {
  it("converts line-mode deltas into whole rows", () => {
    const result = terminalWheelDeltaRows({ deltaY: 3, deltaMode: 1 }, 16, 24, 0);
    expect(result.rows).toBe(3);
    expect(result.remainder).toBe(0);
  });

  it("accumulates fractional pixel deltas across events", () => {
    let remainder = 0;
    let scrolled = 0;
    for (let index = 0; index < 4; index += 1) {
      const result = terminalWheelDeltaRows({ deltaY: 5, deltaMode: 0 }, 16, 24, remainder);
      remainder = result.remainder;
      scrolled += result.rows;
    }
    expect(scrolled).toBe(1);
    expect(remainder).toBeCloseTo(4 / 16);
  });

  it("keeps direction for negative page-mode deltas", () => {
    const result = terminalWheelDeltaRows({ deltaY: -1, deltaMode: 2 }, 16, 24, 0);
    expect(result.rows).toBe(-24);
    expect(result.remainder).toBe(0);
  });
});

describe("terminalWheelArrowData", () => {
  it("emits one arrow per row honoring application cursor keys", () => {
    expect(terminalWheelArrowData(-2, false)).toBe("\u001b[A\u001b[A");
    expect(terminalWheelArrowData(3, false)).toBe("\u001b[B\u001b[B\u001b[B");
    expect(terminalWheelArrowData(-1, true)).toBe("\u001bOA");
    expect(terminalWheelArrowData(0, true)).toBe("");
  });
});

describe("isTerminalLinkPointerGesture", () => {
  it("uses Command on macOS and Control elsewhere", () => {
    expect(isTerminalLinkPointerGesture({ ctrlKey: false, metaKey: true }, "MacIntel")).toBe(true);
    expect(isTerminalLinkPointerGesture({ ctrlKey: true, metaKey: false }, "MacIntel")).toBe(false);
    expect(isTerminalLinkPointerGesture({ ctrlKey: true, metaKey: false }, "Linux x86_64")).toBe(
      true,
    );
    expect(isTerminalLinkPointerGesture({ ctrlKey: false, metaKey: true }, "Linux x86_64")).toBe(
      false,
    );
  });
});

describe("advanceTerminalSelectionClickSequence", () => {
  it("recognizes stationary double and triple pointer presses without PointerEvent.detail", () => {
    const first = advanceTerminalSelectionClickSequence(null, {
      clientX: 20,
      clientY: 30,
      timeStamp: 1_000,
    });
    const second = advanceTerminalSelectionClickSequence(first, {
      clientX: 22,
      clientY: 29,
      timeStamp: 1_200,
    });
    const third = advanceTerminalSelectionClickSequence(second, {
      clientX: 21,
      clientY: 31,
      timeStamp: 1_400,
    });

    expect([first.count, second.count, third.count]).toEqual([1, 2, 3]);
  });

  it("starts over after movement, delay, or a completed triple click", () => {
    const previous = { count: 3, time: 1_000, x: 20, y: 30 };
    expect(
      advanceTerminalSelectionClickSequence(previous, {
        clientX: 20,
        clientY: 30,
        timeStamp: 1_100,
      }).count,
    ).toBe(1);
    expect(
      advanceTerminalSelectionClickSequence(previous, {
        clientX: 30,
        clientY: 30,
        timeStamp: 1_100,
      }).count,
    ).toBe(1);
    expect(
      advanceTerminalSelectionClickSequence(previous, {
        clientX: 20,
        clientY: 30,
        timeStamp: 1_501,
      }).count,
    ).toBe(1);
  });
});

describe("terminal scrollbar", () => {
  it("maps Ghostty's viewport state to a proportional thumb", () => {
    expect(terminalScrollbarGeometry({ total: 100, offset: 40, len: 20 }, 200)).toEqual({
      thumbHeight: 40,
      thumbTop: 80,
      maxOffset: 80,
    });
    expect(terminalScrollbarGeometry({ total: 100, offset: 0, len: 100 }, 200)).toBeNull();
  });

  it("keeps the thumb usable for large scrollback and maps dragging back to rows", () => {
    const state = { total: 10_000, offset: 0, len: 20 };
    expect(terminalScrollbarGeometry(state, 200)).toEqual({
      thumbHeight: 18,
      thumbTop: 0,
      maxOffset: 9_980,
    });
    expect(terminalScrollbarOffsetAtPointer(state, 200, 191, 9)).toBe(9_980);
  });
});
