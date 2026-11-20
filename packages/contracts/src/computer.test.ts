import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import { ComputerKey, computerChord } from "./computer.ts";

describe("computerChord", () => {
  it.each([
    ["return", "enter"],
    ["Enter", "enter"],
    ["esc", "escape"],
    ["cmd+l", "cmd+l"],
    ["Command+Shift+G", "cmd+shift+g"],
    ["shift+cmd+g", "cmd+shift+g"],
    ["alt+cmd+i", "cmd+alt+i"],
    ["option + command + i", "cmd+alt+i"],
    ["ctrl+shift+tab", "ctrl+shift+tab"],
    ["cmd+,", "cmd+,"],
    ["cmd+[", "cmd+["],
    ["cmd+=", "cmd+="],
    ["backspace", "delete"],
    ["PageDown", "pagedown"],
    ["f12", "f12"],
    ["/", "/"],
  ])("%s is %s", (input, chord) => {
    expect(computerChord(input)).toBe(chord);
  });

  it.each(["", "cmd", "cmd+", "cmd+cmd+l", "cmd+banana", "cmd+l+t", "hyper+l", "f13", "a b"])(
    "%j is not a chord",
    (input) => {
      expect(computerChord(input)).toBeNull();
    },
  );

  it("the act schema takes chords and refuses anything else", () => {
    const decode = Schema.decodeUnknownSync(ComputerKey);
    expect(decode("alt+cmd+i")).toBe("alt+cmd+i");
    expect(() => decode("cmd+banana")).toThrow();
  });
});
