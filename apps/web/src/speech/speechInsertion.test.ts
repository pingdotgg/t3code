import { describe, expect, it } from "vite-plus/test";
import { formatSpeechInsertion } from "./speechInsertion";

describe("formatSpeechInsertion", () => {
  it("adds boundary spaces without changing transcript punctuation", () => {
    expect(formatSpeechInsertion("helloworld", 5, "new text")).toBe(" new text ");
    expect(formatSpeechInsertion("hello ", 6, "world.")).toBe("world.");
    expect(formatSpeechInsertion("", 0, " hello ")).toBe("hello");
  });
});
