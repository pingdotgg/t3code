import { describe, expect, it } from "@effect/vitest";

import { makeLineDecoder, makeReadBudget } from "./pluginIpcFraming.ts";

const line = (bytes: number) => Buffer.from(`${"x".repeat(bytes - 1)}\n`);

describe("plugin IPC read budget", () => {
  it("stops reading a flood until the reader catches up", () => {
    let paused = false;
    let pauses = 0;
    const budget = makeReadBudget({
      maxBytes: 1000,
      pause: () => {
        paused = true;
        pauses++;
      },
      resume: () => (paused = false),
    });
    const unhandled: Array<number> = [];
    let held = 0;
    let peak = 0;
    const decode = makeLineDecoder({
      maxBytes: 1000,
      onLine: (_line, bytes) => {
        budget.hold(bytes);
        unhandled.push(bytes);
        held += bytes;
        peak = Math.max(peak, held);
      },
      onOverflow: () => expect.unreachable(),
    });
    const handleOne = () => {
      const bytes = unhandled.shift() ?? 0;
      held -= bytes;
      budget.release(bytes);
    };

    // A source honours pause by delivering nothing until it resumes; each
    // chunk carries five 99-byte lines.
    const chunk = Buffer.concat(Array.from({ length: 5 }, () => line(100)));
    for (let delivered = 0; delivered < 200;) {
      if (!paused) {
        decode(chunk);
        delivered++;
      } else handleOne();
    }
    expect(pauses).toBeGreaterThan(1);
    expect(peak).toBeLessThan(1000 + chunk.length);
    while (unhandled.length > 0) handleOne();
    expect(paused).toBe(false);
  });
});

describe("plugin IPC line decoder", () => {
  it("joins a line trickled in one byte at a time", () => {
    const lines: Array<[string, number]> = [];
    const decode = makeLineDecoder({
      maxBytes: 1000,
      onLine: (text, bytes) => lines.push([text, bytes]),
      onOverflow: () => expect.unreachable(),
    });
    const text = `{"message":"${"é".repeat(300)}"}`;
    for (const byte of Buffer.from(`${text}\n`)) decode(Buffer.from([byte]));
    expect(lines).toEqual([[text, Buffer.byteLength(text)]]);
  });

  it("stops at the limit for a line trickled in one byte at a time", () => {
    let overflows = 0;
    const decode = makeLineDecoder({
      maxBytes: 1000,
      onLine: () => expect.unreachable(),
      onOverflow: () => overflows++,
    });
    for (let index = 0; index < 1000; index++) decode(Buffer.from("x"));
    expect(overflows).toBe(0);
    decode(Buffer.from("x"));
    decode(Buffer.from("x\n{}\n"));
    expect(overflows).toBe(1);
  });
});
