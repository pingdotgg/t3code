import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  applyTerminalAttachStreamEvent,
  DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
  INITIAL_TERMINAL_OUTPUT_CURSOR,
  nextTerminalAttachSeedState,
  readTerminalOutputUpdate,
  terminalOutputText,
  type TerminalBufferState,
} from "@t3tools/client-runtime/state/terminal";

import { writeTerminalOutputUpdate } from "../../components/ThreadTerminalDrawer";
import { GHOSTTY_CELL_WIDE, GhosttyTerminalCore, ghosttyCellText } from "./core";
import { loadGhosttyRuntime } from "./runtime";

vi.mock("./vendor/ghostty-vt.wasm?url", async () => ({
  default: (await import("./vendor/ghostty-vt.wasm?inline")).default,
}));
vi.mock("./vendor/ghostty-write-pty.wasm?url&no-inline", async () => ({
  default: (await import("./vendor/ghostty-write-pty.wasm?inline")).default,
}));

function codepointView(codepoints: ReadonlyArray<number>): DataView {
  const view = new DataView(new ArrayBuffer(codepoints.length * 4));
  codepoints.forEach((codepoint, index) => view.setUint32(index * 4, codepoint, true));
  return view;
}

describe("ghosttyCellText", () => {
  it("converts oversized grapheme clusters without hitting engine spread limits", () => {
    // A program printing one base character followed by a huge run of
    // combining marks packs the whole cluster into one cell; spreading that
    // many arguments into String.fromCodePoint once overflows the call stack.
    const graphemeLength = 130_000;
    const view = new DataView(new ArrayBuffer(graphemeLength * 4));
    for (let index = 0; index < graphemeLength; index += 1) {
      view.setUint32(index * 4, index === 0 ? "a".codePointAt(0)! : 0x301, true);
    }
    const text = ghosttyCellText(view, graphemeLength);
    expect(text.length).toBe(graphemeLength);
    expect(text.codePointAt(0)).toBe("a".codePointAt(0));
    expect(text.codePointAt(1)).toBe(0x301);
    expect(text.codePointAt(graphemeLength - 1)).toBe(0x301);
  });

  it("converts small clusters including astral codepoints", () => {
    const text = ghosttyCellText(codepointView([0x1f642, 0x20e3]), 2);
    expect([...text]).toEqual(["\u{1F642}", "\u{20E3}"]);
  });

  it("converts a single astral codepoint", () => {
    expect(ghosttyCellText(codepointView([0x1f642]), 1)).toBe("🙂");
  });

  it("returns an empty string for empty cells", () => {
    expect(ghosttyCellText(codepointView([]), 0)).toBe("");
  });
});

describe("GhosttyTerminalCore snapshots", () => {
  const cores = new Set<GhosttyTerminalCore>();

  async function createCore(onData: (data: string) => void = () => {}) {
    const core = await GhosttyTerminalCore.create(
      12,
      3,
      8,
      16,
      {
        foreground: { r: 255, g: 255, b: 255 },
        background: { r: 0, g: 0, b: 0 },
        cursor: { r: 255, g: 255, b: 255 },
      },
      onData,
    );
    cores.add(core);
    return core;
  }

  function createSession(history: string) {
    return applyTerminalAttachStreamEvent(nextTerminalAttachSeedState(), {
      type: "snapshot",
      snapshot: {
        threadId: "terminal-stream-test",
        terminalId: "term-1",
        cwd: "/repo",
        worktreePath: null,
        status: "running",
        pid: 123,
        history,
        exitCode: null,
        exitSignal: null,
        label: "Terminal",
        updatedAt: "2026-09-04T00:00:00.000Z",
      },
    });
  }

  function append(state: TerminalBufferState, data: string) {
    return applyTerminalAttachStreamEvent(state, {
      type: "output",
      threadId: "terminal-stream-test",
      terminalId: "term-1",
      data,
    });
  }

  afterEach(() => {
    for (const core of cores) core.dispose();
    cores.clear();
    vi.restoreAllMocks();
  });

  it("preserves styles, wide cells, and selection after shared memory grows", async () => {
    const core = await createCore();
    const runtime = await loadGhosttyRuntime();
    const grapheme = `e${"\u0301".repeat(64)}`;
    core.write(`\x1b[1;3;4;8;9;53;38;2;123;45;67;48;2;9;8;7m${grapheme}\x1b[0m界🙂`);
    const cells = core.snapshot().rowData[0]!.cells;
    expect(cells[0]).toEqual({
      text: grapheme,
      wide: 0,
      foreground: { r: 123, g: 45, b: 67 },
      background: { r: 9, g: 8, b: 7 },
      bold: true,
      italic: true,
      invisible: true,
      strikethrough: true,
      overline: true,
      underline: true,
      selected: false,
    });
    expect(cells.slice(1, 5).map(({ text, wide }) => ({ text, wide }))).toEqual([
      { text: "界", wide: 0 },
      { text: "", wide: GHOSTTY_CELL_WIDE.spacerTail },
      { text: "🙂", wide: 0 },
      { text: "", wide: GHOSTTY_CELL_WIDE.spacerTail },
    ]);

    runtime.memory.grow(1);
    core.setSelection({ x: 0, y: 0 }, { x: 2, y: 0 });
    expect(core.snapshot().rowData[0]!.cells[0]).toEqual({ ...cells[0], selected: true });
    core.clearSelection();
    expect(core.snapshot().rowData[0]!.cells[0]).toEqual(cells[0]);

    core.resetAndWrite("\x1b[2;7;38;2;40;100;200;48;2;12;34;56mC\x1b[0m");
    expect(core.snapshot().rowData[0]!.cells[0]).toMatchObject({
      text: "C",
      foreground: { r: 22, g: 59, b: 112 },
      background: { r: 40, g: 100, b: 200 },
      bold: false,
      underline: false,
      selected: false,
    });
  });

  it("reuses a grown grapheme buffer and releases it on disposal", async () => {
    const core = await createCore();
    const runtime = await loadGhosttyRuntime();
    core.write("ASCII");
    core.snapshot();

    const grapheme = `z${"\u0301".repeat(256)}`;
    core.resetAndWrite(`${grapheme}X`);
    const alloc = vi.spyOn(runtime, "alloc");
    const free = vi.spyOn(runtime, "free");
    expect(
      core
        .snapshot()
        .rowData[0]!.cells.slice(0, 2)
        .map((cell) => cell.text),
    ).toEqual([grapheme, "X"]);
    expect(alloc).toHaveBeenCalledTimes(1);
    const allocation = alloc.mock.results[0]!;
    if (allocation.type !== "return") throw new Error("Grapheme allocation did not return");
    const buffer = allocation.value;
    const capacity = alloc.mock.calls[0]![0];

    core.write("\rQ\u0301");
    alloc.mockClear();
    expect(core.snapshot().rowData[0]!.cells[0]!.text).toBe("Q\u0301");
    expect(alloc).not.toHaveBeenCalled();
    core.dispose();
    expect(free).toHaveBeenCalledWith(buffer, capacity);
  });

  it.each(["varied", "identical"] as const)(
    "preserves Ghostty state through a full MiB of %s output without rollover resets",
    async (kind) => {
      const [core, reference] = await Promise.all([createCore(), createCore()]);
      const initial = "\x1b[31m";
      let state = createSession(initial);
      const first = readTerminalOutputUpdate(state.output, INITIAL_TERMINAL_OUTPUT_CURSOR);
      writeTerminalOutputUpdate(core, first);
      reference.resetAndWrite(initial);
      let cursor = first.cursor;
      const reset = vi.spyOn(core, "resetAndWrite");
      const inputs: string[] = [];
      let receivedCharacters = 0;

      for (let index = 0; index < 128; index += 1) {
        const data =
          kind === "identical"
            ? "x".repeat(8192)
            : `${index.toString().padStart(4, "0")}\r\n${"x".repeat(8186)}`;
        inputs.push(data);
        state = append(state, data);
        const update = readTerminalOutputUpdate(state.output, cursor);
        if (update.type !== "append") throw new Error(`Expected append, received ${update.type}`);
        receivedCharacters += update.data.length;
        writeTerminalOutputUpdate(core, update);
        cursor = update.cursor;
      }

      reference.write(inputs.join(""));
      expect(receivedCharacters).toBe(1024 * 1024);
      expect(state.output.retainedBytes).toBe(DEFAULT_MAX_TERMINAL_BUFFER_BYTES);
      expect(reset).not.toHaveBeenCalled();
      expect(core.snapshot()).toEqual(reference.snapshot());
    },
  );

  it("preserves Unicode and split ANSI parser state across batched renderer reads", async () => {
    const [core, reference] = await Promise.all([createCore(), createCore()]);
    let state = createSession("");
    const first = readTerminalOutputUpdate(state.output, INITIAL_TERMINAL_OUTPUT_CURSOR);
    writeTerminalOutputUpdate(core, first);
    let cursor = first.cursor;
    const reset = vi.spyOn(core, "resetAndWrite");
    const inputs = [
      `${"a".repeat(16_383)}🙂`,
      "\x1b[3",
      "1m",
      "e",
      "\u0301界🙂",
      "\x1b[0",
      "m\r\n",
      "\x1b]8;;https://t3.codes\x1b",
      "\\link",
      "\x1b]8;;\x1b",
      "\\\x1b[?1049h",
      "alternate",
      "\x1b[?1049l",
      "\r\nend",
    ];
    let received = "";
    for (const [index, data] of inputs.entries()) {
      state = append(state, data);
      if (index % 3 !== 0 && index !== inputs.length - 1) continue;
      const update = readTerminalOutputUpdate(state.output, cursor);
      if (update.type !== "append") throw new Error(`Expected append, received ${update.type}`);
      received += update.data;
      writeTerminalOutputUpdate(core, update);
      cursor = update.cursor;
    }

    reference.write(inputs.join(""));
    expect(received).toBe(inputs.join(""));
    expect(reset).not.toHaveBeenCalled();
    expect(core.snapshot()).toEqual(reference.snapshot());
  });

  it("answers a live VT query when batched reads cross a chunk compaction", async () => {
    const replies: string[] = [];
    const core = await createCore((data) => replies.push(data));
    core.write("\x1b[5n");
    expect(replies).toEqual(["\x1b[0n"]);
    replies.length = 0;

    let state = createSession("");
    const initial = readTerminalOutputUpdate(state.output, INITIAL_TERMINAL_OUTPUT_CURSOR);
    writeTerminalOutputUpdate(core, initial);
    let cursor = initial.cursor;
    for (let index = 0; index < 1000; index += 1) {
      state = append(state, "x");
      const update = readTerminalOutputUpdate(state.output, cursor);
      writeTerminalOutputUpdate(core, update);
      cursor = update.cursor;
    }
    for (let index = 0; index < 24; index += 1) state = append(state, "x");
    state = append(state, "\x1b[5n");
    const update = readTerminalOutputUpdate(state.output, cursor);
    writeTerminalOutputUpdate(core, update);

    expect({ type: update.type, replies }).toEqual({ type: "append", replies: ["\x1b[0n"] });
  });

  it("recovers a lagging renderer once from bounded output and resumes appending", async () => {
    const [core, reference] = await Promise.all([createCore(), createCore()]);
    let state = createSession("\x1b[31mold");
    const initial = readTerminalOutputUpdate(state.output, INITIAL_TERMINAL_OUTPUT_CURSOR);
    writeTerminalOutputUpdate(core, initial);
    const reset = vi.spyOn(core, "resetAndWrite");
    const data = "line\r\n".repeat(8192);
    for (let index = 0; index < 16; index += 1) state = append(state, data);

    const recovery = readTerminalOutputUpdate(state.output, initial.cursor);
    if (recovery.type !== "reset") throw new Error(`Expected reset, received ${recovery.type}`);
    expect(new TextEncoder().encode(recovery.data).byteLength).toBe(
      DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
    );
    writeTerminalOutputUpdate(core, recovery);
    reference.resetAndWrite(recovery.data);
    expect(core.snapshot()).toEqual(reference.snapshot());

    state = append(state, "\r\nlatest");
    const next = readTerminalOutputUpdate(state.output, recovery.cursor);
    expect(next.type).toBe("append");
    writeTerminalOutputUpdate(core, next);
    reference.write("\r\nlatest");
    expect(reset).toHaveBeenCalledTimes(1);
    expect(core.snapshot()).toEqual(reference.snapshot());
  });

  it("replays the latest retained output when WASM arrives after several events", async () => {
    const pendingCore = createCore();
    let state = createSession("before");
    state = append(state, "\r\nduring ");
    state = append(state, "🙂 load");
    const core = await pendingCore;
    const first = readTerminalOutputUpdate(state.output, INITIAL_TERMINAL_OUTPUT_CURSOR);
    writeTerminalOutputUpdate(core, first);
    const reference = await createCore();
    reference.resetAndWrite(terminalOutputText(state.output));
    const reset = vi.spyOn(core, "resetAndWrite");

    state = append(state, "\r\nafter");
    const next = readTerminalOutputUpdate(state.output, first.cursor);
    expect(next).toMatchObject({ type: "append", data: "\r\nafter" });
    writeTerminalOutputUpdate(core, next);
    reference.write("\r\nafter");
    expect(reset).not.toHaveBeenCalled();
    expect(core.snapshot()).toEqual(reference.snapshot());
  });

  it("resets real Ghostty for a repeated snapshot, clear, restart, and a fresh attach", async () => {
    const [core, reference] = await Promise.all([createCore(), createCore()]);
    let state = createSession("hello");
    const initial = readTerminalOutputUpdate(state.output, INITIAL_TERMINAL_OUTPUT_CURSOR);
    writeTerminalOutputUpdate(core, initial);
    let cursor = initial.cursor;

    const snapshot = {
      threadId: "terminal-stream-test",
      terminalId: "term-1",
      cwd: "/repo",
      worktreePath: null,
      status: "running" as const,
      pid: 456,
      history: "hello",
      exitCode: null,
      exitSignal: null,
      label: "Terminal",
      updatedAt: "2026-09-04T00:00:01.000Z",
    };
    const events = [
      { type: "snapshot", snapshot },
      { type: "cleared", threadId: snapshot.threadId, terminalId: snapshot.terminalId },
      { type: "restarted", threadId: snapshot.threadId, terminalId: snapshot.terminalId, snapshot },
    ] as const;
    for (const event of events) {
      core.write("\r\nstale local text");
      state = applyTerminalAttachStreamEvent(state, event);
      const update = readTerminalOutputUpdate(state.output, cursor);
      expect(update.type).toBe("reset");
      writeTerminalOutputUpdate(core, update);
      cursor = update.cursor;
      reference.resetAndWrite(event.type === "cleared" ? "" : "hello");
      expect(core.snapshot()).toEqual(reference.snapshot());
    }

    core.write("\r\nstale local text");
    state = createSession("hello");
    const reattached = readTerminalOutputUpdate(state.output, cursor);
    expect(reattached.type).toBe("reset");
    writeTerminalOutputUpdate(core, reattached);
    reference.resetAndWrite("hello");
    expect(core.snapshot()).toEqual(reference.snapshot());
  });
});

/** Keyboard event stub. Unset modifiers are false and locks are reported off. */
function terminalKey(
  partial: Partial<KeyboardEvent> & Pick<KeyboardEvent, "code" | "key">,
): KeyboardEvent {
  return {
    altKey: false,
    ctrlKey: false,
    isComposing: false,
    metaKey: false,
    repeat: false,
    shiftKey: false,
    getModifierState: () => false,
    ...partial,
  } as KeyboardEvent;
}

/**
 * Put `navigator.platform` back after a test stub.
 *
 * Node exposes `platform` on the prototype, so `getOwnPropertyDescriptor` is
 * empty. Restoring only a saved own descriptor leaves the temporary own
 * property in place and later tests keep the stub.
 */
function restoreNavigatorPlatform(descriptor: PropertyDescriptor | undefined) {
  if (descriptor) {
    Object.defineProperty(navigator, "platform", descriptor);
    return;
  }
  Reflect.deleteProperty(navigator, "platform");
}

/**
 * Run `run` while `navigator.platform` is `platform`, then restore the previous
 * platform. `encodeKey` reads the platform when deciding whether Option
 * produced a character. The previous value is restored when `run` throws.
 */
function withPlatform<T>(platform: string, run: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "platform");
  Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
  try {
    return run();
  } finally {
    restoreNavigatorPlatform(descriptor);
  }
}

describe("GhosttyTerminalCore.encodeKey", () => {
  const cores = new Set<GhosttyTerminalCore>();
  const initialPlatform = navigator.platform;
  const initialPlatformDescriptor = Object.getOwnPropertyDescriptor(navigator, "platform");

  /** Small terminal used to assert the bytes `encodeKey` writes. */
  async function createCore() {
    const core = await GhosttyTerminalCore.create(
      12,
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
    cores.add(core);
    return core;
  }

  afterEach(() => {
    try {
      expect(navigator.platform).toBe(initialPlatform);
      expect(Object.getOwnPropertyDescriptor(navigator, "platform")).toEqual(
        initialPlatformDescriptor,
      );
    } finally {
      restoreNavigatorPlatform(initialPlatformDescriptor);
      for (const core of cores) core.dispose();
      cores.clear();
    }
  });

  it("restores an inherited navigator.platform after Option encoding", () => {
    expect(initialPlatformDescriptor).toBeUndefined();
    expect(() =>
      withPlatform("MacIntel", () => {
        expect(navigator.platform).toBe("MacIntel");
        expect(Object.getOwnPropertyDescriptor(navigator, "platform")?.value).toBe("MacIntel");
        throw new Error("encoder failed");
      }),
    ).toThrow("encoder failed");
    expect(Object.getOwnPropertyDescriptor(navigator, "platform")).toBeUndefined();
    expect(navigator.platform).toBe(initialPlatform);
  });

  it("restores an own navigator.platform descriptor", () => {
    const saved = Object.getOwnPropertyDescriptor(navigator, "platform");
    Object.defineProperty(navigator, "platform", {
      configurable: true,
      enumerable: true,
      value: "TestPlatform",
      writable: true,
    });
    try {
      withPlatform("Linux", () => {
        expect(navigator.platform).toBe("Linux");
      });
      expect(navigator.platform).toBe("TestPlatform");
      expect(Object.getOwnPropertyDescriptor(navigator, "platform")).toMatchObject({
        configurable: true,
        value: "TestPlatform",
        writable: true,
      });
    } finally {
      restoreNavigatorPlatform(saved);
    }
  });

  it("types macOS Option characters through the WASM encoder", async () => {
    const core = await createCore();
    const optionAt = terminalKey({ altKey: true, code: "KeyL", key: "@" });
    withPlatform("MacIntel", () => {
      expect(core.encodeKey(optionAt)).toBe("@");
      expect(core.encodeKey(terminalKey({ altKey: true, code: "KeyE", key: "€" }))).toBe("€");
      expect(core.encodeKey(terminalKey({ altKey: true, code: "Digit7", key: "|" }))).toBe("|");
      expect(
        core.encodeKey(terminalKey({ altKey: true, code: "Digit7", key: "\\", shiftKey: true })),
      ).toBe("\\");
      expect(core.encodeKey(terminalKey({ code: "KeyC", ctrlKey: true, key: "c" }))).toBe("\u0003");
      expect(
        core.encodeKey(terminalKey({ altKey: true, code: "ArrowLeft", key: "ArrowLeft" })),
      ).toBe("\u001b[1;3D");

      core.write("\u001b[>4;2m");
      expect(core.encodeKey(optionAt)).toBe("@");
      expect(
        core.encodeKey(terminalKey({ altKey: true, code: "Digit7", key: "\\", shiftKey: true })),
      ).toBe("\\");
      expect(core.encodeKey(terminalKey({ code: "KeyA", key: "A", shiftKey: true }))).toBe(
        "\u001b[27;2;65~",
      );

      core.write("\u001b[>1u");
      expect(core.encodeKey(optionAt)).toBe("@");
      expect(core.encodeKey(terminalKey({ altKey: true, code: "Digit7", key: "|" }))).toBe("|");
      expect(core.encodeKey(terminalKey({ code: "KeyC", ctrlKey: true, key: "c" }))).toBe(
        "\u001b[99;5u",
      );

      core.write("\u001b[>31u");
      expect(core.encodeKey(optionAt)).toBe("\u001b[64::108;;64u");
    });
  });

  it("keeps Alt as a modifier off macOS", async () => {
    const core = await createCore();
    withPlatform("Linux", () => {
      expect(core.encodeKey(terminalKey({ altKey: true, code: "KeyL", key: "@" }))).toBe("\u001b@");
    });
    withPlatform("Win32", () => {
      expect(core.encodeKey(terminalKey({ altKey: true, code: "Digit7", key: "|" }))).toBe(
        "\u001b|",
      );
    });
  });
});
