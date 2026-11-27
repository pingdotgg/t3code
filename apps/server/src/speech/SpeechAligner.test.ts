import { it } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SpeechAligner from "./SpeechAligner.ts";
import * as SpeechModelStore from "./SpeechModelStore.ts";
import type { HeardWord } from "./wordAlignment.ts";

const RATE = 24_000;
const ENCODER_DELAY = 1105 / RATE;
const ENGLISH_LAG = 0.125;
const silence = (seconds: number) => new Int16Array(Math.round(seconds * RATE));

const setup = (options: {
  readonly installed: boolean;
  readonly heard: ReadonlyArray<ReadonlyArray<HeardWord>>;
}) => {
  const responses = [...options.heard];
  const align = vi.fn(async (_pcm: Float32Array, _language?: string) => responses.shift() ?? []);
  const dispose = vi.fn(async () => {});
  const load = vi.fn(async () => ({ align, dispose }));
  // Still downloading, so a second request must not start another.
  const download = vi.fn((_model: SpeechModelStore.ModelFile) => Effect.never);
  const layer = Layer.effect(SpeechAligner.SpeechAligner, SpeechAligner.make(load)).pipe(
    Layer.provide(
      Layer.mock(SpeechModelStore.SpeechModelStore)({
        isReady: () => Effect.succeed(options.installed),
        installedPath: () => Effect.succeed(options.installed ? "/models/aligner.gguf" : undefined),
        download,
      }),
    ),
  );
  return { align, dispose, load, download, layer };
};

const heard = (...words: ReadonlyArray<readonly [string, number]>) =>
  words.map(([text, start]) => ({ text, startSeconds: start, endSeconds: start + 0.2 }));

const onSupportedHost = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(HostProcess.Platform, "darwin"),
    Effect.provideService(HostProcess.Architecture, "arm64"),
  );

it.effect("times each piece's words from its audio and fills the rest at the end", () => {
  const fake = setup({
    installed: true,
    heard: [
      heard(["alpha", 0.5], ["beta", 1], ["gamma", 1.5]),
      heard(["delta", 0.4], ["epsilon", 1]),
    ],
  });
  return Effect.gen(function* () {
    const aligner = yield* SpeechAligner.SpeechAligner;
    const text = "Alpha beta gamma. Delta epsilon zeta.";
    const session = (yield* aligner.session(text, "en-US", "english"))!;
    // The first piece is aligned once the second one, which starts after a gap, arrives.
    expect(yield* session.push(silence(2), RATE, 0)).toEqual([]);
    const first = yield* session.push(silence(2), RATE, 2.5);
    const rest = yield* session.finish(5);
    const words = [...first, ...rest];
    expect(words.map((word) => text.slice(word.start, word.end))).toEqual([
      "Alpha",
      "beta",
      "gamma.",
      "Delta",
      "epsilon",
      "zeta.",
    ]);
    expect(words[0]!.startSeconds).toBeCloseTo(ENCODER_DELAY + 0.5 - ENGLISH_LAG, 3);
    expect(words[3]!.startSeconds).toBeCloseTo(2.5 + ENCODER_DELAY + 0.4 - ENGLISH_LAG, 3);
    expect(words.at(-1)!.endSeconds).toBe(5);
    for (let index = 1; index < words.length; index++)
      expect(words[index]!.startSeconds).toBeGreaterThanOrEqual(words[index - 1]!.startSeconds);
    expect(fake.align).toHaveBeenCalledTimes(2);
    expect(fake.align.mock.calls[0]![0].length).toBe(2 * 16_000);
    expect(fake.align.mock.calls[0]![1]).toBeUndefined();
    expect(fake.load).toHaveBeenCalledTimes(1);
  }).pipe(Effect.provide(fake.layer), onSupportedHost);
});

it.effect("stops timing when the audio speaks something else", () => {
  const fake = setup({
    installed: true,
    heard: [
      heard(["entirely", 0], ["unrelated", 0.4], ["speech", 0.8], ["about", 1.2], ["nothing", 1.6]),
    ],
  });
  return Effect.gen(function* () {
    const aligner = yield* SpeechAligner.SpeechAligner;
    const session = (yield* aligner.session("Alpha beta gamma delta.", "auto", "english"))!;
    yield* session.push(silence(2), RATE, 0);
    expect(yield* session.finish(2)).toEqual([]);
    expect(yield* session.push(silence(2), RATE, 3)).toEqual([]);
    expect(fake.align).toHaveBeenCalledTimes(1);
  }).pipe(Effect.provide(fake.layer), onSupportedHost);
});

it.effect("has no session for text the model cannot hear", () => {
  const fake = setup({ installed: true, heard: [] });
  return Effect.gen(function* () {
    const aligner = yield* SpeechAligner.SpeechAligner;
    expect(
      yield* aligner.session("設定画面を確認しました。", "auto", "multilingual"),
    ).toBeUndefined();
    expect(yield* aligner.session("Revisé la configuración.", "es", "english")).toBeUndefined();
    expect(yield* aligner.session("Revisé la configuración.", "es", "multilingual")).toBeDefined();
    const spanish =
      "Revisé la pantalla de ajustes y encontré el problema. Cuando cambias de proveedor, la voz anterior sigue seleccionada.";
    expect(yield* aligner.session(spanish, "auto", "english")).toBeUndefined();
    expect(yield* aligner.session(spanish, "auto", "multilingual")).toBeDefined();
  }).pipe(Effect.provide(fake.layer), onSupportedHost);
});

it.effect("downloads a missing model once and has no session until it is installed", () => {
  const fake = setup({ installed: false, heard: [] });
  return Effect.gen(function* () {
    const aligner = yield* SpeechAligner.SpeechAligner;
    expect(yield* aligner.session("Alpha beta.", "en", "english")).toBeUndefined();
    yield* aligner.prepare("english");
    yield* Effect.yieldNow;
    expect(fake.download).toHaveBeenCalledTimes(1);
    expect(fake.download.mock.calls[0]![0]).toMatchObject({
      id: "handy-computer/parakeet-tdt_ctc-110m-gguf",
    });
  }).pipe(Effect.provide(fake.layer), onSupportedHost);
});
