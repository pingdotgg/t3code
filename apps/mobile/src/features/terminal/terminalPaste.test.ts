import { describe, expect, it } from "vite-plus/test";

import { TERMINAL_WRITE_MAX_LENGTH } from "./terminalInput";
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

  it("never overlaps writes from rapid paste requests", async () => {
    const session = createTerminalPasteSession();
    session.reset(true);

    const firstWrite = deferred<boolean>();
    const firstWriteStarted = deferred<void>();
    const writes: string[] = [];
    let activeWrites = 0;
    let maximumActiveWrites = 0;
    const write = async (data: string) => {
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

    expect(writes.map((chunk) => chunk.length)).toEqual([TERMINAL_WRITE_MAX_LENGTH, 5]);
    expect(writes[1]).toBe("newer");
    expect(maximumActiveWrites).toBe(1);
  });
});
