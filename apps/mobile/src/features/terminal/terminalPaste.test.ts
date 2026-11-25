import { describe, expect, it } from "vite-plus/test";

import { TERMINAL_WRITE_MAX_LENGTH, type TerminalWriteInput } from "@t3tools/contracts";
import { createTerminalPasteSession } from "./terminalPaste";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("terminal paste session", () => {
  it("drops a clipboard read when the pty restarts in place", async () => {
    const session = createTerminalPasteSession();
    session.reset(true);
    const clipboardRead = deferred<string>();
    const writes: string[] = [];

    const paste = session.paste({
      readText: () => clipboardRead.promise,
      write: async (data) => {
        writes.push(data);
        return true;
      },
      onReadError: () => undefined,
    });

    session.reset(true);
    clipboardRead.resolve("stale");
    await paste;

    expect(writes).toEqual([]);
  });

  it("reports a liveness change after capture, including a restart in place", () => {
    const session = createTerminalPasteSession();
    session.reset(true);
    const isSameShell = session.liveness();
    expect(isSameShell()).toBe(true);
    session.reset(true);
    expect(isSameShell()).toBe(false);
  });

  it("never overlaps writes from rapid paste requests", async () => {
    const session = createTerminalPasteSession();
    session.reset(true);

    const firstWrite = deferred<boolean>();
    const firstWriteStarted = deferred<void>();
    const writes: string[] = [];
    const phases: Array<TerminalWriteInput["plainWrite"]> = [];
    let activeWrites = 0;
    let maximumActiveWrites = 0;
    const write = async (data: string, phase?: TerminalWriteInput["plainWrite"]) => {
      phases.push(phase);
      writes.push(data);
      activeWrites += 1;
      maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
      if (writes.length === 1) {
        firstWriteStarted.resolve();
        await firstWrite.promise;
      }
      activeWrites -= 1;
      return true;
    };

    const olderPaste = session.paste({
      readText: async () => "a".repeat(TERMINAL_WRITE_MAX_LENGTH + 1),
      write,
      onReadError: () => undefined,
    });
    await firstWriteStarted.promise;

    const newerPaste = session.paste({
      readText: async () => "newer",
      write,
      onReadError: () => undefined,
    });
    await Promise.resolve();

    expect(writes.map((chunk) => chunk.length)).toEqual([TERMINAL_WRITE_MAX_LENGTH]);
    expect(maximumActiveWrites).toBe(1);

    firstWrite.resolve(true);
    await Promise.all([olderPaste, newerPaste]);

    expect(writes.map((chunk) => chunk.length)).toEqual([TERMINAL_WRITE_MAX_LENGTH, 0, 5]);
    expect(writes[2]).toBe("newer");
    expect(phases).toEqual(["start", "abort", undefined]);
    expect(maximumActiveWrites).toBe(1);
  });
  it("keeps a keystroke behind a queued split write", async () => {
    const session = createTerminalPasteSession();
    session.reset(true);
    const firstChunk = deferred<boolean>();
    const started = deferred<void>();
    const writes: string[] = [];
    const send = async (data: string) => {
      writes.push(data);
      if (writes.length === 1) {
        started.resolve();
        return firstChunk.promise;
      }
      return true;
    };
    const a = "a".repeat(TERMINAL_WRITE_MAX_LENGTH);
    const b = "b".repeat(TERMINAL_WRITE_MAX_LENGTH);
    const first = session.write(a + "1", send);
    await started.promise;
    const second = session.write(b + "2", send);
    const key = session.write("k", send);
    expect(writes).toEqual([a]);

    firstChunk.resolve(true);
    await Promise.all([first, second, key]);
    expect(writes).toEqual([a, "1", b, "2", "k"]);
  });

  it("sends a keystroke typed before the first attach snapshot", async () => {
    const session = createTerminalPasteSession();
    const writes: string[] = [];
    await session.write("k", async (data) => {
      writes.push(data);
      return true;
    });
    expect(writes).toEqual(["k"]);
  });
});
