import { describe, expect, it } from "vite-plus/test";

import { matchComposerInlineSuggestion } from "./composerInlineSuggestion.ts";

const candidates = [
  { label: "Hetzner VPS" },
  { label: "Mac mini" },
  { label: "Claude Opus 5.5" },
  { label: "dev-box" },
];

const match = (text: string) => {
  const found = matchComposerInlineSuggestion(text, candidates);
  return found && [found.candidate.label, found.typed, found.remainder];
};

describe("matchComposerInlineSuggestion", () => {
  it.each([
    ["run this on hetz", ["Hetzner VPS", "hetz", "ner VPS"]],
    ["run this on HETZNER V", ["Hetzner VPS", "HETZNER V", "PS"]],
    ["run on mac mi", ["Mac mini", "mac mi", "ni"]],
    ["have opus", ["Claude Opus 5.5", "opus", " 5.5"]],
    ["(hetz", ["Hetzner VPS", "hetz", "ner VPS"]],
    ["first line\nhetz", ["Hetzner VPS", "hetz", "ner VPS"]],
    ["try box", ["dev-box", "box", " (dev-box)"]],
    ["use Hetzner VPS", ["Hetzner VPS", "Hetzner VPS", ""]],
  ])("completes %j", (text, expected) => {
    expect(match(text)).toEqual(expected);
  });

  it.each([
    ["he", "too short"],
    ["hetz ", "a finished word"],
    ["@hetz", "an @ mention, which has its own menu"],
    ["/model opus", "a command, which has its own menu"],
    ["5.5", "a run that does not start with a letter"],
    ["sohetz", "the middle of a word"],
    ["etzner", "the middle of a label's word"],
    ["", "an empty line"],
  ])("leaves %j alone: %s", (text) => {
    expect(match(text)).toBeNull();
  });

  it("prefers the earliest candidate when several match", () => {
    const found = matchComposerInlineSuggestion("mac", [
      { label: "Mac mini" },
      { label: "MacBook" },
    ]);
    expect(found?.candidate.label).toBe("Mac mini");
  });
});
