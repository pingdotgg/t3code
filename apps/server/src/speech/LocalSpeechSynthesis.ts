// @effect-diagnostics nodeBuiltinImport:off - worker parallelism comes from the host's CPU count.
import * as NodeOS from "node:os";
import {
  SpeechSynthesisError,
  type SpeechSynthesisCatalog,
  type SpeechSynthesisRequest,
} from "@t3tools/contracts";
import {
  AUDIO_CPP_ESPEAK_DATA,
  AUDIO_CPP_VERSION,
  audioCppRuntime,
  type AudioCppRuntime,
} from "@t3tools/audio-cpp";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as SpeechModelStore from "./SpeechModelStore.ts";
import type { SpeechSynthesisPart } from "./CloudSpeech.ts";
import { loadLocalSynthesisModel, type LocalSynthesisModel } from "./localSynthesisWorker.ts";
import { supertonicText } from "./synthesisAudio.ts";

/** A preset the model names itself, or one it reads from its own file. */
type LocalVoice = {
  readonly id: string;
  /** For ids that read poorly, such as `Uncle_Fu`. */
  readonly name?: string;
  readonly file?: SpeechModelStore.ModelFile;
};

type LocalModel = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly recommended?: boolean;
  readonly file: SpeechModelStore.ModelFile;
  /** Whether the model honors the speed option; clients speed up playback for the rest. */
  readonly appliesSpeed: boolean;
  readonly voices: readonly LocalVoice[];
  /** The languages its voices speak, as ISO 639-1 codes. */
  readonly languages: readonly string[];
  /** eSpeak-ng data the model phonemizes with, installed and removed with it. */
  readonly espeakData?: SpeechModelStore.ModelFile;
  /** Cleanup the model's reference implementation applies before it reads text. */
  readonly speakable?: (text: string) => string;
};

const AUDIO_CPP_GGUF = "audio-cpp/audio.cpp-gguf";
const GGUF_REVISION = "7a103b33f04120535bdfe97b5f65b79d3c90d708";
// Each Pocket TTS language ships its own weights and voice files, under the same voice names.
const pocketModel = (
  language: string,
  code: string,
  name: string,
  size: number,
  sha256: string,
  voices: ReadonlyArray<readonly [voice: string, size: number, sha256: string]>,
): LocalModel => ({
  id: `pocket-tts-${language}`,
  name,
  description: "Small, and fast without a GPU.",
  file: {
    id: AUDIO_CPP_GGUF,
    revision: GGUF_REVISION,
    filename: `PocketTTS-GGUF/${language}/pocket-tts-${language}-q8_0.gguf`,
    size,
    sha256,
  },
  appliesSpeed: false,
  languages: [code],
  voices: voices.map(([voice, voiceSize, voiceSha256]) => ({
    id: voice[0]!.toUpperCase() + voice.slice(1),
    file: {
      id: AUDIO_CPP_GGUF,
      revision: GGUF_REVISION,
      filename: `pocket-tts-${language}-${voice}.safetensors`,
      url: `https://huggingface.co/${AUDIO_CPP_GGUF}/resolve/${GGUF_REVISION}/PocketTTS-GGUF/${language}/embeddings/${voice}.safetensors`,
      size: voiceSize,
      sha256: voiceSha256,
    },
  })),
});

// Japanese and Chinese Kokoro voices need the multilingual package's dictionaries.
const KOKORO_VOICES = [
  ...[
    "heart",
    "alloy",
    "aoede",
    "bella",
    "jessica",
    "kore",
    "nicole",
    "nova",
    "river",
    "sarah",
    "sky",
  ].map((name) => `af_${name}`),
  ...["adam", "echo", "eric", "fenrir", "liam", "michael", "onyx", "puck", "santa"].map(
    (name) => `am_${name}`,
  ),
  "bf_alice",
  "bf_emma",
  "bf_isabella",
  "bf_lily",
  "bm_daniel",
  "bm_fable",
  "bm_george",
  "bm_lewis",
  "ef_dora",
  "em_alex",
  "em_santa",
  "ff_siwis",
  "hf_alpha",
  "hf_beta",
  "hm_omega",
  "hm_psi",
  "if_sara",
  "im_nicola",
  "pf_dora",
  "pm_alex",
  "pm_santa",
];

// The first model is the default, and each model's first voice is its default.
const LOCAL_SYNTHESIS_MODELS: readonly LocalModel[] = [
  {
    id: "kokoro-82m",
    name: "Kokoro",
    description: "Natural voices, most of them English.",
    recommended: true,
    file: {
      id: AUDIO_CPP_GGUF,
      revision: GGUF_REVISION,
      filename: "Kokoro-82M-GGUF/kokoro-82m-q8_0.gguf",
      size: 189_550_976,
      sha256: "9a4ca6176460cdc8c7845b804c0bbe85a4791ee3ffff568a3fdadbb708c63f47",
    },
    appliesSpeed: true,
    voices: KOKORO_VOICES.map((id) => ({ id })),
    languages: ["en", "es", "fr", "hi", "it", "pt"],
    espeakData: {
      id: "pingdotgg/audio.cpp",
      revision: AUDIO_CPP_VERSION,
      ...AUDIO_CPP_ESPEAK_DATA,
    },
  },
  {
    id: "qwen3-tts-1.7b",
    name: "Qwen3-TTS 1.7B",
    description:
      "The most natural voices, and the most accurate. Needs a GPU and about 7 GB of memory.",
    recommended: true,
    file: {
      id: AUDIO_CPP_GGUF,
      revision: GGUF_REVISION,
      filename: "Qwen3-TTS-12Hz-1.7B-CustomVoice-GGUF/qwen3-tts-12hz-1.7b-customvoice-q8_0.gguf",
      size: 2_817_055_200,
      sha256: "c8ac3f94b6e73f137c0e7ecc9270bc8faec7a476ff799b87e48844d1d0987ac3",
    },
    appliesSpeed: false,
    // The model's own speakers, English first; each reads every language.
    voices: [
      { id: "Ryan" },
      { id: "Aiden" },
      { id: "Vivian" },
      { id: "Serena" },
      { id: "Uncle_Fu", name: "Uncle Fu" },
      { id: "Dylan" },
      { id: "Eric" },
      { id: "Ono_Anna", name: "Ono Anna" },
      { id: "Sohee" },
    ],
    languages: ["en", "zh", "ja", "ko", "de", "fr", "ru", "pt", "es", "it"],
  },
  {
    id: "supertonic-3",
    name: "Supertonic 3",
    description: "Fastest with a GPU.",
    file: {
      id: AUDIO_CPP_GGUF,
      revision: "ca0b203eb1bb87f333a7cfbad2d5f6672b4ccba7",
      filename: "Supertonic-3-GGUF/supertonic-3-f16.gguf",
      size: 312_785_732,
      sha256: "7a44c47d1f387e4fb163e2eed9615b58470c77e26ac8b2b1a6be49dfb8670899",
    },
    appliesSpeed: true,
    voices: ["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"].map((id) => ({ id })),
    // From the model card.
    languages: [
      "en",
      "ko",
      "ja",
      "ar",
      "bg",
      "cs",
      "da",
      "de",
      "el",
      "es",
      "et",
      "fi",
      "fr",
      "hi",
      "hr",
      "hu",
      "id",
      "it",
      "lt",
      "lv",
      "nl",
      "pl",
      "pt",
      "ro",
      "ru",
      "sk",
      "sl",
      "sv",
      "tr",
      "uk",
      "vi",
    ],
    speakable: supertonicText,
  },
  pocketModel(
    "english",
    "en",
    "Pocket TTS English",
    127_867_968,
    "3f71cf6a51f93c2f2e554e98970a3f49fb9a98d0c64bed5a815e65be3d2ff588",
    [
      ["alba", 6_194_424, "69c32db63ca56843d994f81f343f62e0bf2d73f7e4c9bc73e44bb1110b1d8845"],
      ["anna", 7_816_440, "5ea82f78db006c9fd34e32ddd5aae82674b5b32646097977436458d00af80dfa"],
      ["eve", 6_538_488, "ea9c2faf862a6c9d2cb61910fdf02842ae56940382cc8c1000fdb1b43269692b"],
      ["jane", 7_374_072, "37386227ca8ec5bf1b8e516c13d132ce5ff5437a304fe90129a1c62f41d9a008"],
      ["charles", 6_194_424, "299edc20182eeccfbf94e308626f259da4fbf339daa8d5905218f2b1774639b8"],
      ["george", 6_243_576, "0c1c6c57c55a98d81254b33728150c7776f40647fe95258d1a6c1a02780b5d02"],
      ["michael", 7_275_768, "8937f724ac4719b9aa51ea0ba1f18f9de0af7a663ad6263558266c1a53c9722d"],
      ["paul", 6_980_856, "ed7a019168f94dfe77009f1b0de59387abc6fbb0db954d38ce722ecb77da61aa"],
    ],
  ),
  pocketModel(
    "french",
    "fr",
    "Pocket TTS Français",
    128_117_408,
    "ae7e6d536c20245d216a7ec9404124cf67f913380bf41a6380c55d6ca9dbaef5",
    [
      ["alba", 6_244_152, "4c80b1438668290542068bbc9515abd2c267f4cc86764c6633fcde395d1b2681"],
      ["anna", 7_620_408, "7a7fae31e4b0e16102cb2514f96189cdb57c8403f5f7aba2b37aa942e2d03488"],
      ["eve", 6_145_848, "b642a43b786fb60571656814cc66f9c24f8a457ea9f727903ea97d647d5ceedb"],
      ["jane", 7_325_496, "1482685d8a1a22a7294df650f61293bab353445710e26a60ae057cbf4ad85221"],
      ["charles", 6_195_000, "956942f32745023f512ca99a45514648c8bbf4a4edc5bb5fdcb7c1a5dd5fbf97"],
      ["george", 5_900_088, "b7513caf686418ec303dfd87dc6ddbcc020df9bf5964cb4afcd0b72b602afa6f"],
      ["michael", 7_128_888, "7dc7c44c71e514fcec8203a310676c410b3a68280dd52f6d60c424d51a8b638a"],
      ["paul", 6_833_976, "85d2f623d5de93dbc33b56f7cbdb90bfaf100c1a7a0958848326223bc7cda5ed"],
    ],
  ),
  pocketModel(
    "german",
    "de",
    "Pocket TTS Deutsch",
    127_868_448,
    "d99a966c42026dbe119863ad8a8c96ddd3c8d2e800dfe2ab75a0caa579293268",
    [
      ["alba", 6_194_424, "b5a1933388634f63f0f709d3139f64d3c78281160d4a3bf6ea3bd1abc3ba94b6"],
      ["anna", 7_816_440, "6aa8e46421e4a8a602976918ed407fde55e7603b313acbe2e4432905b8bee7bc"],
      ["eve", 6_538_488, "223f60a58a28236b27ca361e01f182fb919e72f0e3dceffb3bf18f006a0d0097"],
      ["jane", 7_374_072, "4572c0d06ce058ecb4f54d5059dcb872b3084d0cef95958faaf73bd4e1ccaf28"],
      ["charles", 6_194_424, "c8bbc4a0e46cd0f16df2aaed7dfe811a0ca2d93799837ca4200851db906530b4"],
      ["george", 6_243_576, "bb0ecc9d5524fe64102f44c190be74d2dbee33bcf51f44dbb16e9b6b046496e1"],
      ["michael", 7_275_768, "6a491e111f277fab05bc05696691d621fd0847ae3b3be9271beb64453970d0f2"],
      ["paul", 6_980_856, "3f74b464af87e9f8ee59895d806d6a2a05b5e7c345491d03177a92bc66a0eede"],
    ],
  ),
  pocketModel(
    "italian",
    "it",
    "Pocket TTS Italiano",
    127_868_704,
    "aa25eb6c0d73fa90a26c07ed5453f44c321ff483b33e96e5c3693b6f76ef9149",
    [
      ["alba", 6_194_424, "7d2bd2e5df41e5ede229857bcc2b56d41856725465260c330ba847e8a945442c"],
      ["anna", 7_816_440, "2d1bb064780b6b3c4a77a336c51335fde6dd07b506ccf329d2d0872ad6327c5f"],
      ["eve", 6_538_488, "6bd49ded51178b6a388bfad57360d4f3b795f89fa7155923efbd968405f01c9f"],
      ["jane", 7_374_072, "56bcf13e73c2143ab431e59be4d4b67ef0cb086ce63626f290a5edcbd1c3fa7f"],
      ["charles", 6_194_424, "1e4b6dafd17e0bb4489590f821f7083b598bd0dbe6d93bcabc8b72bb383881d5"],
      ["george", 6_243_576, "c54fd34b252255f61f007fda923d8cb33b3f960b4806335ace0a74c2227a878d"],
      ["michael", 7_275_768, "3a52c4eb205affd8da5b8d8d2e384328b258f6652f2ad170311bb28f5cdab714"],
      ["paul", 6_980_856, "c0a1913b9bf224d61d15562c3f1ff778e6ecfb77432c998ce785b3c04a19d9a0"],
    ],
  ),
  pocketModel(
    "portuguese",
    "pt",
    "Pocket TTS Português",
    127_869_632,
    "e6e76fde1770586b11fab5a7d4fa07006d911098718991e242ca6006bd0513cd",
    [
      ["alba", 6_194_424, "855b277ffa0e1f1600acacdb72f4e8609af7db7bbb5236dd904d1472c27541d2"],
      ["anna", 7_816_440, "70ef78480c1d90f502826c10b0512effa34262453e22a76d5992d5fa1e8182bb"],
      ["eve", 6_538_488, "c3d3526bdf0d4f82a3e6cc8bca62148a20c69bbe6596fb72920478688f378488"],
      ["jane", 7_374_072, "de8f3516290a8f554785366cd2ce5dac1ad6abf694b6d37a41553b092eeb508e"],
      ["charles", 6_194_424, "e643bddfba4c1c302f0589c09a18ac553af9fa2c7e82109e12a1a89225dd06bb"],
      ["george", 6_243_576, "f727f2820a343dc8cb0f867478e8feae9ecc8da41d6a84e6e051f1c192d20bb4"],
      ["michael", 7_275_768, "d9348313f6e9d7badd420cffac11a59dc5767eeeccc7a679f8cfaaffecce7f2c"],
      ["paul", 6_980_856, "ce48b67d732704f38985b38f5d5dea54175fa5bca795379cad0cffd55e534668"],
    ],
  ),
  pocketModel(
    "spanish",
    "es",
    "Pocket TTS Español",
    127_869_504,
    "d2645064c191d0b9b8daf6d24d2b8a310d89f694c9b3523c1258bc9455adcaff",
    [
      ["alba", 6_194_424, "694be334ed6dda508b125e22a6ae480036d1c99923cccd92a643a348867f3235"],
      ["anna", 7_816_440, "fe964cdad79e8c2c0d2ca30bc9dc8479c6f38b45b77512975a6e272109367337"],
      ["eve", 6_538_488, "3fdb6a2ddd06f339b015ec90aea2ea004c260fe463c9526e020249b307096a41"],
      ["jane", 7_374_072, "1bf9bfe3172412c44d0c7227e49eeb40b060f6833e2f6f365f0bbcde757afd09"],
      ["charles", 6_194_424, "d620942926b0a30dcf002212221c89bb4f3b8b9b9bd2cc7d034c5e1c792a675f"],
      ["george", 6_243_576, "da140d63300c46c31b49ec26402a0b4efed5d773da8310cf4ccca115853cdc87"],
      ["michael", 7_275_768, "ca3dfdaff6a2bf70ef9b2ab69bc66dce6d16fb06d4d7473be92610d3e43e9e15"],
      ["paul", 6_980_856, "fcd677f0459352f7cdf62d7a1424a663bd49fc8921fb2b8e346ef9b45c92dd04"],
    ],
  ),
  {
    id: "m5-tts-50m",
    name: "M5-TTS",
    description: "One voice, made for Chinese. Smaller than Qwen3-TTS.",
    file: {
      id: AUDIO_CPP_GGUF,
      revision: GGUF_REVISION,
      filename: "M5-TTS-GGUF/m5-tts-50m-customvoice-q8_0.gguf",
      size: 938_645_536,
      sha256: "e73662b226ffcb3493e6d627fcdc6b53ee43d965e48e5490f99b7dd6c1fd82aa",
    },
    appliesSpeed: false,
    voices: [{ id: "1" }],
    languages: ["zh", "en", "de", "fr", "ja", "ko"],
  },
];

const modelFiles = (model: LocalModel) => [
  model.file,
  ...model.voices.flatMap((voice) => (voice.file ? [voice.file] : [])),
  ...(model.espeakData ? [model.espeakData] : []),
];
const totalSize = (files: readonly SpeechModelStore.ModelFile[]) =>
  files.reduce((size, file) => size + file.size, 0);

const IDLE_UNLOAD_MS = 10 * 60_000;

export class LocalSynthesisInstallError extends Schema.TaggedError<LocalSynthesisInstallError>()(
  "LocalSynthesisInstallError",
  {
    reason: Schema.Literals([
      "unknown-model",
      "unsupported-platform",
      "busy",
      "not-found",
      "failed",
    ]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export class LocalSpeechSynthesis extends Context.Service<
  LocalSpeechSynthesis,
  {
    readonly catalog: Effect.Effect<SpeechSynthesisCatalog>;
    /** Resolves when the install finishes or is cancelled; poll `catalog` for progress. */
    readonly download: (
      modelId: string,
    ) => Effect.Effect<SpeechSynthesisCatalog, LocalSynthesisInstallError>;
    readonly cancel: (modelId: string) => Effect.Effect<SpeechSynthesisCatalog>;
    /** Loads an installed model ahead of playback, so the first reply starts sooner. */
    readonly prepare: (modelId: string) => Effect.Effect<void>;
    /** Uses model files already on this machine, from a file or a folder to search. */
    readonly link: (
      source: string,
    ) => Effect.Effect<SpeechSynthesisCatalog, LocalSynthesisInstallError>;
    /** Removes the model, and the shared runtime once no installed model needs it. */
    readonly remove: (
      modelId: string,
    ) => Effect.Effect<SpeechSynthesisCatalog, LocalSynthesisInstallError>;
    /** MP3 and its PCM, delivered as each text chunk is synthesized. Stopping early cancels synthesis. */
    readonly stream: (
      request: SpeechSynthesisRequest,
    ) => Stream.Stream<SpeechSynthesisPart, SpeechSynthesisError>;
  }
>()("t3/speech/LocalSpeechSynthesis") {}

/** Picks the language a model declares for a setting such as `en-US`; `auto` picks none. */
export function localSynthesisLanguage(setting: string, languages: readonly string[]) {
  const wanted = setting.toLowerCase();
  return (
    languages.find((language) => language.toLowerCase() === wanted) ??
    languages.find((language) => language.toLowerCase() === wanted.split("-")[0])
  );
}

const atLeast = (version: string, minimum: string) => {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  const [wantedMajor = 0, wantedMinor = 0] = minimum.split(".").map(Number);
  return major > wantedMajor || (major === wantedMajor && minor >= wantedMinor);
};

/** The audio.cpp build a host installs, or why it cannot run local speech models. */
export function localSynthesisRuntime(host: {
  readonly platform: string;
  readonly architecture: string;
  readonly libc: "gnu" | "musl" | undefined;
  readonly glibc: string | undefined;
}): { readonly runtime?: AudioCppRuntime; readonly error?: string } {
  // Independent of dictation's platform list: the speech builds cover hosts transcribe-cpp does not.
  const runtime =
    host.platform !== "linux" || host.libc === "gnu"
      ? audioCppRuntime(host.platform, host.architecture)
      : undefined;
  if (!runtime)
    return {
      error: `Local speech models are not available on ${host.platform}-${host.architecture}.`,
    };
  if (runtime.minimumGlibc && !(host.glibc && atLeast(host.glibc, runtime.minimumGlibc)))
    return {
      error: `Local speech models need glibc ${runtime.minimumGlibc} or newer. This environment has glibc ${host.glibc ?? "unknown"}.`,
    };
  return { runtime };
}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const store = yield* SpeechModelStore.SpeechModelStore;
  const config = yield* ServerConfig.ServerConfig;
  const scope = yield* Effect.scope;
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;
  const { runtime, error: unavailable } = localSynthesisRuntime({
    platform,
    architecture,
    libc: platform === "linux" ? yield* HostProcess.LinuxLibc : undefined,
    glibc: platform === "linux" ? yield* HostProcess.GlibcVersion : undefined,
  });
  const runtimeFile = runtime && {
    id: "pingdotgg/audio.cpp",
    revision: AUDIO_CPP_VERSION,
    filename: runtime.filename,
    url: runtime.url,
    size: runtime.size,
    sha256: runtime.sha256,
  };
  const runtimeDirectory = path.join(
    config.stateDir,
    "speech",
    "runtime",
    `audio-cpp-${AUDIO_CPP_VERSION}-${platform}-${architecture}`,
  );
  const libraryPath = runtime && path.join(runtimeDirectory, runtime.library);
  // audio.cpp unpacks eSpeak's data package here on first use.
  const espeakCache = path.join(config.stateDir, "speech", "cache");
  // Written last, so a directory without it is an interrupted extraction.
  const completeMarker = path.join(runtimeDirectory, ".t3-complete");

  const runtimeReady = Effect.gen(function* () {
    if (!libraryPath) return false;
    return (yield* fs.exists(completeMarker)) && (yield* fs.exists(libraryPath));
  }).pipe(Effect.orElseSucceed(() => false));

  // System tar reads .tar.gz on macOS and Linux and .zip on Windows 10 and later.
  const extract = Effect.fn("LocalSpeechSynthesis.extract")(function* (
    library: string,
    archivePath: string,
  ) {
    const staging = `${runtimeDirectory}.${yield* random.uuidV4()}.part`;
    yield* fs.makeDirectory(staging, { recursive: true });
    yield* Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make("tar", ["-xf", archivePath, "-C", staging], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
      );
      const exitCode = yield* child.exitCode;
      if (exitCode !== 0 || !(yield* fs.exists(path.join(staging, library))))
        return yield* new LocalSynthesisInstallError({
          reason: "failed",
          cause: `tar exited with ${exitCode} or the archive has no library.`,
        });
      yield* fs.writeFileString(path.join(staging, ".t3-complete"), AUDIO_CPP_VERSION);
      yield* fs.remove(runtimeDirectory, { recursive: true, force: true });
      yield* fs.rename(staging, runtimeDirectory);
      // Runtimes from earlier releases for this platform; nothing loads them again.
      const parent = path.dirname(runtimeDirectory);
      for (const name of yield* fs.readDirectory(parent).pipe(Effect.orElseSucceed(() => []))) {
        const entry = path.join(parent, name);
        if (
          entry !== runtimeDirectory &&
          name.startsWith("audio-cpp-") &&
          name.endsWith(`-${platform}-${architecture}`)
        )
          yield* fs.remove(entry, { recursive: true, force: true }).pipe(Effect.ignore);
      }
    }).pipe(
      Effect.scoped,
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore),
      ),
    );
  });

  type Transfer = {
    readonly modelId: string;
    /** Fixed once the install knows which files it needs, so finishing one does not shrink it. */
    size: number;
    runtime: number;
    model: number;
    verifying: boolean;
    fiber?: Fiber.Fiber<void, unknown>;
  };
  let transfer: Transfer | undefined;
  // A removal deletes the shared runtime and a link replaces model files, so neither may
  // overlap an install or each other.
  let changing = false;

  const catalog = Effect.gen(function* () {
    const ready = yield* runtimeReady;
    const runtimeSize = ready || !runtimeFile ? 0 : runtimeFile.size;
    const models = yield* Effect.forEach(LOCAL_SYNTHESIS_MODELS, (model) =>
      Effect.gen(function* () {
        const active = transfer?.modelId === model.id ? transfer : undefined;
        const files = modelFiles(model);
        const missing = yield* Effect.filter(files, (file) =>
          store.isReady(file).pipe(Effect.map((fileReady) => !fileReady)),
        );
        const installed = ready && missing.length === 0;
        const linkedFrom = installed ? yield* store.linkedFrom(model.file) : undefined;
        const install = active
          ? {
              state: active.verifying ? ("verifying" as const) : ("downloading" as const),
              size: active.size,
              downloaded: active.runtime + active.model,
            }
          : installed
            ? {
                state: "installed" as const,
                size: totalSize(files),
                ...(linkedFrom && { linkedFrom }),
              }
            : { state: "downloadable" as const, size: totalSize(missing) + runtimeSize };
        return {
          id: model.id,
          name: model.name,
          description: model.description,
          voices: model.voices.map((voice) => voice.id),
          ...(model.voices.some((voice) => voice.name) && {
            voiceNames: Object.fromEntries(
              model.voices.flatMap((voice) => (voice.name ? [[voice.id, voice.name]] : [])),
            ),
          }),
          languages: model.languages,
          ...(model.recommended && { recommended: true }),
          install,
          ...(model.appliesSpeed ? {} : { speedAppliedByProvider: false }),
        };
      }),
    );
    return {
      defaultModel: LOCAL_SYNTHESIS_MODELS[0]!.id,
      apiKeyProvider: null,
      supportsModelSelection: LOCAL_SYNTHESIS_MODELS.length > 1,
      supportsVoiceSelection: true,
      speedAppliedByProvider: true,
      models,
      ...(unavailable ? { error: unavailable } : {}),
    } satisfies SpeechSynthesisCatalog;
  });

  const installFailed = (cause: unknown) =>
    new LocalSynthesisInstallError({ reason: "failed", cause });
  const findModel = (modelId: string) =>
    Effect.fromNullishOr(LOCAL_SYNTHESIS_MODELS.find((model) => model.id === modelId)).pipe(
      Effect.mapError(() => new LocalSynthesisInstallError({ reason: "unknown-model" })),
    );

  // Publishes the transfer before forking: a cached file can finish before forkIn returns.
  const reserve = Effect.fn("LocalSpeechSynthesis.reserve")(function* (modelId: string) {
    const model = yield* findModel(modelId);
    if (!runtimeFile || !runtime)
      return yield* new LocalSynthesisInstallError({ reason: "unsupported-platform" });
    // Checked and claimed without yielding, so a concurrent download or removal cannot interleave.
    if (changing || (transfer && transfer.modelId !== modelId))
      return yield* new LocalSynthesisInstallError({ reason: "busy" });
    if (!transfer) {
      const state: Transfer = {
        modelId,
        size: totalSize(modelFiles(model)),
        runtime: 0,
        model: 0,
        verifying: false,
      };
      transfer = state;
      const install = Effect.gen(function* () {
        // Read after claiming: no removal or link can start while this transfer exists.
        const needsRuntime = !(yield* runtimeReady);
        const files = modelFiles(model);
        const missing = yield* Effect.filter(files, (file) =>
          store.isReady(file).pipe(Effect.map((fileReady) => !fileReady)),
        );
        state.size = (needsRuntime ? runtimeFile.size : 0) + totalSize(missing);
        if (needsRuntime) {
          const archivePath = yield* store.download(runtimeFile, {
            onProgress: (downloaded) => {
              state.runtime = downloaded;
              state.verifying = false;
            },
            onVerificationStart: () => {
              state.verifying = true;
            },
          });
          state.verifying = true;
          yield* extract(runtime.library, archivePath);
          yield* store.remove(runtimeFile).pipe(Effect.ignore);
          state.runtime = runtimeFile.size;
        }
        state.verifying = false;
        // Files already in place still go through `download`, which verifies them.
        let finished = 0;
        for (const file of files) {
          const counted = missing.includes(file);
          yield* store.download(file, {
            onProgress: (downloaded) => {
              if (counted) state.model = finished + downloaded;
              state.verifying = false;
            },
            onVerificationStart: () => {
              state.verifying = true;
            },
          });
          if (counted) finished += file.size;
        }
      });
      // Owned by the service, so a dropped request does not abandon a large download.
      state.fiber = yield* install.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (transfer === state) transfer = undefined;
          }),
        ),
        Effect.forkIn(scope),
      );
    }
    return transfer.fiber!;
  }, Effect.uninterruptible);

  const download = Effect.fn("LocalSpeechSynthesis.download")(function* (modelId: string) {
    const exit = yield* Fiber.await(yield* reserve(modelId));
    if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause))
      return yield* installFailed(Cause.squash(exit.cause));
    return yield* catalog;
  });

  const cancel = Effect.fn("LocalSpeechSynthesis.cancel")(function* (modelId: string) {
    const fiber = transfer?.modelId === modelId ? transfer.fiber : undefined;
    if (fiber) yield* Fiber.interrupt(fiber);
    return yield* catalog;
  });

  // One native request at a time; the worker process holds a single loaded model.
  const permit = yield* Semaphore.make(1);
  let worker: { readonly modelId: string; readonly model: LocalSynthesisModel } | undefined;
  // @effect-diagnostics-next-line abortControllerInEffect:off - The cached worker must also stop on service shutdown.
  const lifetime = new AbortController();
  const unloadWorker = Effect.promise(async () => {
    const current = worker;
    worker = undefined;
    await current?.model.dispose();
  });
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => lifetime.abort()).pipe(Effect.andThen(unloadWorker)),
  );
  const idleDeadlines = yield* Queue.sliding<void>(1);
  yield* Stream.fromQueue(idleDeadlines).pipe(
    Stream.switchMap(() =>
      Stream.fromEffect(
        Effect.sleep(IDLE_UNLOAD_MS).pipe(Effect.andThen(permit.withPermits(1)(unloadWorker))),
      ),
    ),
    Stream.runDrain,
    Effect.forkScoped,
  );

  // Claimed without yielding, so a download, removal, or link cannot interleave.
  const exclusive = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.acquireUseRelease(
      Effect.suspend(() => {
        if (transfer || changing) return new LocalSynthesisInstallError({ reason: "busy" });
        changing = true;
        return Effect.void;
      }),
      () => effect,
      () =>
        Effect.sync(() => {
          changing = false;
        }),
    );

  const link = Effect.fn("LocalSpeechSynthesis.link")(function* (source: string) {
    if (!runtimeFile)
      return yield* new LocalSynthesisInstallError({ reason: "unsupported-platform" });
    const linked = yield* exclusive(
      store
        .link(LOCAL_SYNTHESIS_MODELS.flatMap(modelFiles), source)
        .pipe(Effect.mapError(installFailed)),
    );
    // File ids name repositories, which several models share.
    const isLinked = (file: SpeechModelStore.ModelFile) =>
      linked.some((entry) => entry.filename === file.filename);
    const owners = LOCAL_SYNTHESIS_MODELS.filter((model) => modelFiles(model).some(isLinked));
    const model = owners.find((entry) => isLinked(entry.file)) ?? owners[0];
    if (!model) return yield* new LocalSynthesisInstallError({ reason: "not-found" });
    const missing = yield* Effect.filter(modelFiles(model), (file) =>
      store.isReady(file).pipe(Effect.map((fileReady) => !fileReady)),
    );
    if ((yield* runtimeReady) && missing.length === 0) return yield* catalog;
    // The model file is in place; an install fetches only the runtime and voices it lacks.
    return yield* download(model.id);
  });

  const remove = Effect.fn("LocalSpeechSynthesis.remove")(function* (modelId: string) {
    const model = yield* findModel(modelId);
    yield* exclusive(
      permit.withPermits(1)(
        Effect.gen(function* () {
          if (worker?.modelId === modelId) yield* unloadWorker;
          yield* Effect.forEach(modelFiles(model), (file) => store.remove(file)).pipe(
            Effect.mapError(installFailed),
          );
          if (model.espeakData)
            yield* fs
              .remove(espeakCache, { recursive: true, force: true })
              .pipe(Effect.mapError(installFailed));
          const remaining = yield* Effect.filter(LOCAL_SYNTHESIS_MODELS, (entry) =>
            store.isReady(entry.file),
          );
          if (remaining.length === 0)
            yield* fs
              .remove(runtimeDirectory, { recursive: true, force: true })
              .pipe(Effect.mapError(installFailed));
        }),
      ),
    );
    return yield* catalog;
  });

  const failure = (reason: SpeechSynthesisError["reason"], cause?: unknown) =>
    new SpeechSynthesisError({
      provider: "local",
      reason,
      ...(cause === undefined ? {} : { cause }),
    });

  const findDefinition = (modelId: string) =>
    LOCAL_SYNTHESIS_MODELS.find((model) => model.id === (modelId || LOCAL_SYNTHESIS_MODELS[0]!.id));

  // The verified model and eSpeak files, or undefined while any is missing.
  const loadablePaths = Effect.fnUntraced(function* (definition: LocalModel) {
    if (!(yield* runtimeReady)) return undefined;
    const modelPath = yield* store.installedPath(definition.file);
    const espeakPath = definition.espeakData && (yield* store.installedPath(definition.espeakData));
    if (!modelPath || (definition.espeakData && !espeakPath)) return undefined;
    return { modelPath, espeakPath };
  });

  // Callers hold the permit, so one model loads at a time and synthesis waits for it.
  const ensureWorker = Effect.fnUntraced(function* (
    definition: LocalModel,
    paths: { readonly modelPath: string; readonly espeakPath: string | undefined },
  ) {
    if (!runtime || !libraryPath) return yield* failure("unavailable");
    if (worker?.model.alive && worker.modelId === definition.id) return worker.model;
    yield* unloadWorker;
    // Uninterruptible, so a stream stopped mid-load still records the process it started.
    const loaded = yield* Effect.tryPromise({
      try: () =>
        loadLocalSynthesisModel({
          libraryPath,
          backend: runtime.backend,
          modelPath: paths.modelPath,
          ...(paths.espeakPath && {
            env: { AUDIOCPP_ESPEAK_DATA: paths.espeakPath, AUDIOCPP_ESPEAK_CACHE: espeakCache },
          }),
          threads: Math.max(1, Math.min(8, NodeOS.availableParallelism() - 1)),
          signal: lifetime.signal,
        }),
      catch: (cause) => failure("unavailable", cause),
    }).pipe(
      Effect.tap((model) =>
        Effect.sync(() => {
          worker = { modelId: definition.id, model };
        }),
      ),
      Effect.uninterruptible,
    );
    yield* Effect.logInfo("Loaded the local speech model.", { backend: loaded.backend });
    return loaded;
  });

  const prepare = Effect.fn("LocalSpeechSynthesis.prepare")(function* (modelId: string) {
    const definition = findDefinition(modelId);
    if (!definition || (worker?.model.alive && worker.modelId === definition.id)) return;
    const paths = yield* loadablePaths(definition);
    if (!paths) return;
    yield* permit
      .withPermits(1)(ensureWorker(definition, paths))
      .pipe(
        Effect.andThen(Effect.sync(() => Queue.offerUnsafe(idleDeadlines, undefined))),
        Effect.catchTags({
          SpeechSynthesisError: (error) =>
            Effect.logWarning("Local speech model failed to load.", error),
        }),
      );
  });

  // Untraced: it runs inside the stream's own span.
  const speak = Effect.fnUntraced(function* (
    request: SpeechSynthesisRequest,
    queue: Queue.Queue<SpeechSynthesisPart, SpeechSynthesisError | Cause.Done>,
  ) {
    if (!runtime || !libraryPath) return yield* failure("unavailable");
    const definition = findDefinition(request.model);
    if (!definition) return yield* failure("model-unavailable");
    const paths = yield* loadablePaths(definition);
    const voice =
      definition.voices.find((entry) => entry.id === request.voice) ?? definition.voices[0]!;
    const voicePath = voice.file && (yield* store.installedPath(voice.file));
    if (!paths || (voice.file && !voicePath)) return yield* failure("missing-model");
    // Held until the stream ends, after any cancelled synthesis has stopped.
    // Interruptible, so a request abandoned while waiting stops waiting.
    yield* Effect.acquireRelease(
      Semaphore.take(permit, 1),
      () =>
        Semaphore.release(permit, 1).pipe(
          Effect.andThen(Effect.sync(() => Queue.offerUnsafe(idleDeadlines, undefined))),
        ),
      { interruptible: true },
    );
    const model = yield* ensureWorker(definition, paths);
    const language = localSynthesisLanguage(request.language, model.languages);
    // One encoder spans the whole reply, so PCM time is MP3 time.
    let spokenSeconds = 0;
    const spoken = model
      .stream(
        {
          text: definition.speakable?.(request.text) ?? request.text,
          ...(language ? { language } : {}),
          options: {
            ...(voicePath ? { voice_embedding_file: voicePath } : { voice_id: voice.id }),
            ...(definition.appliesSpeed ? { speed: String(request.speed) } : {}),
          },
        },
        (bytes) => Queue.offerUnsafe(queue, bytes),
        (pcm, rate) => {
          Queue.offerUnsafe(queue, { pcm, rate, startSeconds: spokenSeconds });
          spokenSeconds += pcm.length / rate;
        },
      )
      .then(
        () => Queue.endUnsafe(queue),
        (cause) => Queue.failCauseUnsafe(queue, Cause.fail(failure("unavailable", cause))),
      );
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => {
        model.cancel();
        return spoken;
      }),
    );
  });

  const stream = (request: SpeechSynthesisRequest) =>
    Stream.callback<SpeechSynthesisPart, SpeechSynthesisError>((queue) =>
      speak(request, queue),
    ).pipe(
      Stream.tapError((error) =>
        error.reason === "unavailable"
          ? Effect.logWarning("Local speech synthesis failed.", error)
          : Effect.void,
      ),
      Stream.withSpan("LocalSpeechSynthesis.stream"),
    );

  return LocalSpeechSynthesis.of({ catalog, download, cancel, link, remove, prepare, stream });
});

export const layer = Layer.effect(LocalSpeechSynthesis, make);
