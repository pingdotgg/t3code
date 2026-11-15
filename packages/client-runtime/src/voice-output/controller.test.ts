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
  const controller = new VoiceOutputController({ play, pause() {}, async resume() {} });
  await controller.start("a", "First\n\nSecond", synthesize);
  expect(synthesize).toHaveBeenCalledOnce();
  expect(play).not.toHaveBeenCalled();
  expect(controller.getSnapshot()).toMatchObject({
    phase: "error",
    error: "Local engine unavailable",
  });
});
