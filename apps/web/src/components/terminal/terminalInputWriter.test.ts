import { TerminalWriteInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";

import { createTerminalInputWriter } from "./terminalInputWriter";

const isWriteInput = Schema.is(TerminalWriteInput);
const fitsWrite = (data: string) => isWriteInput({ threadId: "t", terminalId: "default", data });

/** A `send` whose calls stay pending until the test settles them. */
function heldSend() {
  const sent: Array<{ readonly chunk: string; readonly settle: (ok: boolean) => void }> = [];
  const waiters: Array<{ readonly count: number; readonly resolve: () => void }> = [];
  return {
    sent,
    chunks: () => sent.map(({ chunk }) => chunk),
    /** Resolves once `count` chunks have been sent. */
    sends: (count: number) =>
      new Promise<void>((resolve) => {
        if (sent.length >= count) resolve();
        else waiters.push({ count, resolve });
      }),
    send: (chunk: string) =>
      new Promise<boolean>((settle) => {
        sent.push({ chunk, settle });
        for (const waiter of waiters) if (sent.length >= waiter.count) waiter.resolve();
      }),
  };
}

describe("createTerminalInputWriter", () => {
  const line = '  {"file":"src/日本語.ts","message":"Review 🧑🏽‍💻 café changes"},\n';
  const paste = (length: number) =>
    line.repeat(Math.ceil(length / line.length)).slice(0, length - 1) + "\n";

  it("delivers a bracketed paste over the limit as writes the server accepts", async () => {
    const data = `\x1b[200~${paste(100_000)}\x1b[201~`;
    const sent: string[] = [];
    await createTerminalInputWriter()(data, async (chunk) => {
      sent.push(chunk);
      return true;
    });

    expect(sent).toHaveLength(2);
    expect(sent.every(fitsWrite)).toBe(true);
    expect(sent.join("")).toBe(data);
  });

  it("sends one chunk per round trip and holds later input behind a split write", async () => {
    const write = createTerminalInputWriter();
    const { sent, chunks, sends, send } = heldSend();
    const large = `\x1b[200~${"p".repeat(70_000)}\x1b[201~`;
    const [first, second] = [large.slice(0, 65_536), large.slice(65_536)];

    void write("a", send);
    const pasted = write(large, send);
    void write("b", send);
    void write("c", send);
    expect(chunks()).toEqual(["a"]);
    sent[0]!.settle(true);
    await sends(2);
    expect(chunks()).toEqual(["a", first]);

    sent[1]!.settle(true);
    await sends(3);
    expect(chunks()).toEqual(["a", first, second]);
    sent[2]!.settle(true);
    await pasted;
    await sends(4);
    expect(chunks()).toEqual(["a", first, second, "b"]);
    sent[3]!.settle(true);
    await sends(5);
    expect(chunks()).toEqual(["a", first, second, "b", "c"]);
  });

  it("dispatches small writes without waiting for acknowledgements and queues a paste behind them", async () => {
    const write = createTerminalInputWriter();
    const { sent, chunks, sends, send } = heldSend();
    const inputs = Array.from({ length: 32 }, (_, index) => `key-${index}`);
    const smallWrites = inputs.map((data) => write(data, send));
    expect(chunks()).toEqual(inputs);

    const large = "p".repeat(70_000);
    const pasted = write(large, send);
    const after = write("after", send);
    // Finishing newer sends first must not let queued input overtake the oldest write.
    for (let index = inputs.length - 1; index > 0; index--) sent[index]!.settle(true);
    await Promise.all(smallWrites.slice(1));
    expect(sent).toHaveLength(32);
    sent[0]!.settle(true);
    await sends(33);
    expect(sent[32]!.chunk).toBe(large.slice(0, 65_536));
    sent[32]!.settle(true);
    await sends(34);
    expect(sent[33]!.chunk).toBe(large.slice(65_536));
    sent[33]!.settle(true);
    await pasted;
    await sends(35);
    expect(sent[34]!.chunk).toBe("after");
    sent[34]!.settle(true);
    await after;
  });

  it("closes an interrupted bracketed paste before later input", async () => {
    const write = createTerminalInputWriter();
    const { sent, chunks, sends, send } = heldSend();
    const large = `\x1b[200~${"p".repeat(140_000)}\x1b[201~`;
    const pasted = write(large, send);
    const after = write("after", send);
    sent[0]!.settle(true);
    await sends(2);
    sent[1]!.settle(false);
    await sends(3);
    expect(chunks()).toEqual([large.slice(0, 65_536), large.slice(65_536, 131_072), "\x1b[201~"]);
    sent[2]!.settle(false);
    await pasted;
    await sends(4);
    expect(sent[3]!.chunk).toBe("\x1b[201~");
    sent[3]!.settle(true);
    await sends(5);
    expect(sent[4]!.chunk).toBe("after");
    sent[4]!.settle(true);
    await after;
  });

  it("closes an opening chunk whose acknowledgement was lost without retrying payload", async () => {
    const sent: string[] = [];
    const write = createTerminalInputWriter();
    const send = async (chunk: string) => {
      sent.push(chunk);
      return chunk === "\x1b[201~" || chunk === "after";
    };
    const large = `\x1b[200~${"p".repeat(70_000)}\x1b[201~`;
    await write(large, send);
    await write("after", send);
    expect(sent).toEqual([large.slice(0, 65_536), "\x1b[201~", "after"]);
  });

  it("reports each input blocked by failed framing recovery without retrying payload", async () => {
    const sent: string[] = [];
    const interrupted = vi.fn();
    const write = createTerminalInputWriter();
    const send = async (chunk: string) => {
      sent.push(chunk);
      return false;
    };
    const recover = async () => {
      sent.push("\x1b[201~");
      return false;
    };
    const large = `\x1b[200~${"p".repeat(70_000)}\x1b[201~`;
    await write(large, send, recover, interrupted);
    await write("after", send, recover, interrupted);
    expect(sent).toEqual([large.slice(0, 65_536), "\x1b[201~", "\x1b[201~"]);
    expect(interrupted).toHaveBeenCalledTimes(2);
  });

  it("drops the rest of a split write after a failed chunk and keeps later input", async () => {
    const write = createTerminalInputWriter();
    const { sent, chunks, sends, send } = heldSend();

    const pasted = write("q".repeat(140_000), send);
    void write("next", send);
    sent[0]!.settle(false);
    await pasted;
    await sends(2);

    expect(chunks()).toEqual(["q".repeat(65_536), "next"]);
  });
});
