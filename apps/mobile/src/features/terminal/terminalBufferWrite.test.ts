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
