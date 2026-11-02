import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  applyTerminalAttachStreamEvent,
  INITIAL_TERMINAL_OUTPUT_CURSOR,
  nextTerminalAttachSeedState,
} from "@t3tools/client-runtime/state/terminal";
import { synchronizeTerminalSession } from "../../components/ThreadTerminalDrawer";

import { GhosttyTerminalCore, type GhosttyCell, type GhosttyRow } from "./core";
import {
  advanceTerminalSelectionClickSequence,
  applyTerminalCopyEvent,
  clearPrimedTerminalCopyInput,
  isTerminalCompositionKey,
  isTerminalCopyShortcut,
  primeTerminalCopyInput,
  resolveTerminalMouseData,
  terminalLinkAtPositionWithRange,
  terminalContentOriginY,
  terminalSelectionAutoscrollRows,
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

describe("GhosttyTerminalSurface visibility", () => {
  const surfaces = new Set<GhosttyTerminalSurface>();

  function key(
    surface: GhosttyTerminalSurface,
    key: string,
    code: string,
    modifiers: Partial<
      Pick<
        KeyboardEvent,
        | "altKey"
        | "ctrlKey"
        | "metaKey"
        | "shiftKey"
        | "isComposing"
        | "repeat"
        | "keyCode"
        | "getModifierState"
      >
    > = {},
    type = "keydown",
    target: EventTarget = surface.input,
  ) {
    const event = Object.assign(new Event(type, { cancelable: true }), {
      key,
      code,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      isComposing: false,
      repeat: false,
      keyCode: 0,
      getModifierState: () => false,
      ...modifiers,
    });
    target.dispatchEvent(event);
    return event;
  }

  function createHarness() {
    vi.useFakeTimers();
    const frames = new Map<number, FrameRequestCallback>();
    const resizeTargets = new Map<(entries: { target: Element }[]) => void, Set<Element>>();
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
      createElement: (tag: string) => (tag === "canvas" ? canvas : new TerminalTestElement()),
      fonts: Object.assign(new EventTarget(), { load: async () => [], add() {} }),
    });
    vi.stubGlobal(
      "window",
      Object.assign(new EventTarget(), {
        devicePixelRatio: 1,
        innerHeight: 104,
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
        constructor(private readonly callback: (entries: { target: Element }[]) => void) {
          resizeTargets.set(callback, new Set());
        }
        observe(target: Element) {
          resizeTargets.get(this.callback)?.add(target);
        }
        unobserve(target: Element) {
          resizeTargets.get(this.callback)?.delete(target);
        }
        disconnect() {
          resizeTargets.delete(this.callback);
        }
      },
    );
    const snapshot = vi.spyOn(GhosttyTerminalCore.prototype, "snapshot");
    const onData = vi.fn<(data: string) => void>();

    return {
      canvas,
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
        for (const [callback, targets] of resizeTargets) {
          callback([...targets].map((target) => ({ target })));
        }
      },
      pointer(
        type: string,
        clientX: number,
        buttons: number,
        modifiers: boolean | Partial<Pick<MouseEvent, "ctrlKey" | "metaKey" | "shiftKey">> = {},
        button = 0,
        clientY = 5,
      ) {
        canvas.dispatchEvent(
          Object.assign(new Event(type, { cancelable: true }), {
            clientX,
            clientY,
            pointerId: 1,
            button,
            buttons,
            ...(typeof modifiers === "boolean" ? { shiftKey: modifiers } : modifiers),
          }),
        );
      },
      touch(type: string, clientY: number, pointerId = 2) {
        canvas.dispatchEvent(
          Object.assign(new Event(type, { cancelable: true }), {
            clientX: 40,
            clientY,
            pointerId,
            pointerType: "touch",
            isPrimary: pointerId === 2,
            button: 0,
            buttons: type === "pointerup" ? 0 : 1,
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

  it("preserves shell Ctrl+A and ordinary application navigation", async () => {
    vi.stubGlobal("navigator", { platform: "Linux x86_64" });
    const harness = createHarness();
    const surface = await harness.create({ beforeKey: () => true });
    key(surface, "a", "KeyA", { ctrlKey: true });
    key(surface, "PageUp", "PageUp");
    key(surface, "PageDown", "PageDown");
    key(surface, "Home", "Home");
    key(surface, "End", "End");
    expect(harness.onData.mock.calls.map(([data]) => data)).toEqual([
      "\x01",
      "\x1b[5~",
      "\x1b[6~",
      "\x1b[H",
      "\x1b[F",
    ]);
    expect(surface.hasSelection()).toBe(false);
  });

  it("leaves modified history keys with alternate-screen applications", async () => {
    vi.stubGlobal("navigator", { platform: "Linux x86_64" });
    const harness = createHarness();
    const surface = await harness.create({ beforeKey: () => true });
    surface.write("\x1b[?1049happ");
    key(surface, "PageUp", "PageUp", { shiftKey: true });
    key(surface, "End", "End", { ctrlKey: true, shiftKey: true });
    expect(harness.onData.mock.calls.map(([data]) => data)).toEqual(["\x1b[5;2~", "\x1b[1;6F"]);
    surface.selectAll();
    expect(surface.getSelection()).toBe("app");
    surface.write("\x1b[?1049l");
    expect(surface.getSelection()).toBe("");
  });

  it("suppresses local shortcut releases in Kitty sessions, including read-only observers", async () => {
    vi.stubGlobal("navigator", { platform: "Linux x86_64" });
    const harness = createHarness();
    const surface = await harness.create({ beforeKey: () => true });
    surface.input.readOnly = true;
    surface.write("history\x1b[>31u");
    for (const [name, code, modifiers] of [
      ["PageUp", "PageUp", { shiftKey: true }],
      ["Home", "Home", { ctrlKey: true, shiftKey: true }],
      ["a", "KeyA", { ctrlKey: true, shiftKey: true }],
    ] as const) {
      key(surface, name, code, modifiers);
      key(surface, name, code, modifiers, "keyup");
    }
    expect(surface.getSelection()).toBe("history");
    expect(harness.onData).not.toHaveBeenCalled();

    key(surface, "PageUp", "PageUp");
    key(surface, "PageUp", "PageUp", {}, "keyup");
    expect(harness.onData).toHaveBeenCalledTimes(2);
    expect(harness.onData.mock.calls[1]?.[0]).toContain(":3");
  });

  it("reports Kitty releases only for presses encoded by this surface", async () => {
    const harness = createHarness();
    const surface = await harness.create({ beforeKey: () => true });
    surface.write("\x1b[>11u");

    key(surface, "a", "KeyA");
    key(surface, "a", "KeyA", {}, "keyup");
    key(surface, "Control", "ControlLeft", { ctrlKey: true });
    // App capture stops Ctrl+D before it reaches the terminal input.
    key(surface, "d", "KeyD", { ctrlKey: true }, "keydown", window);
    key(surface, "d", "KeyD", { ctrlKey: true }, "keyup");
    key(surface, "Control", "ControlLeft", {}, "keyup");

    expect(harness.onData.mock.calls.map(([data]) => data)).toEqual([
      "\x1b[97u",
      "\x1b[97;1:3u",
      "\x1b[57442;5u",
      "\x1b[57442;1:3u",
    ]);
  });

  it("keeps a held Kitty press through focus changes and an app-consumed repeat", async () => {
    const harness = createHarness();
    let consumeRepeat = false;
    const surface = await harness.create({ beforeKey: () => !consumeRepeat });
    surface.write("\x1b[>11u");

    key(surface, "a", "KeyA");
    key(surface, "a", "KeyA", { repeat: true });
    surface.input.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("focus"));
    surface.input.dispatchEvent(new Event("focus"));
    consumeRepeat = true;
    key(surface, "a", "KeyA", { repeat: true });
    key(surface, "a", "KeyA", {}, "keyup");

    expect(harness.onData.mock.calls.map(([data]) => data)).toEqual([
      "\x1b[97u",
      "\x1b[97;1:2u",
      "\x1b[97;1:3u",
    ]);
  });

  it("honors host interception, IME candidates, and AltGr before local shortcuts", async () => {
    vi.stubGlobal("navigator", { platform: "Linux x86_64" });
    const harness = createHarness();
    let allow = false;
    const surface = await harness.create({ beforeKey: () => allow });
    surface.write("hello\x1b[>31u");
    key(surface, "a", "KeyA", { ctrlKey: true, shiftKey: true });
    key(surface, "a", "KeyA", {}, "keyup");
    expect(surface.hasSelection()).toBe(false);
    allow = true;
    surface.input.value = "候補";
    key(surface, "a", "KeyA", { ctrlKey: true, shiftKey: true, isComposing: true });
    key(surface, "a", "KeyA", {}, "keyup");
    key(surface, "a", "KeyA", { ctrlKey: true, shiftKey: true, keyCode: 229 });
    key(surface, "a", "KeyA", {}, "keyup");
    key(surface, "a", "KeyA", {
      ctrlKey: true,
      shiftKey: true,
      altKey: true,
      getModifierState: (modifier) => modifier === "AltGraph",
    });
    key(surface, "a", "KeyA", {}, "keyup");
    expect(surface.input.value).toBe("候補");
    expect(surface.hasSelection()).toBe(false);
    expect(harness.onData).not.toHaveBeenCalled();
  });

  function paste(surface: GhosttyTerminalSurface, text: string) {
    surface.input.dispatchEvent(
      Object.assign(new Event("paste", { cancelable: true }), {
        clipboardData: { getData: () => text },
      }),
    );
  }

  it.each(["native", "clipboard"])("pastes once when %s arrives first", async (first) => {
    const harness = createHarness();
    const read = Promise.resolve("echo hi");
    vi.stubGlobal("navigator", {
      platform: "MacIntel",
      clipboard: { readText: () => read },
    });
    const surface = await harness.create({ beforeKey: () => true });

    key(surface, "v", "KeyV", { metaKey: true });
    if (first === "native") paste(surface, "echo hi");
    await read;
    if (first === "clipboard") paste(surface, "echo hi");

    expect(harness.onData.mock.calls).toEqual([["echo hi"]]);
  });

  it.each(["V keyup", "blur", "Meta keyup without V keyup"])(
    "accepts a later identical menu paste after %s",
    async (end) => {
      const harness = createHarness();
      const read = Promise.resolve("echo hi");
      vi.stubGlobal("navigator", {
        platform: "MacIntel",
        clipboard: { readText: () => read },
      });
      const surface = await harness.create({ beforeKey: () => true });

      key(surface, "v", "KeyV", { metaKey: true });
      await read;
      expect(harness.onData.mock.calls).toEqual([["echo hi"]]);
      if (end === "blur") surface.input.dispatchEvent(new Event("blur"));
      else if (end === "V keyup") key(surface, "v", "KeyV", { metaKey: true }, "keyup");
      // macOS can omit V keyup while Command is held.
      else key(surface, "Meta", "MetaLeft", {}, "keyup");
      paste(surface, "echo hi");

      expect(harness.onData.mock.calls).toEqual([["echo hi"], ["echo hi"]]);
    },
  );

  it("keeps a selection through redraws until the selected text changes", async () => {
    const harness = createHarness();
    const surface = await harness.create();
    const seed = nextTerminalAttachSeedState();
    let state = applyTerminalAttachStreamEvent(seed, {
      type: "snapshot",
      snapshot: {
        threadId: "thread",
        terminalId: "term-1",
        cwd: "/repo",
        worktreePath: null,
        status: "running",
        pid: 123,
        history: "* Working |",
        exitCode: null,
        exitSignal: null,
        label: "Terminal",
        updatedAt: "2026-10-20T00:00:00.000Z",
      },
    });
    let cursor = synchronizeTerminalSession(surface, seed, state, INITIAL_TERMINAL_OUTPUT_CURSOR);
    harness.flushFrame();
    harness.pointer("pointerdown", 5, 1);
    harness.pointer("pointermove", 85, 1);
    harness.pointer("pointerup", 85, 0);
    expect(surface.getSelection()).toBe("* Working |");

    // A TUI repaints its spinner line in place, the way Claude Code redraws.
    const redraw = (data: string) => {
      const previous = state;
      state = applyTerminalAttachStreamEvent(state, {
        type: "output",
        threadId: "thread",
        terminalId: "term-1",
        data,
      });
      cursor = synchronizeTerminalSession(surface, previous, state, cursor);
    };
    redraw("\r\x1b[2K* Working |");
    expect(surface.getSelection()).toBe("* Working |");

    redraw("\r\x1b[2K* Working /");
    expect(surface.getSelection()).toBe("");
    expect(surface.getSelectionPosition()).toBeNull();
  });

  it("reports where a selection sits after output scrolls it", async () => {
    const harness = createHarness();
    const surface = await harness.create();
    const rows = Array.from({ length: 10 }, (_, index) => `row ${index}`);
    surface.write(`\x1b[?1049h\x1b[H${rows.join("\r\n")}`);
    harness.flushFrame();
    harness.pointer("pointerdown", 5, 1, {}, 0, 50);
    harness.pointer("pointermove", 45, 1, {}, 0, 50);
    harness.pointer("pointerup", 45, 0, {}, 0, 50);
    const text = surface.getSelection();
    const before = surface.getSelectionPosition();
    expect(text).toMatch(/^row \d$/);

    surface.write("\r\nrow 10\r\nrow 11");
    expect(surface.getSelection()).toBe(text);
    expect(surface.getSelectionPosition()?.start.y).toBe(before!.start.y - 2);
  });

  it("keeps a drag anchored to its text when output scrolls it mid-drag", async () => {
    const harness = createHarness();
    const surface = await harness.create();
    const rows = Array.from({ length: 10 }, (_, index) => `row ${index}`);
    surface.write(`\x1b[?1049h\x1b[H${rows.join("\r\n")}`);
    harness.flushFrame();
    harness.pointer("pointerdown", 5, 1, {}, 0, 50);
    harness.pointer("pointermove", 45, 1, {}, 0, 50);
    expect(surface.getSelection()).toBe("row 6");

    // The pointer stays over the row that output scrolls "row 8" into.
    surface.write("\r\nrow 10\r\nrow 11");
    harness.pointer("pointermove", 53, 1, {}, 0, 50);
    expect(surface.getSelection()).toBe("row 6\nrow 7\nrow 8");
  });

  it("does not activate a link replaced before pointer release", async () => {
    const harness = createHarness();
    const onLinkActivate = vi.fn();
    const surface = await harness.create({ onLinkActivate });
    surface.write("https://first.example");
    harness.flushFrame();

    harness.pointer("pointerdown", 5, 1);
    surface.write("\x1b[2J\x1b[Hhttps://second.example");
    harness.flushFrame();
    harness.pointer("pointerup", 5, 0);

    expect(onLinkActivate).not.toHaveBeenCalled();
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

describe("terminalLinkAtPositionWithRange", () => {
  it.each([
    { text: "https://example.com/日本", cols: 80, end: { x: 23, y: 0 } },
    { text: "src/日本/main.ts:3:1", cols: 80, end: { x: 19, y: 0 } },
    { text: "https://example.com/🙂", cols: 80, end: { x: 21, y: 0 } },
    { text: "https://example.com/日本", cols: 23, end: { x: 1, y: 1 } },
  ])("keeps every cell of $text clickable at $cols columns", async ({ text, cols, end }) => {
    const core = await GhosttyTerminalCore.create(
      cols,
      3,
      8,
      16,
      {
        foreground: { r: 255, g: 255, b: 255 },
        background: { r: 0, g: 0, b: 0 },
        cursor: { r: 255, g: 255, b: 255 },
      },
      () => {},
    );
    try {
      core.write(text + " next");
      const rows = core.snapshot().rowData;
      for (let y = 0; y <= end.y; y += 1) {
        const lastColumn = y === end.y ? end.x : cols - 2;
        for (let x = 0; x <= lastColumn; x += 1) {
          expect(terminalLinkAtPositionWithRange(rows, y, x)).toEqual({
            text,
            range: { start: { x: 0, y: 0 }, end },
          });
        }
      }
      expect(terminalLinkAtPositionWithRange(rows, end.y, end.x + 1)).toBeNull();
    } finally {
      core.dispose();
    }
  });

  it("activates a wrapped quoted Windows path from its spaces and position suffix", () => {
    const row = (text: string, isWrapContinuation: boolean): GhosttyRow => ({
      cells: Array.from(text, (character) => cell(character)),
      text,
      isWrapContinuation,
      wrapsToNext: false,
    });
    const first = String.raw`"C:\Users\Jane `;
    const second = String.raw`Doe\index.ts":12:7`;
    const rows = [row(first, false), row(second, true)];
    const expected = {
      text: String.raw`C:\Users\Jane Doe\index.ts:12:7`,
      range: { start: { x: 1, y: 0 }, end: { x: second.length - 1, y: 1 } },
    };
    expect(terminalLinkAtPositionWithRange(rows, 0, first.length - 1)).toEqual(expected);
    expect(terminalLinkAtPositionWithRange(rows, 1, second.length - 1)).toEqual(expected);
    expect(terminalLinkAtPositionWithRange(rows, 0, 0)).toBeNull();
  });

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
      row("PS C:\\repo\\dir 1", false, true),
      row("\\test> ", true),
    ];

    expect(terminalLinkAtPositionWithRange(rows, 0, 8)?.text).toBe("https://example.com/reference");
    expect(terminalLinkAtPositionWithRange(rows, 1, 4)?.text).toBe("https://example.com/reference");
    expect(terminalLinkAtPositionWithRange(rows, 2, 2)?.text).toBe("~/project/file");
    expect(terminalLinkAtPositionWithRange(rows, 3, 4)?.text).toBe("C:\\repo\\file.ts");
    expect(terminalLinkAtPositionWithRange(rows, 4, 13)).toEqual({
      text: "C:\\repo\\dir 1\\test",
      range: { start: { x: 3, y: 4 }, end: { x: 4, y: 5 } },
    });
    expect(terminalLinkAtPositionWithRange(rows, 5, 2)?.text).toBe("C:\\repo\\dir 1\\test");
    expect(terminalLinkAtPositionWithRange(rows, 5, 5)).toBeNull();
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
    const headCut = [row("ple.com/missing", true), row("head", true)];
    expect(terminalLinkAtPositionWithRange(headCut, 0, 4)).toBeNull();
    const tailCut = [row("https://t3.codes", false, true)];
    expect(terminalLinkAtPositionWithRange(tailCut, 0, 8)).toBeNull();
    const complete = [row("https://t3.codes", false), row("", false)];
    expect(terminalLinkAtPositionWithRange(complete, 0, 8)?.text).toBe("https://t3.codes");
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

  it("uses the produced character instead of the physical key position", () => {
    expect(isTerminalCopyShortcut(event({ key: "C", metaKey: true }), "MacIntel")).toBe(true);
    expect(isTerminalCopyShortcut(event({ key: "j", metaKey: true }), "MacIntel")).toBe(false);
  });
});

describe("applyTerminalCopyEvent", () => {
  // regression: #7678 copying a terminal selection produced a blank clipboard
  it("leaves the writeText fallback alive when clipboardData is missing", () => {
    // Electron menu Copy often omits clipboardData.
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
  it("does not wipe an IME candidate that replaced the primed copy", () => {
    const input = { value: "", select() {} };
    primeTerminalCopyInput(input, "git status");
    input.value = "あ";
    clearPrimedTerminalCopyInput(input, "git status");
    expect(input.value).toBe("あ");
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
});

describe("application mouse reporting", () => {
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
});

describe("terminalContentOriginY", () => {
  it("keeps the prompt stationary while a drag crosses row boundaries", () => {
    for (let height = 88; height < 104; height += 1) {
      const rows = Math.max(1, Math.floor((height - 8) / 16));
      const origin = terminalContentOriginY(height, 4, rows, 16, true);
      expect(origin + rows * 16).toBe(height - 4);
    }
  });
});

describe("terminalWheelDeltaRows", () => {
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
});

// regression: #19492 drag selection scrolled one row per tick however far past the edge
describe("terminalSelectionAutoscrollRows", () => {
  it("scrolls more rows per tick the farther the pointer is past an edge", () => {
    const top = 100;
    const bottom = 500;
    expect(terminalSelectionAutoscrollRows(300, top, bottom)).toBe(0);
    expect(terminalSelectionAutoscrollRows(99, top, bottom)).toBe(-1);
    expect(terminalSelectionAutoscrollRows(75, top, bottom)).toBe(-8);
    expect(terminalSelectionAutoscrollRows(501, top, bottom)).toBe(1);
    expect(terminalSelectionAutoscrollRows(525, top, bottom)).toBe(8);
    expect(terminalSelectionAutoscrollRows(550, top, bottom)).toBe(15);
    expect(terminalSelectionAutoscrollRows(2_000, top, bottom)).toBe(15);
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
});
