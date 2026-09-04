import { describe, expect, it, vi } from "vite-plus/test";

import { EnvironmentId, TerminalSessionSnapshot, ThreadId } from "@t3tools/contracts";

import {
  applyTerminalAttachStreamEvent,
  applyTerminalMetadataStreamEvent,
  combineTerminalSessionState,
  DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
  EMPTY_TERMINAL_BUFFER_STATE,
  INITIAL_TERMINAL_OUTPUT_CURSOR,
  nextTerminalAttachSeedState,
  readTerminalOutputUpdate,
  selectRunningSubprocessTerminalIds,
  terminalOutputText,
} from "./terminalSession.ts";

const TARGET = {
  environmentId: EnvironmentId.make("env-local"),
  threadId: ThreadId.make("thread-1"),
  terminalId: "term-1",
} as const;

const BASE_SNAPSHOT: TerminalSessionSnapshot = {
  threadId: TARGET.threadId,
  terminalId: TARGET.terminalId,
  cwd: "/repo",
  worktreePath: null,
  status: "running",
  pid: 123,
  history: "hello",
  exitCode: null,
  exitSignal: null,
  label: "Terminal 1",
  updatedAt: "2026-04-01T00:00:00.000Z",
};

describe("terminal session reducers", () => {
  it("prefers live attach status over stale metadata after the attach stream starts", () => {
    const summary = applyTerminalMetadataStreamEvent([], {
      type: "snapshot",
      terminals: [
        {
          threadId: BASE_SNAPSHOT.threadId,
          terminalId: BASE_SNAPSHOT.terminalId,
          cwd: BASE_SNAPSHOT.cwd,
          worktreePath: BASE_SNAPSHOT.worktreePath,
          status: "running",
          pid: BASE_SNAPSHOT.pid,
          exitCode: BASE_SNAPSHOT.exitCode,
          exitSignal: BASE_SNAPSHOT.exitSignal,
          updatedAt: BASE_SNAPSHOT.updatedAt,
          hasRunningSubprocess: false,
          label: BASE_SNAPSHOT.label,
        },
      ],
    })[0]!;
    const attached = applyTerminalAttachStreamEvent(EMPTY_TERMINAL_BUFFER_STATE, {
      type: "error",
      threadId: TARGET.threadId,
      terminalId: TARGET.terminalId,
      message: "Terminal disconnected.",
    });

    expect(combineTerminalSessionState(summary, attached)).toMatchObject({
      status: "error",
      error: "Terminal disconnected.",
      version: 1,
    });
  });

  it("uses metadata status before an attach stream has emitted", () => {
    const summary = applyTerminalMetadataStreamEvent([], {
      type: "snapshot",
      terminals: [
        {
          threadId: BASE_SNAPSHOT.threadId,
          terminalId: BASE_SNAPSHOT.terminalId,
          cwd: BASE_SNAPSHOT.cwd,
          worktreePath: BASE_SNAPSHOT.worktreePath,
          status: "running",
          pid: BASE_SNAPSHOT.pid,
          exitCode: BASE_SNAPSHOT.exitCode,
          exitSignal: BASE_SNAPSHOT.exitSignal,
          updatedAt: BASE_SNAPSHOT.updatedAt,
          hasRunningSubprocess: false,
          label: BASE_SNAPSHOT.label,
        },
      ],
    })[0]!;

    expect(combineTerminalSessionState(summary, EMPTY_TERMINAL_BUFFER_STATE).status).toBe(
      "running",
    );
  });

  it("does not treat an idle running shell as a running subprocess", () => {
    const idleSession = {
      target: TARGET,
      state: {
        ...combineTerminalSessionState(null, EMPTY_TERMINAL_BUFFER_STATE),
        status: "running" as const,
        hasRunningSubprocess: false,
      },
    };
    const activeSession = {
      target: { ...TARGET, terminalId: "term-2" },
      state: {
        ...idleSession.state,
        hasRunningSubprocess: true,
      },
    };

    expect(selectRunningSubprocessTerminalIds([idleSession, activeSession])).toEqual(["term-2"]);
  });

  it("reduces attach snapshots and output without an imperative session manager", () => {
    const snapshot = applyTerminalAttachStreamEvent(EMPTY_TERMINAL_BUFFER_STATE, {
      type: "snapshot",
      snapshot: BASE_SNAPSHOT,
    });
    const output = applyTerminalAttachStreamEvent(
      snapshot,
      {
        type: "output",
        threadId: TARGET.threadId,
        terminalId: TARGET.terminalId,
        data: " world",
      },
      8,
    );

    expect(output).toMatchObject({
      status: "running",
      error: null,
      version: 2,
    });
    expect(terminalOutputText(output.output)).toBe("lo world");
  });

  it("does not advance the lifecycle for the initial attach snapshot", () => {
    const snapshot = applyTerminalAttachStreamEvent(EMPTY_TERMINAL_BUFFER_STATE, {
      type: "snapshot",
      snapshot: BASE_SNAPSHOT,
    });

    expect(snapshot).toMatchObject({ status: "running", lifecycleVersion: 0 });
  });

  it("advances the lifecycle for a live started snapshot", () => {
    const initial = applyTerminalAttachStreamEvent(EMPTY_TERMINAL_BUFFER_STATE, {
      type: "snapshot",
      snapshot: BASE_SNAPSHOT,
    });
    const started = applyTerminalAttachStreamEvent(initial, {
      type: "snapshot",
      snapshot: { ...BASE_SNAPSHOT, pid: 456 },
    });

    expect(started).toMatchObject({ status: "running", lifecycleVersion: 1 });
  });

  it("advances the lifecycle when a running terminal restarts in place", () => {
    const snapshot = applyTerminalAttachStreamEvent(EMPTY_TERMINAL_BUFFER_STATE, {
      type: "snapshot",
      snapshot: BASE_SNAPSHOT,
    });
    const restarted = applyTerminalAttachStreamEvent(snapshot, {
      type: "restarted",
      threadId: TARGET.threadId,
      terminalId: TARGET.terminalId,
      snapshot: { ...BASE_SNAPSHOT, pid: 456 },
    });

    expect(snapshot).toMatchObject({ status: "running", lifecycleVersion: 0 });
    expect(restarted).toMatchObject({ status: "running", lifecycleVersion: 1 });
  });

  it("reduces terminal metadata snapshots, upserts, and removals", () => {
    const initial = applyTerminalMetadataStreamEvent([], {
      type: "snapshot",
      terminals: [
        {
          threadId: BASE_SNAPSHOT.threadId,
          terminalId: BASE_SNAPSHOT.terminalId,
          cwd: BASE_SNAPSHOT.cwd,
          worktreePath: BASE_SNAPSHOT.worktreePath,
          status: BASE_SNAPSHOT.status,
          pid: BASE_SNAPSHOT.pid,
          exitCode: BASE_SNAPSHOT.exitCode,
          exitSignal: BASE_SNAPSHOT.exitSignal,
          updatedAt: BASE_SNAPSHOT.updatedAt,
          hasRunningSubprocess: false,
          label: BASE_SNAPSHOT.label,
        },
      ],
    });
    const updated = applyTerminalMetadataStreamEvent(initial, {
      type: "upsert",
      terminal: {
        ...initial[0]!,
        hasRunningSubprocess: true,
      },
    });
    const removed = applyTerminalMetadataStreamEvent(updated, {
      type: "remove",
      threadId: TARGET.threadId,
      terminalId: TARGET.terminalId,
    });

    expect(updated).toHaveLength(1);
    expect(updated[0]?.hasRunningSubprocess).toBe(true);
    expect(removed).toEqual([]);
  });

  it("caps retained output by UTF-8 byte length", () => {
    const state = applyTerminalAttachStreamEvent(
      EMPTY_TERMINAL_BUFFER_STATE,
      {
        type: "output",
        threadId: TARGET.threadId,
        terminalId: TARGET.terminalId,
        data: "🙂🙂",
      },
      4,
    );

    expect(terminalOutputText(state.output)).toBe("🙂");
  });

  it("preserves a BOM code point at a new output chunk boundary", () => {
    const initial = applyTerminalAttachStreamEvent(EMPTY_TERMINAL_BUFFER_STATE, {
      type: "snapshot",
      snapshot: { ...BASE_SNAPSHOT, history: "" },
    });
    const cursor = readTerminalOutputUpdate(initial.output, INITIAL_TERMINAL_OUTPUT_CURSOR).cursor;
    const data = `${"x".repeat(16_384)}\uFEFF${"y".repeat(20)}`;
    const state = applyTerminalAttachStreamEvent(initial, {
      type: "output",
      threadId: TARGET.threadId,
      terminalId: TARGET.terminalId,
      data,
    });

    expect(terminalOutputText(state.output)).toBe(data);
    expect(readTerminalOutputUpdate(state.output, cursor)).toMatchObject({ type: "append", data });
    expect(state.output.retainedBytes).toBe(new TextEncoder().encode(data).byteLength);
  });

  it("preserves a leading BOM in the retained snapshot tail", () => {
    const state = applyTerminalAttachStreamEvent(
      EMPTY_TERMINAL_BUFFER_STATE,
      { type: "snapshot", snapshot: { ...BASE_SNAPSHOT, history: "discard\uFEFFtail" } },
      7,
    );

    expect(terminalOutputText(state.output)).toBe("\uFEFFtail");
    expect(state.output.retainedBytes).toBe(7);
  });

  it("trims whole Unicode code points from a partially retained chunk", () => {
    let state = applyTerminalAttachStreamEvent(
      EMPTY_TERMINAL_BUFFER_STATE,
      { type: "snapshot", snapshot: { ...BASE_SNAPSHOT, history: "é界🙂end" } },
      12,
    );
    let cursor = readTerminalOutputUpdate(state.output, INITIAL_TERMINAL_OUTPUT_CURSOR).cursor;
    for (const [data, expected, retainedBytes] of [
      ["x", "界🙂endx", 11],
      ["yz", "🙂endxyz", 10],
      ["abc", "endxyzabc", 9],
    ] as const) {
      state = applyTerminalAttachStreamEvent(
        state,
        { type: "output", threadId: TARGET.threadId, terminalId: TARGET.terminalId, data },
        12,
      );
      const update = readTerminalOutputUpdate(state.output, cursor);
      expect(update).toMatchObject({ type: "append", data });
      expect(terminalOutputText(state.output)).toBe(expected);
      expect(state.output.retainedBytes).toBe(retainedBytes);
      cursor = update.cursor;
    }
  });

  it("delivers all output when several events arrive before a renderer reads", () => {
    const initial = applyTerminalAttachStreamEvent(EMPTY_TERMINAL_BUFFER_STATE, {
      type: "snapshot",
      snapshot: BASE_SNAPSHOT,
    });
    const cursor = readTerminalOutputUpdate(initial.output, INITIAL_TERMINAL_OUTPUT_CURSOR).cursor;
    let state = initial;
    for (const data of [" one", " two", " three"]) {
      state = applyTerminalAttachStreamEvent(state, {
        type: "output",
        threadId: TARGET.threadId,
        terminalId: TARGET.terminalId,
        data,
      });
    }
    const update = readTerminalOutputUpdate(state.output, cursor);
    expect(update).toMatchObject({ type: "append", data: " one two three" });
    expect(readTerminalOutputUpdate(state.output, update.cursor).type).toBe("none");
  });

  it("preserves the byte-limited tail and resets a cursor before a partially trimmed chunk", () => {
    const initial = applyTerminalAttachStreamEvent(EMPTY_TERMINAL_BUFFER_STATE, {
      type: "snapshot",
      snapshot: { ...BASE_SNAPSHOT, history: "" },
    });
    const staleCursor = readTerminalOutputUpdate(
      initial.output,
      INITIAL_TERMINAL_OUTPUT_CURSOR,
    ).cursor;
    const first = applyTerminalAttachStreamEvent(initial, {
      type: "output",
      threadId: TARGET.threadId,
      terminalId: TARGET.terminalId,
      data: "hello",
    });
    const caughtUpCursor = readTerminalOutputUpdate(first.output, staleCursor).cursor;
    const state = applyTerminalAttachStreamEvent(
      first,
      { type: "output", threadId: TARGET.threadId, terminalId: TARGET.terminalId, data: " world" },
      8,
    );

    expect(readTerminalOutputUpdate(state.output, caughtUpCursor)).toMatchObject({
      type: "append",
      data: " world",
    });
    expect(readTerminalOutputUpdate(state.output, staleCursor)).toMatchObject({
      type: "reset",
      data: "lo world",
    });
    expect(state.output.retainedBytes).toBe(8);
  });

  it("does not encode retained history again when appending at the byte limit", () => {
    let state = applyTerminalAttachStreamEvent(EMPTY_TERMINAL_BUFFER_STATE, {
      type: "snapshot",
      snapshot: { ...BASE_SNAPSHOT, history: "x".repeat(DEFAULT_MAX_TERMINAL_BUFFER_BYTES) },
    });
    const data = "y".repeat(8192);
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    try {
      for (let index = 0; index < 100; index += 1) {
        state = applyTerminalAttachStreamEvent(state, {
          type: "output",
          threadId: TARGET.threadId,
          terminalId: TARGET.terminalId,
          data,
        });
      }
      expect(encode.mock.calls.reduce((total, [text]) => total + (text?.length ?? 0), 0)).toBe(
        data.length * 100,
      );
      expect(state.output.retainedBytes).toBe(DEFAULT_MAX_TERMINAL_BUFFER_BYTES);
    } finally {
      encode.mockRestore();
    }
  });

  it.each([0, -1])("discards output without encoding when the byte budget is %s", (maxBytes) => {
    const initial = applyTerminalAttachStreamEvent(EMPTY_TERMINAL_BUFFER_STATE, {
      type: "snapshot",
      snapshot: BASE_SNAPSHOT,
    });
    const cursor = readTerminalOutputUpdate(initial.output, INITIAL_TERMINAL_OUTPUT_CURSOR).cursor;
    const data = "x".repeat(65_536);
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    try {
      const discarded = applyTerminalAttachStreamEvent(
        initial,
        { type: "output", threadId: TARGET.threadId, terminalId: TARGET.terminalId, data },
        maxBytes,
      );
      expect(encode).not.toHaveBeenCalled();
      expect(discarded.output.nextOffset).toBe(initial.output.nextOffset + data.length);
      expect(discarded.output.retainedBytes).toBe(0);
      expect(readTerminalOutputUpdate(discarded.output, cursor)).toMatchObject({
        type: "reset",
        data: "",
      });

      const empty = applyTerminalAttachStreamEvent(
        initial,
        { type: "output", threadId: TARGET.threadId, terminalId: TARGET.terminalId, data: "" },
        maxBytes,
      );
      expect(empty.output).toBe(initial.output);
      expect(encode).not.toHaveBeenCalled();
    } finally {
      encode.mockRestore();
    }
  });

  it("resets for repeated snapshots, clear, and restart even when output text repeats", () => {
    let state = applyTerminalAttachStreamEvent(EMPTY_TERMINAL_BUFFER_STATE, {
      type: "snapshot",
      snapshot: BASE_SNAPSHOT,
    });
    let cursor = readTerminalOutputUpdate(state.output, INITIAL_TERMINAL_OUTPUT_CURSOR).cursor;
    state = applyTerminalAttachStreamEvent(state, { type: "snapshot", snapshot: BASE_SNAPSHOT });
    const repeated = readTerminalOutputUpdate(state.output, cursor);
    expect(repeated).toMatchObject({ type: "reset", data: "hello" });
    expect(state.version).toBe(2);
    cursor = repeated.cursor;

    state = applyTerminalAttachStreamEvent(state, {
      type: "cleared",
      threadId: TARGET.threadId,
      terminalId: TARGET.terminalId,
    });
    const cleared = readTerminalOutputUpdate(state.output, cursor);
    expect(cleared).toMatchObject({ type: "reset", data: "" });
    state = applyTerminalAttachStreamEvent(state, {
      type: "restarted",
      threadId: TARGET.threadId,
      terminalId: TARGET.terminalId,
      snapshot: BASE_SNAPSHOT,
    });
    expect(readTerminalOutputUpdate(state.output, cleared.cursor)).toMatchObject({
      type: "reset",
      data: "hello",
    });
    expect(state.lifecycleVersion).toBe(2);
  });

  it("does not reuse a renderer cursor when a fresh attach has matching counters", () => {
    const first = applyTerminalAttachStreamEvent(nextTerminalAttachSeedState(), {
      type: "snapshot",
      snapshot: BASE_SNAPSHOT,
    });
    const cursor = readTerminalOutputUpdate(first.output, INITIAL_TERMINAL_OUTPUT_CURSOR).cursor;
    const next = applyTerminalAttachStreamEvent(nextTerminalAttachSeedState(), {
      type: "snapshot",
      snapshot: { ...BASE_SNAPSHOT, history: "other" },
    });
    expect(next.output.resetVersion).toBe(first.output.resetVersion);
    expect(next.output.nextOffset).toBe(first.output.nextOffset);
    expect(readTerminalOutputUpdate(next.output, cursor)).toMatchObject({
      type: "reset",
      data: "other",
    });
    expect(next.lifecycleVersion).toBe(0);
  });

  it("keeps appending while compacting metadata for many small writes", () => {
    let state = applyTerminalAttachStreamEvent(EMPTY_TERMINAL_BUFFER_STATE, {
      type: "snapshot",
      snapshot: { ...BASE_SNAPSHOT, history: "" },
    });
    let cursor = readTerminalOutputUpdate(state.output, INITIAL_TERMINAL_OUTPUT_CURSOR).cursor;
    let received = "";
    for (let index = 0; index < 2500; index += 1) {
      state = applyTerminalAttachStreamEvent(state, {
        type: "output",
        threadId: TARGET.threadId,
        terminalId: TARGET.terminalId,
        data: "x",
      });
      const update = readTerminalOutputUpdate(state.output, cursor);
      if (update.type !== "append") throw new Error(`Expected append, received ${update.type}`);
      received += update.data;
      cursor = update.cursor;
    }
    expect(received).toBe("x".repeat(2500));
    expect(state.output.chunks.length).toBeLessThan(1024);
    expect(terminalOutputText(state.output)).toBe(received);
  });

  it("appends every unread character across a compaction boundary", () => {
    let state = applyTerminalAttachStreamEvent(EMPTY_TERMINAL_BUFFER_STATE, {
      type: "snapshot",
      snapshot: { ...BASE_SNAPSHOT, history: "" },
    });
    let cursor = readTerminalOutputUpdate(state.output, INITIAL_TERMINAL_OUTPUT_CURSOR).cursor;
    const writes = Array.from({ length: 1200 }, (_, index) => ["x", "é", "界", "🙂"][index % 4]!);
    for (const [index, data] of writes.entries()) {
      state = applyTerminalAttachStreamEvent(state, {
        type: "output",
        threadId: TARGET.threadId,
        terminalId: TARGET.terminalId,
        data,
      });
      if (index === 99) cursor = readTerminalOutputUpdate(state.output, cursor).cursor;
    }
    expect(readTerminalOutputUpdate(state.output, cursor)).toMatchObject({
      type: "append",
      data: writes.slice(100).join(""),
    });
  });
});
