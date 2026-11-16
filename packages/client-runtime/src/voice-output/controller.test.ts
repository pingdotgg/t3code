import { expect, it, vi } from "vite-plus/test";
import { VoiceOutputController, type SpeechAudioPlayer } from "./controller.ts";
import { speechTextChunks } from "./text.ts";

it("reads prose and link labels, omits code and images, and bounds every chunk", () => {
  const chunks = speechTextChunks(
    "# Olá\n\nLeia [o guia](https://example.com). `npm test`\n\n```sh\nrm arquivo\n```\n\n![image](secret.png)\n\n" +
      "palavra ".repeat(900),
  );
  expect(chunks.join(" ")).toContain("Olá Leia o guia. npm test");
  expect(chunks.join(" ")).not.toMatch(/rm arquivo|secret.png|https:/);
  expect(chunks.every((chunk) => chunk.length > 0 && chunk.length <= 1800)).toBe(true);
  expect(speechTextChunks("```js\nconst x = 1\n```\n![image](a.png)")).toEqual([]);
  expect(speechTextChunks("- Alpha\n\n  Bravo")).toEqual(["Alpha", "Bravo"]);
  expect(speechTextChunks("- Alpha\n  - Bravo")).toEqual(["Alpha", "Bravo"]);
});

it("discards late synthesis after switching messages and aborts active playback", async () => {
  const oldAudio = Promise.withResolvers<Uint8Array>();
  const played = Promise.withResolvers<void>();
  let playbackSignal: AbortSignal | undefined;
  const player: SpeechAudioPlayer = {
    play: vi.fn<SpeechAudioPlayer["play"]>((_audio, signal, onPlaying) => {
      playbackSignal = signal;
      onPlaying();
      played.resolve();
      return new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    }),
    setPlaybackRate: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(async () => {}),
  };
  const controller = new VoiceOutputController(player);
  const first = controller.start("a", "Old", () => oldAudio.promise);
  const second = controller.start("b", "New", async () => new Uint8Array([2]));
  await played.promise;
  oldAudio.resolve(new Uint8Array([1]));
  await first;
  expect(player.play).toHaveBeenCalledOnce();
  expect(controller.getSnapshot()).toMatchObject({ owner: "b", phase: "playing" });
  await controller.togglePause();
  expect(controller.getSnapshot().phase).toBe("paused");
  await controller.togglePause();
  expect(controller.getSnapshot().phase).toBe("playing");
  controller.stop();
  await second;
  expect(playbackSignal?.aborted).toBe(true);
  expect(controller.getSnapshot()).toMatchObject({ owner: null, phase: "idle" });
});

it("ends the queue on a synthesis failure without playing stale segments", async () => {
  const play = vi.fn(async () => {});
  const synthesize = vi.fn(async () => {
    throw new Error("Local engine unavailable");
  });
  const controller = new VoiceOutputController({
    play,
    setPlaybackRate() {},
    pause() {},
    async resume() {},
  });
  await controller.start("a", "First\n\nSecond", synthesize);
  expect(synthesize).toHaveBeenCalledOnce();
  expect(play).not.toHaveBeenCalled();
  expect(controller.getSnapshot()).toMatchObject({
    phase: "error",
    error: "Local engine unavailable",
  });
});

it("updates active audio and retains speed across queued chunks and messages", async () => {
  const rates: number[] = [];
  const player: SpeechAudioPlayer = {
    play: async (_audio, _signal, onPlaying, rate) => {
      rates.push(rate);
      onPlaying();
      if (rates.length === 1) controller.setPlaybackRate(1.5);
    },
    setPlaybackRate: vi.fn(),
    pause() {},
    async resume() {},
  };
  const controller = new VoiceOutputController(player);
  controller.setPlaybackRate(1.25);
  await controller.start("a", "First\n\nSecond", async () => new Uint8Array([1]));
  expect(player.setPlaybackRate).toHaveBeenLastCalledWith(1.5);
  expect(rates).toEqual([1.25, 1.5]);
  for (const rate of [NaN, Infinity, 0, 3])
    expect(() => controller.setPlaybackRate(rate)).toThrow(RangeError);
  await controller.start("b", "Third", async () => new Uint8Array([1]));
  expect(rates).toEqual([1.25, 1.5, 1.5]);
});
