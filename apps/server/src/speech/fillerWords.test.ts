import { describe, expect, it } from "vite-plus/test";
import { removeSpeechFillerWords } from "./fillerWords.ts";

describe("removeSpeechFillerWords", () => {
  it.each([
    ["Ah, hum, ahn, acho que sim.", "acho que sim."],
    [
      "É, acrescente na thread, é, toda vez que criar um título.",
      "acrescente na thread, toda vez que criar um título.",
    ],
    ["como se ele tivesse, é, é, é ansioso.", "como se ele tivesse, é ansioso."],
    ["Uma frase.\nÉ, acrescente na thread.", "Uma frase.\nacrescente na thread."],
  ])("drops Portuguese hesitations: %s", (input, expected) => {
    expect(removeSpeechFillerWords(input, "pt-BR")).toBe(expected);
  });

  it.each([
    "a regra é, ele me responde.",
    "Isso é, é muito bom.",
    "A casa é linda.",
    "A regra\né, em certos casos, importante.",
  ])("keeps the Portuguese verb é: %s", (input) => {
    expect(removeSpeechFillerWords(input, "pt")).toBe(input);
  });

  it("keeps Portuguese hesitations for other languages", () => {
    expect(removeSpeechFillerWords("É, acrescente", "en")).toBe("É, acrescente");
  });

  it("keeps the correction cue next to a Portuguese hesitation", () => {
    expect(removeSpeechFillerWords("É, scratch that, é melhor amanhã.", "pt", "scratch that")).toBe(
      "scratch that, é melhor amanhã.",
    );
  });
});
