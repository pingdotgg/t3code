import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as HostProcess from "@t3tools/shared/HostProcess";

import * as KokoroVoice from "./KokoroVoice.ts";
import * as SpeechModelStore from "./SpeechModelStore.ts";

const voice = (options: {
  readonly platform?: NodeJS.Platform;
  readonly downloads?: Array<string>;
  readonly loads?: Array<KokoroVoice.KokoroModelFiles>;
  readonly failLoads?: number;
}) => {
  let failures = options.failLoads ?? 0;
  return KokoroVoice.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Path.layer,
        Layer.mock(SpeechModelStore.SpeechModelStore)({
          download: (file) =>
            Effect.sync(() => {
              options.downloads?.push(file.filename);
              return `/models/${file.path}`;
            }),
        }),
        Layer.succeed(
          KokoroVoice.KokoroEngine,
          KokoroVoice.KokoroEngine.of({
            load: async (files) => {
              options.loads?.push(files);
              if (failures > 0) {
                failures -= 1;
                throw new Error("native failure");
              }
              return { sampleRate: 24_000, generate: async () => Float32Array.of(0, 1, -1) };
            },
          }),
        ),
      ),
    ),
    Layer.provide(Layer.succeed(HostProcess.Platform, options.platform ?? "darwin")),
    Layer.provide(Layer.succeed(HostProcess.Architecture, "arm64")),
  );
};

it.effect("speaks text as 16-bit WAV after downloading and loading the voice once", () => {
  const downloads: Array<string> = [];
  const loads: Array<KokoroVoice.KokoroModelFiles> = [];
  return Effect.gen(function* () {
    const kokoro = yield* KokoroVoice.KokoroVoice;
    yield* kokoro.prepare;
    const wav = yield* kokoro.speak("Hello.");
    yield* kokoro.speak("Again.");
    expect(loads).toEqual([
      {
        model: "/models/kokoro-multi-lang-v1_0/model.onnx",
        voices: "/models/kokoro-multi-lang-v1_0/voices.bin",
        tokens: "/models/kokoro-multi-lang-v1_0/tokens.txt",
        lexicon: "/models/kokoro-multi-lang-v1_0/lexicon-us-en.txt",
        dataDir: "/models/kokoro-multi-lang-v1_0/espeak-ng-data",
      },
    ]);
    expect(downloads).toHaveLength(KokoroVoice.KOKORO_FILES.length);
    const view = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
    expect(view.getUint32(24, true)).toBe(24_000);
    expect(view.getUint32(40, true)).toBe(6);
    expect([view.getInt16(44, true), view.getInt16(46, true), view.getInt16(48, true)]).toEqual([
      0, 32_767, -32_768,
    ]);
  }).pipe(Effect.provide(voice({ downloads, loads })));
});

it.effect("loads again after a failed load instead of keeping the error", () => {
  const loads: Array<KokoroVoice.KokoroModelFiles> = [];
  return Effect.gen(function* () {
    const kokoro = yield* KokoroVoice.KokoroVoice;
    const first = yield* kokoro.speak("Hello.").pipe(Effect.flip);
    expect(first.reason).toBe("synthesis");
    yield* kokoro.speak("Hello.");
    expect(loads).toHaveLength(2);
  }).pipe(Effect.provide(voice({ loads, failLoads: 1 })));
});

it.effect("reports that spoken replies are unsupported on platforms without the engine", () =>
  Effect.gen(function* () {
    const kokoro = yield* KokoroVoice.KokoroVoice;
    const error = yield* kokoro.prepare.pipe(Effect.flip);
    expect(error.reason).toBe("unsupported");
  }).pipe(Effect.provide(voice({ platform: "freebsd" }))),
);
