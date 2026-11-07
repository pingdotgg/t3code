import { expect, it } from "vite-plus/test";

import { loadKokoroSpeaker } from "./kokoro.ts";

// Each sentence renders as one sample holding its length; "hang" never finishes.
const fixture = `data:text/javascript,${encodeURIComponent(`
  export const KokoroTTS = { from_pretrained: async (path, options) => ({
    generate: (text, { voice }) => text === "hang" ? new Promise(() => {}) :
      Promise.resolve({ audio: Float32Array.of(text.length + voice.length), sampling_rate: 24000 }),
  }) };
`)}`;

it("renders queued sentences in order from an isolated process", async () => {
  const speaker = await loadKokoroSpeaker("unused", new AbortController().signal, {
    moduleUrl: fixture,
  });
  try {
    const rendered = await Promise.all([speaker.speak("one", "v"), speaker.speak("three", "vv")]);
    expect(rendered.map((pcm) => [...pcm])).toEqual([[4], [7]]);
  } finally {
    await speaker.dispose();
  }
});

it("abort kills the process and fails the sentence in flight", async () => {
  const controller = new AbortController();
  const speaker = await loadKokoroSpeaker("unused", controller.signal, { moduleUrl: fixture });
  const hung = speaker.speak("hang", "v");
  controller.abort();
  await expect(hung).rejects.toThrow("Speech synthesis process stopped.");
  await expect(speaker.speak("later", "v")).rejects.toThrow("Speech synthesis process stopped.");
  await speaker.dispose();
});
