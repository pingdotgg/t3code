import {
  applyTerminalAttachStreamEvent,
  EMPTY_TERMINAL_BUFFER_STATE,
  INITIAL_TERMINAL_OUTPUT_CURSOR,
  readTerminalOutputUpdate,
  terminalOutputText,
} from "@t3tools/client-runtime/state/terminal";
import type { TerminalAttachStreamEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  IDLE_TERMINAL_BUFFER_WRITE,
  mergeTerminalBufferWrite,
  type TerminalBufferWrite,
} from "./terminalBufferWrite";

const committed = (write: TerminalBufferWrite) => write.seq;
const uncommitted = (write: TerminalBufferWrite) => write.seq - 1;

describe("mergeTerminalBufferWrite", () => {
  it("starts a new write once the native view has taken the previous one", () => {
    const first = mergeTerminalBufferWrite({
      pending: IDLE_TERMINAL_BUFFER_WRITE,
      committedSeq: committed(IDLE_TERMINAL_BUFFER_WRITE),
      update: { type: "append", data: "hello" },
    });

    expect(first).toEqual({ seq: 1, reset: false, data: "hello" });

    const second = mergeTerminalBufferWrite({
      pending: first,
      committedSeq: committed(first),
      update: { type: "append", data: " world" },
    });

    expect(second).toEqual({ seq: 2, reset: false, data: " world" });
  });

  it("concatenates appends that batch into a single native prop update", () => {
    const pending: TerminalBufferWrite = { seq: 4, reset: false, data: "a" };

    expect(
      mergeTerminalBufferWrite({
        pending,
        committedSeq: uncommitted(pending),
        update: { type: "append", data: "b" },
      }),
    ).toEqual({ seq: 4, reset: false, data: "ab" });
  });

  it("keeps the reset flag when an append batches on top of an uncommitted reset", () => {
    const pending: TerminalBufferWrite = { seq: 7, reset: true, data: "history" };

    expect(
      mergeTerminalBufferWrite({
        pending,
        committedSeq: uncommitted(pending),
        update: { type: "append", data: "-tail" },
      }),
    ).toEqual({ seq: 7, reset: true, data: "history-tail" });
  });

  it("drops uncommitted output that a reset supersedes", () => {
    const pending: TerminalBufferWrite = { seq: 9, reset: false, data: "stale" };

    expect(
      mergeTerminalBufferWrite({
        pending,
        committedSeq: uncommitted(pending),
        update: { type: "reset", data: "fresh" },
      }),
    ).toEqual({ seq: 9, reset: true, data: "fresh" });
  });

  it("advances the sequence for a reset that follows a committed write", () => {
    const pending: TerminalBufferWrite = { seq: 2, reset: false, data: "old" };

    expect(
      mergeTerminalBufferWrite({
        pending,
        committedSeq: committed(pending),
        update: { type: "reset", data: "snapshot" },
      }),
    ).toEqual({ seq: 3, reset: true, data: "snapshot" });
  });
});

/**
 * Feed an attach stream through the cursor and merge steps the surface uses,
 * then fold the resulting writes the way the native view does.
 *
 * 让 attach 事件流经过 surface 使用的游标与合并步骤，再按原生视图的方式
 * 折叠得到的写入序列。
 */
function replayThroughWrites(
  events: ReadonlyArray<TerminalAttachStreamEvent>,
  input: { readonly commitEvery: number } = { commitEvery: 1 },
) {
  let buffer = EMPTY_TERMINAL_BUFFER_STATE;
  let cursor = INITIAL_TERMINAL_OUTPUT_CURSOR;
  let pending = IDLE_TERMINAL_BUFFER_WRITE;
  let committedSeq = IDLE_TERMINAL_BUFFER_WRITE.seq;
  let replayed = "";
  let appliedSeq = 0;

  const flush = () => {
    if (pending.seq <= appliedSeq) return;
    appliedSeq = pending.seq;
    replayed = pending.reset ? pending.data : replayed + pending.data;
    committedSeq = pending.seq;
  };

  events.forEach((event, index) => {
    buffer = applyTerminalAttachStreamEvent(buffer, event);
    const update = readTerminalOutputUpdate(buffer.output, cursor);
    cursor = update.cursor;
    if (update.type !== "none") {
      pending = mergeTerminalBufferWrite({ pending, committedSeq, update });
    }
    // Model React commits: several output events can collapse into one prop update.
    //
    // 模拟 React 的 commit：多个输出事件可能合并成一次 prop 更新。
    if ((index + 1) % input.commitEvery === 0) flush();
  });
  flush();

  return { replayed, retained: terminalOutputText(buffer.output) };
}

const TERMINAL_TARGET = { threadId: "thread-1", terminalId: "default" } as const;

const outputEvent = (data: string): TerminalAttachStreamEvent => ({
  ...TERMINAL_TARGET,
  type: "output",
  data,
});

describe("terminal write stream", () => {
  it("reconstructs retained output across a rolling retention window", () => {
    // Unique lines: a window sliding over identical text would hide reordering.
    //
    // 每行内容唯一：滑动窗口在重复文本上滑动会掩盖顺序错误。
    const events = Array.from({ length: 9000 }, (_, index) =>
      outputEvent(`[${index}] compiling module_${index}.rs ................... ok (1.2s)\n`),
    );

    const { replayed, retained } = replayThroughWrites(events);

    expect(retained.length).toBeGreaterThan(500_000);
    expect(replayed.endsWith(retained)).toBe(true);
  });

  it("keeps batched output whole when commits collapse several events", () => {
    const events = Array.from({ length: 9000 }, (_, index) =>
      outputEvent(`[${index}] compiling module_${index}.rs ................... ok (1.2s)\n`),
    );

    const { replayed, retained } = replayThroughWrites(events, { commitEvery: 7 });

    expect(replayed.endsWith(retained)).toBe(true);
  });

  it("drops superseded history when the session restarts", () => {
    const { replayed, retained } = replayThroughWrites([
      outputEvent("before-restart\n"),
      {
        ...TERMINAL_TARGET,
        type: "restarted",
        snapshot: {
          ...TERMINAL_TARGET,
          status: "running",
          history: "after-restart\n",
          updatedAt: new Date().toISOString(),
          cwd: "/tmp",
          worktreePath: null,
        },
      } as TerminalAttachStreamEvent,
      outputEvent("tail\n"),
    ]);

    expect(replayed).toBe("after-restart\ntail\n");
    expect(replayed.endsWith(retained)).toBe(true);
  });
});
