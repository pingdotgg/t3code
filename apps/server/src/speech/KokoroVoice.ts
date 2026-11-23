// @effect-diagnostics nodeBuiltinImport:off - ONNX inference needs a thread count from the host's cores.
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as HostProcess from "@t3tools/shared/HostProcess";

import { isSpeechPlatformSupported } from "./platform.ts";
import * as SpeechModelStore from "./SpeechModelStore.ts";

const REPOSITORY = "csukuangfj/kokoro-multi-lang-v1_0";
const REVISION = "f7b96bb6bef5c5da4d3aa4f4e0498fbbf62dc78b";
const DIRECTORY = "kokoro-multi-lang-v1_0";
const AF_HEART = 3;
// sherpa-onnx-node is external to the CLI bundle; Node single-executables can load it from disk only with require.
const requireSherpa = NodeModule.createRequire(import.meta.url);

// English needs only these espeak-ng files; the repository carries every language.
const FILES = [
  ["model.onnx", 325_560_556, "b40f62b166ac8164b0627ef48a0b358eda0985e272fb03ef5252e7206305da11"],
  ["voices.bin", 28_200_960, "1c5a5b983d3d50d8586d437a51f3faa2da7919ce76a013c081e65671a3447c29"],
  ["tokens.txt", 687, "6ebb6bb288f20f3ae8d004d3c2ca27697da27c037d75e81a60e2a6a663f95425"],
  [
    "lexicon-us-en.txt",
    5_956_885,
    "7daaab53a181be9885b853a8582bf1838186317e5dadacbcef9c426d6fa0da14",
  ],
  [
    "espeak-ng-data/phontab",
    55_796,
    "886f3fa402cb0ba73d483aa8ad000af47a6b7cc06293c75a97913fba68a530f6",
  ],
  [
    "espeak-ng-data/phonindex",
    39_074,
    "3ca7b8fa3b42624e4b0f152707e7a39245fce569aa99ea47c055d9e622fcf0c4",
  ],
  [
    "espeak-ng-data/phondata",
    550_424,
    "4e0288957874029a8c3c9f41a8f517ad4bf18127046decbdd4b9d1d6807ce3a3",
  ],
  [
    "espeak-ng-data/intonations",
    2_040,
    "3f8af65fd3eda9759a10f021d61361c120871f463515229c925995c7f90918cc",
  ],
  [
    "espeak-ng-data/en_dict",
    166_944,
    "71bd330ba8a2e3e8076e631508208ef49449d6147c17b7bd2b4b1e1468292e35",
  ],
  [
    "espeak-ng-data/lang/gmw/en-US",
    257,
    "41534c2a22df5dd4f1052ff9e1a33a3ea7bff5a26b5c02bdad5ba8ddb7524704",
  ],
] as const;

export const KOKORO_FILES = FILES.map(([filename, size, sha256]) => ({
  id: REPOSITORY,
  revision: REVISION,
  filename,
  path: `${DIRECTORY}/${filename}`,
  size,
  sha256,
}));

export class KokoroVoiceError extends Schema.TaggedError<KokoroVoiceError>()("KokoroVoiceError", {
  reason: Schema.Literals(["unsupported", "download", "synthesis"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    if (this.reason === "unsupported") return "Spoken replies are not available on this machine.";
    return this.reason === "download"
      ? "The Kokoro voice could not be downloaded."
      : "The Kokoro voice could not read this text.";
  }
}

export interface KokoroModelFiles {
  readonly model: string;
  readonly voices: string;
  readonly tokens: string;
  readonly lexicon: string;
  readonly dataDir: string;
}

export interface KokoroSynthesizer {
  readonly sampleRate: number;
  readonly generate: (text: string) => Promise<Float32Array>;
}

/** The native ONNX engine, replaced in tests. */
export class KokoroEngine extends Context.Service<
  KokoroEngine,
  { readonly load: (files: KokoroModelFiles) => Promise<KokoroSynthesizer> }
>()("t3/speech/KokoroVoice/KokoroEngine") {}

export const layerSherpaEngine = Layer.succeed(
  KokoroEngine,
  KokoroEngine.of({
    load: async (files) => {
      const { OfflineTts } = requireSherpa(
        "sherpa-onnx-node",
      ) as typeof import("sherpa-onnx-node").default;
      const tts = await OfflineTts.createAsync({
        model: {
          kokoro: { ...files, lengthScale: 1 },
          numThreads: Math.min(8, Math.max(1, Math.floor(NodeOS.availableParallelism() / 2))),
          provider: "cpu",
          debug: false,
        },
        maxNumSentences: 1,
      });
      return {
        sampleRate: tts.sampleRate,
        generate: async (text) =>
          (
            await tts.generateAsync({
              text,
              sid: AF_HEART,
              speed: 1,
              enableExternalBuffer: false,
            })
          ).samples,
      };
    },
  }),
);

/** 16-bit mono PCM in a WAV container, which every browser decodes. */
function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1)
      view.setUint8(offset + index, text.charCodeAt(index));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(44 + index * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  });
  return bytes;
}

export class KokoroVoice extends Context.Service<
  KokoroVoice,
  {
    /** Downloads the voice once and loads it, so the first reply starts quickly. */
    readonly prepare: Effect.Effect<void, KokoroVoiceError>;
    /** One sentence or paragraph of speech as a WAV file. */
    readonly speak: (text: string) => Effect.Effect<Uint8Array, KokoroVoiceError>;
  }
>()("t3/speech/KokoroVoice") {}

const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;
  const libc = platform === "linux" ? yield* HostProcess.LinuxLibc : undefined;
  const store = yield* SpeechModelStore.SpeechModelStore;
  const engine = yield* KokoroEngine;
  const path = yield* Path.Path;
  const supported = isSpeechPlatformSupported(platform, architecture, libc);

  const load = Effect.gen(function* () {
    if (!supported) return yield* new KokoroVoiceError({ reason: "unsupported" });
    const paths = yield* Effect.forEach(KOKORO_FILES, (file) => store.download(file), {
      concurrency: 4,
    }).pipe(Effect.mapError((cause) => new KokoroVoiceError({ reason: "download", cause })));
    const [model, voices, tokens, lexicon, phontab] = paths;
    return yield* Effect.tryPromise({
      try: () =>
        engine.load({
          model: model!,
          voices: voices!,
          tokens: tokens!,
          lexicon: lexicon!,
          dataDir: path.dirname(phontab!),
        }),
      catch: (cause) => new KokoroVoiceError({ reason: "synthesis", cause }),
    });
  });
  const synthesizer = yield* load.pipe(
    Effect.cachedWithTTL((exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero)),
  );
  const oneAtATime = yield* Semaphore.make(1);

  return KokoroVoice.of({
    prepare: Effect.asVoid(synthesizer).pipe(Effect.withSpan("KokoroVoice.prepare")),
    speak: Effect.fn("KokoroVoice.speak")(function* (text) {
      const voice = yield* synthesizer;
      const samples = yield* oneAtATime.withPermits(1)(
        Effect.tryPromise({
          try: () => voice.generate(text),
          catch: (cause) => new KokoroVoiceError({ reason: "synthesis", cause }),
        }),
      );
      return encodeWav(samples, voice.sampleRate);
    }),
  });
});

export const layer = Layer.effect(KokoroVoice, make);
