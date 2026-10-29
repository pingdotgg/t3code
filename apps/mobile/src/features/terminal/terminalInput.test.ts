import { describe, expect, it } from "vite-plus/test";

import {
  chunkTerminalWrite,
  encodeTerminalPaste,
  resolveModifiedTerminalInput,
  TERMINAL_WRITE_MAX_LENGTH,
} from "./terminalInput";

const byte = (code: number) => String.fromCharCode(code);
const ESC = byte(0x1b);
const CTRL_V = byte(0x16);

describe("resolveModifiedTerminalInput", () => {
  it.each(["A", "B", "C", "D"])("encodes ctrl+arrow %s with the cursor modifier", (arrow) => {
    expect(
      resolveModifiedTerminalInput({
        data: `${ESC}[${arrow}`,
        modifier: "ctrl",
        hostPlatform: "linux",
      }),
    ).toEqual({ kind: "write", data: `${ESC}[1;5${arrow}` });
  });

  it.each(["A", "B", "C", "D"])("encodes meta+arrow %s with the cursor modifier", (arrow) => {
    expect(
      resolveModifiedTerminalInput({
        data: `${ESC}[${arrow}`,
        modifier: "meta",
        hostPlatform: "linux",
      }),
    ).toEqual({ kind: "write", data: `${ESC}[1;3${arrow}` });
  });

  it.each(["a", "", ESC, `${ESC}[H`, `${ESC}[1;5D`, `${ESC}[D\n`])(
    "preserves non-arrow modifier handling for %j",
    (data) => {
      expect(
        resolveModifiedTerminalInput({ data, modifier: "meta", hostPlatform: "linux" }),
      ).toEqual({
        kind: "write",
        data: `${ESC}${data}`,
      });
    },
  );

  it("pastes on ctrl+v for windows, linux, and unknown hosts", () => {
    for (const hostPlatform of ["windows", "linux", "unknown"] as const) {
      expect(resolveModifiedTerminalInput({ data: "v", modifier: "ctrl", hostPlatform })).toEqual({
        kind: "paste",
      });
      expect(resolveModifiedTerminalInput({ data: "V", modifier: "ctrl", hostPlatform })).toEqual({
        kind: "paste",
      });
    }
  });

  it("pastes on cmd+v and forwards raw ctrl+v on mac hosts", () => {
    expect(
      resolveModifiedTerminalInput({ data: "v", modifier: "meta", hostPlatform: "mac" }),
    ).toEqual({ kind: "paste" });
    expect(
      resolveModifiedTerminalInput({ data: "v", modifier: "ctrl", hostPlatform: "mac" }),
    ).toEqual({ kind: "write", data: CTRL_V });
  });
});

describe("encodeTerminalPaste", () => {
  it("turns LF and CRLF line breaks into a single carriage return each", () => {
    expect(encodeTerminalPaste("one\ntwo\r\nthree\n")).toBe("one\rtwo\rthree\r");
  });

  it("replaces unsafe control bytes with spaces but keeps tabs", () => {
    expect(encodeTerminalPaste(`a${byte(0)}b${ESC}c${byte(0x7f)}d\te`)).toBe("a b c d\te");
  });

  it("never lets a bracketed-paste end marker reach the shell", () => {
    expect(encodeTerminalPaste(`safe${ESC}[201~; rm -rf /\n`)).toBe("safe [201~; rm -rf /\r");
  });
});

describe("chunkTerminalWrite", () => {
  it("splits oversized writes so every chunk fits the contract", () => {
    const chunks = chunkTerminalWrite("y".repeat(TERMINAL_WRITE_MAX_LENGTH * 2 + 5));
    expect(chunks.map((chunk) => chunk.length)).toEqual([
      TERMINAL_WRITE_MAX_LENGTH,
      TERMINAL_WRITE_MAX_LENGTH,
      5,
    ]);
    expect(chunks.join("")).toHaveLength(TERMINAL_WRITE_MAX_LENGTH * 2 + 5);
  });

  it("does not cut a surrogate pair in half at the boundary", () => {
    const data = `${"z".repeat(TERMINAL_WRITE_MAX_LENGTH - 1)}😀tail`;
    const chunks = chunkTerminalWrite(data);
    expect(chunks[0]).toHaveLength(TERMINAL_WRITE_MAX_LENGTH - 1);
    expect(chunks[1]).toBe("😀tail");
    expect(chunks.join("")).toBe(data);
  });
});
