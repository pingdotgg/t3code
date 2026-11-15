import { TerminalWriteInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

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

  it.each([
    { length: 1000, bracketed: false, writes: 1 },
    { length: 65_536, bracketed: false, writes: 1 },
    { length: 100_000, bracketed: false, writes: 2 },
    { length: 65_524, bracketed: true, writes: 1 },
    { length: 65_525, bracketed: true, writes: 2 },
    { length: 100_000, bracketed: true, writes: 2 },
  ])(
    "delivers a $length-unit paste (bracketed: $bracketed) as writes the server accepts",
    async ({ length, bracketed, writes }) => {
      const data = bracketed ? `\x1b[200~${paste(length)}\x1b[201~` : paste(length);
      const sent: string[] = [];
      await createTerminalInputWriter()(data, async (chunk) => {
        sent.push(chunk);
        return true;
      });

      expect(sent).toHaveLength(writes);
      expect(sent.every(fitsWrite)).toBe(true);
      expect(sent.join("")).toBe(data);
    },
  );

  it("sends one chunk per round trip and holds later input behind a split write", async () => {
    const write = createTerminalInputWriter();
    const { sent, chunks, sends, send } = heldSend();
    const large = `\x1b[200~${"p".repeat(70_000)}\x1b[201~`;
    const [first, second] = [large.slice(0, 65_536), large.slice(65_536)];

    void write("a", send);
    const pasted = write(large, send);
    void write("b", send);
    void write("c", send);
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

  it("sends input that fits without waiting on earlier input", () => {
    const write = createTerminalInputWriter();
    const { chunks, send } = heldSend();

    void write("a", send);
    void write("b", send);

    expect(chunks()).toEqual(["a", "b"]);
  });
});
