import { describe, expect, it } from "vite-plus/test";

import { encodeTerminalPaste } from "./encodeTerminalPaste";

describe("encodeTerminalPaste", () => {
  it("returns empty for empty input", () => {
    expect(encodeTerminalPaste("")).toBe("");
  });

  it("passes through plain text when not bracketed", () => {
    expect(encodeTerminalPaste("hello")).toBe("hello");
  });

  it("replaces newlines with carriage returns when not bracketed", () => {
    expect(encodeTerminalPaste("one\ntwo\r\nthree")).toBe("one\rtwo\rthree");
  });

  it("strips bracketed-paste end sequences to block injection", () => {
    expect(encodeTerminalPaste("safe\u001b[201~; rm -rf /\n")).toBe("safe; rm -rf /\r");
    expect(encodeTerminalPaste("\u001b[201~\u001b[201~")).toBe("");
  });

  it("wraps only when bracketed is explicitly enabled", () => {
    expect(encodeTerminalPaste("a\nb", { bracketed: true })).toBe("\u001b[200~a\nb\u001b[201~");
  });

  it("still strips embedded end sequences before wrapping", () => {
    expect(encodeTerminalPaste("x\u001b[201~y", { bracketed: true })).toBe(
      "\u001b[200~xy\u001b[201~",
    );
  });
});
