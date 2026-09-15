import { describe, expect, it } from "vite-plus/test";
import { removeSpeechFillerWords } from "./fillerWords.ts";

describe("removeSpeechFillerWords", () => {
  it("removes universal fillers and cleans whitespace", () => {
    expect(removeSpeechFillerWords("Uh, I uhm think this works.")).toBe("I think this works.");
  });

  it("only removes ambiguous fillers with matching language evidence", () => {
    expect(removeSpeechFillerWords("um I think", "en")).toBe("I think");
    expect(removeSpeechFillerWords("eu vi um carro")).toBe("eu vi um carro");
    expect(removeSpeechFillerWords("äh ich glaube ähm das passt", "de-DE")).toBe(
      "ich glaube das passt",
    );
  });

  it("does not remove fillers inside words", () => {
    expect(removeSpeechFillerWords("humming thumbnail")).toBe("humming thumbnail");
  });
});
