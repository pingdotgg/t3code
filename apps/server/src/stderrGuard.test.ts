// @effect-diagnostics nodeBuiltinImport:off - the guard exists for a real Node stream.
import * as NodeStream from "node:stream";

import { describe, expect, it } from "vite-plus/test";

import { guardStderr } from "./stderrGuard.ts";

const makeStream = (write: (chunk: unknown) => boolean) => {
  const emitter = new NodeStream.EventEmitter();
  return Object.assign(emitter, { write }) as unknown as Parameters<typeof guardStderr>[0] & {
    emit: (event: string, payload: unknown) => boolean;
  };
};

describe("guardStderr", () => {
  it("passes the chunk through and reports what the stream reported", () => {
    const written: unknown[] = [];
    const stream = makeStream((chunk) => {
      written.push(chunk);
      return false;
    });
    guardStderr(stream);
    expect(stream.write("first\n" as never)).toBe(false);
    expect(written).toEqual(["first\n"]);
  });

  it("survives a write that throws, which is what kills an unguarded process", () => {
    const stream = makeStream(() => {
      throw Object.assign(new Error("write EIO"), { code: "EIO" });
    });
    guardStderr(stream);
    // `true` rather than `false`: a caller told the write was buffered waits for
    // a `drain` event that a broken pipe never emits.
    expect(stream.write("warning\n" as never)).toBe(true);
  });

  it("survives an error event the stream raises on its own", () => {
    const stream = makeStream(() => true);
    guardStderr(stream);
    expect(() => stream.emit("error", new Error("write EIO"))).not.toThrow();
  });
});
