import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_DICTATION_SETTINGS } from "@t3tools/contracts";
import { createDictationFormatter, formatSpokenPunctuation } from "./voicePunctuation.ts";

describe("spoken punctuation", () => {
  it.each([
    ["is it ready question mark", "is it ready?"],
    ["done period next sentence full stop", "done. next sentence."],
    ["yes comma please exclamation point", "yes, please!"],
    ["ready Question mark. next", "ready? next"],
    ["question mark", "?"],
    ["Ready. question mark.", "Ready?"],
  ])("formats %s", (speech, expected) => {
    expect(formatSpokenPunctuation(speech)).toBe(expected);
  });
  it("preserves identifiers, decimals, and ordinary period-of phrasing", () => {
    const text =
      "use foo.period period.foo foo:comma comma:foo period/foo foo/period comma_count over a period of time with version 3.14";
    expect(formatSpokenPunctuation(text)).toBe(text);
  });
});

describe("fast dictation formatting", () => {
  const format = createDictationFormatter(DEFAULT_DICTATION_SETTINGS);
  it("formats paragraphs, bullets and numbered lists without a network call", () => {
    expect(format("Hello new paragraph next line new line end")).toBe("Hello\n\nnext line\nend");
    expect(format("tasks bullet point test next bullet deploy")).toBe("tasks\n- test\n- deploy");
    expect(format("steps number one test number two deploy")).toBe("steps\n1. test\n2. deploy");
    expect(format("new paragraph")).toBe("\n\n");
  });
  it("undoes only the most recent dictated sentence with scratch that", () => {
    expect(format("Keep this. remove this scratch that use this")).toBe("Keep this. use this");
    expect(format("remove this scratch that")).toBe("");
    expect(format("one scratch that two scratch that three")).toBe("three");
    expect(format("use version 3.14 scratch that use version 4")).toBe("use version 4");
  });
  it("removes hesitation sounds while preserving meaningful words and identifiers", () => {
    expect(format("um, I actually like this uh version")).toBe("I actually like this version");
    expect(format("the summary uses uh_value and album")).toBe(
      "the summary uses uh_value and album",
    );
  });
  it("expands the longest whole phrase once and leaves snippet text literal", () => {
    const custom = createDictationFormatter({
      ...DEFAULT_DICTATION_SETTINGS,
      replacements: [
        { kind: "word", phrase: "whisper flow", replacement: "Wispr Flow" },
        { kind: "snippet", phrase: "my tests", replacement: "um, new paragraph\n1. unit tests" },
        { kind: "snippet", phrase: "tests", replacement: "should not recurse" },
      ],
    });
    expect(custom("use Whisper Flow with my tests")).toBe(
      "use Wispr Flow with um, new paragraph\n1. unit tests",
    );
    expect(custom("whisper flower")).toBe("whisper flower");
  });
  it("lets users disable commands and filler cleanup", () => {
    expect(
      createDictationFormatter({
        ...DEFAULT_DICTATION_SETTINGS,
        spokenCommands: false,
        removeFillers: false,
        replacements: [],
      })("um new paragraph scratch that period"),
    ).toBe("um new paragraph scratch that period");
  });
});
