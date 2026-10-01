import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { GhosttyTerminalCore } from "@t3tools/ghostty-terminal/core";
import {
  applyTerminalAttachStreamEvent,
  DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
  INITIAL_TERMINAL_OUTPUT_CURSOR,
  nextTerminalAttachSeedState,
  readTerminalOutputUpdate,
  terminalOutputText,
  type TerminalBufferState,
} from "@t3tools/client-runtime/state/terminal";

import { writeTerminalOutputUpdate } from "../components/ThreadTerminalDrawer";
import { loadWebGhosttyRuntime } from "./ghosttyAssets";

// Node has no dev server to fetch from; serve the same bytes as data URLs.
vi.mock("@t3tools/ghostty-terminal/assets/ghostty-vt.wasm?url", async () => ({
  default: (await import("@t3tools/ghostty-terminal/assets/ghostty-vt.wasm?inline")).default,
}));
vi.mock("@t3tools/ghostty-terminal/assets/ghostty-write-pty.wasm?url&no-inline", async () => ({
  default: (await import("@t3tools/ghostty-terminal/assets/ghostty-write-pty.wasm?inline")).default,
}));

describe("GhosttyTerminalCore snapshots", () => {
  const cores = new Set<GhosttyTerminalCore>();

  async function createCore(onData: (data: string) => void = () => {}) {
    const core = await GhosttyTerminalCore.create(
      await loadWebGhosttyRuntime(),
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
