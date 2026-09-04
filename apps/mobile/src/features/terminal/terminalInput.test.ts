import { describe, expect, it } from "vite-plus/test";

import {
  applyCtrlModifier,
  chunkTerminalWrite,
  encodeTerminalPaste,
  hostPlatformFromOs,
  resolveModifiedTerminalInput,
  TERMINAL_WRITE_MAX_LENGTH,
} from "./terminalInput";

const byte = (code: number) => String.fromCharCode(code);
const ESC = byte(0x1b);
const CTRL_C = byte(0x03);
const CTRL_V = byte(0x16);

describe("applyCtrlModifier", () => {
  it("maps letters to control bytes regardless of case", () => {
    expect(applyCtrlModifier("c")).toBe(CTRL_C);
    expect(applyCtrlModifier("C")).toBe(CTRL_C);
    expect(applyCtrlModifier("z")).toBe(byte(0x1a));
  });

  it("maps the punctuation control keys and leaves the rest untouched", () => {
    expect(applyCtrlModifier("[")).toBe(ESC);
    expect(applyCtrlModifier("?")).toBe(byte(0x7f));
    expect(applyCtrlModifier("1")).toBe("1");
    expect(applyCtrlModifier("")).toBe("");
  });
});

describe("resolveModifiedTerminalInput", () => {
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

  it("keeps alt+v as a meta chord on non-mac hosts", () => {
    expect(
      resolveModifiedTerminalInput({ data: "v", modifier: "meta", hostPlatform: "windows" }),
    ).toEqual({ kind: "write", data: `${ESC}v` });
  });

  it("pastes on cmd+v and forwards raw ctrl+v on mac hosts", () => {
    expect(
      resolveModifiedTerminalInput({ data: "v", modifier: "meta", hostPlatform: "mac" }),
    ).toEqual({ kind: "paste" });
    expect(
      resolveModifiedTerminalInput({ data: "v", modifier: "ctrl", hostPlatform: "mac" }),
    ).toEqual({ kind: "write", data: CTRL_V });
  });

  it("still encodes every other modified key", () => {
    expect(
      resolveModifiedTerminalInput({ data: "c", modifier: "ctrl", hostPlatform: "windows" }),
    ).toEqual({ kind: "write", data: CTRL_C });
    expect(
      resolveModifiedTerminalInput({ data: "[A", modifier: "meta", hostPlatform: "linux" }),
    ).toEqual({ kind: "write", data: `${ESC}[A` });
  });
});

describe("encodeTerminalPaste", () => {
  it("passes single-line text through unchanged", () => {
    expect(encodeTerminalPaste("git switch -c fix/paste")).toBe("git switch -c fix/paste");
    expect(encodeTerminalPaste("")).toBe("");
  });

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
  it("leaves writes within the wire limit whole", () => {
    expect(chunkTerminalWrite("")).toEqual([]);
    expect(chunkTerminalWrite("ls")).toEqual(["ls"]);
    expect(chunkTerminalWrite("x".repeat(TERMINAL_WRITE_MAX_LENGTH))).toHaveLength(1);
  });

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

describe("hostPlatformFromOs", () => {
  it("maps the descriptor os onto the toolbar layout", () => {
    expect(hostPlatformFromOs("darwin")).toBe("mac");
    expect(hostPlatformFromOs("windows")).toBe("windows");
    expect(hostPlatformFromOs("linux")).toBe("linux");
  });

  it("defers to the caller when the os is unknown or not loaded yet", () => {
    expect(hostPlatformFromOs("unknown")).toBeNull();
    expect(hostPlatformFromOs(null)).toBeNull();
  });
});
