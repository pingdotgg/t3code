import { describe, expect, it } from "vitest";
import {
  applyTerminalCtrlModifier,
  TERMINAL_ACCESSORY_KEYS,
  TERMINAL_ARROW_UP,
  TERMINAL_ESC,
} from "./terminalAccessoryKeys";

const ctrl = (letter: string) =>
  String.fromCharCode(letter.toUpperCase().charCodeAt(0) & 0x1f);

describe("applyTerminalCtrlModifier", () => {
  it("maps lowercase letters to their control byte", () => {
    expect(applyTerminalCtrlModifier("c")).toBe(ctrl("c"));
    expect(applyTerminalCtrlModifier("d")).toBe(ctrl("d"));
    expect(applyTerminalCtrlModifier("a")).toBe(ctrl("a"));
    expect(applyTerminalCtrlModifier("c")).toBe("\u0003");
  });

  it("maps uppercase letters to the same control byte", () => {
    expect(applyTerminalCtrlModifier("C")).toBe(ctrl("c"));
    expect(applyTerminalCtrlModifier("Z")).toBe("\u001a");
  });

  it("maps the symbols in the @-_ range", () => {
    expect(applyTerminalCtrlModifier("[")).toBe("\u001b");
    expect(applyTerminalCtrlModifier("_")).toBe("\u001f");
  });

  it("returns null for input that has no control equivalent", () => {
    expect(applyTerminalCtrlModifier("1")).toBeNull();
    expect(applyTerminalCtrlModifier(" ")).toBeNull();
  });

  it("returns null for multi-character input such as a paste", () => {
    expect(applyTerminalCtrlModifier("cd")).toBeNull();
    expect(applyTerminalCtrlModifier("")).toBeNull();
  });
});

describe("TERMINAL_ACCESSORY_KEYS", () => {
  it("exposes a single Ctrl modifier key and the rest as data keys", () => {
    const modifierKeys = TERMINAL_ACCESSORY_KEYS.filter((key) => key.kind === "modifier");
    expect(modifierKeys).toHaveLength(1);
    expect(modifierKeys[0]?.id).toBe("ctrl");
  });

  it("uses escape-prefixed sequences for arrows and a bare escape for Esc", () => {
    const esc = TERMINAL_ACCESSORY_KEYS.find((key) => key.id === "esc");
    expect(esc?.kind === "data" && esc.data).toBe(TERMINAL_ESC);
    const up = TERMINAL_ACCESSORY_KEYS.find((key) => key.id === "arrow-up");
    expect(up?.kind === "data" && up.data).toBe(TERMINAL_ARROW_UP);
  });

  it("has unique ids", () => {
    const ids = TERMINAL_ACCESSORY_KEYS.map((key) => key.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
