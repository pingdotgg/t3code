import { expect, it } from "vite-plus/test";

import { openRouterHintOptions } from "./openRouterHints.ts";

it("omits provider options when there are no words to hint", () => {
  expect(openRouterHintOptions([])).toBeUndefined();
});

it("sends words in each supported provider's own vocabulary field", () => {
  expect(openRouterHintOptions(["Vite", "T3 Code"])).toEqual({
    azure: { phraseList: { phrases: ["Vite", "T3 Code"] } },
    "google-vertex": { custom_vocabulary: ["Vite", "T3 Code"] },
    assemblyai: { keyterms_prompt: ["Vite", "T3 Code"] },
    openai: { prompt: "Expected vocabulary: Vite, T3 Code" },
    groq: { prompt: "Expected vocabulary: Vite, T3 Code" },
    together: { prompt: "Expected vocabulary: Vite, T3 Code" },
  });
});

it("keeps prompt vocabularies inside the provider token limit", () => {
  const words = Array.from({ length: 100 }, (_, index) => `word${index}`.padEnd(50, "x"));
  const options = openRouterHintOptions(words)!;
  for (const provider of ["openai", "groq", "together"]) {
    const prompt = (options[provider] as { prompt: string }).prompt;
    expect(prompt.length).toBeLessThanOrEqual(800);
    expect(prompt.startsWith("Expected vocabulary: word0")).toBe(true);
    expect(prompt).not.toContain("word99");
  }
});

it("keeps Azure phrase lists inside its character budget", () => {
  const words = Array.from({ length: 100 }, (_, index) => `word${index}`.padEnd(50, "x"));
  const options = openRouterHintOptions(words)!;
  const phrases = (options.azure as { phraseList: { phrases: string[] } }).phraseList.phrases;
  expect(phrases.reduce((total, phrase) => total + phrase.length, 0)).toBeLessThanOrEqual(3_200);
  expect(phrases[0]).toBe(words[0]);
  expect(phrases).not.toContain(words[99]);
});

it("does not send hints to providers that drop them on OpenRouter", () => {
  const options = openRouterHintOptions(["Vite"])!;
  for (const provider of ["deepgram", "elevenlabs", "mistral", "deepinfra", "primeintellect"]) {
    expect(options).not.toHaveProperty(provider);
  }
});
