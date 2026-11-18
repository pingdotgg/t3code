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
import { loadLocalSynthesisModel, type LocalSynthesisModel } from "./localSynthesisWorker.ts";

/** A preset the model names itself, or one it reads from its own file. */
type LocalVoice = { readonly id: string; readonly file?: SpeechModelStore.ModelFile };

type LocalModel = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly file: SpeechModelStore.ModelFile;
  /** Whether the model honors the speed option; clients speed up playback for the rest. */
  readonly appliesSpeed: boolean;
  readonly voices: readonly LocalVoice[];
  /** eSpeak-ng data the model phonemizes with, installed and removed with it. */
  readonly espeakData?: SpeechModelStore.ModelFile;
};

const AUDIO_CPP_GGUF = "audio-cpp/audio.cpp-gguf";
const GGUF_REVISION = "7a103b33f04120535bdfe97b5f65b79d3c90d708";
// Named per model, since every Pocket TTS language ships voice files with the same names.
const pocketVoice = (name: string, size: number, sha256: string): LocalVoice => ({
  id: name[0]!.toUpperCase() + name.slice(1),
  file: {
    id: AUDIO_CPP_GGUF,
    revision: GGUF_REVISION,
    filename: `pocket-tts-english-${name}.safetensors`,
    url: `https://huggingface.co/${AUDIO_CPP_GGUF}/resolve/${GGUF_REVISION}/PocketTTS-GGUF/english/embeddings/${name}.safetensors`,
    size,
    sha256,
  },
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
    description: "Natural English voices, plus Spanish, French, Hindi, Italian, and Portuguese.",
    file: {
      id: AUDIO_CPP_GGUF,
      revision: GGUF_REVISION,
      filename: "Kokoro-82M-GGUF/kokoro-82m-q8_0.gguf",
      size: 189_550_976,
      sha256: "9a4ca6176460cdc8c7845b804c0bbe85a4791ee3ffff568a3fdadbb708c63f47",
    },
    appliesSpeed: true,
    voices: KOKORO_VOICES.map((id) => ({ id })),
    espeakData: {
      id: "pingdotgg/audio.cpp",
      revision: AUDIO_CPP_VERSION,
      ...AUDIO_CPP_ESPEAK_DATA,
    },
  },
  {
    id: "supertonic-3",
    name: "Supertonic 3",
    description: "31 languages. Fastest with a GPU.",
    file: {
      id: AUDIO_CPP_GGUF,
      revision: "ca0b203eb1bb87f333a7cfbad2d5f6672b4ccba7",
      filename: "Supertonic-3-GGUF/supertonic-3-f16.gguf",
      size: 312_785_732,
      sha256: "7a44c47d1f387e4fb163e2eed9615b58470c77e26ac8b2b1a6be49dfb8670899",
    },
    appliesSpeed: true,
    voices: ["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"].map((id) => ({ id })),
  },
  {
    id: "pocket-tts-english",
    name: "Pocket TTS",
    description: "English only. Small, and fast without a GPU.",
    file: {
      id: AUDIO_CPP_GGUF,
      revision: GGUF_REVISION,
      filename: "PocketTTS-GGUF/english/pocket-tts-english-q8_0.gguf",
      size: 127_867_968,
      sha256: "3f71cf6a51f93c2f2e554e98970a3f49fb9a98d0c64bed5a815e65be3d2ff588",
    },
    appliesSpeed: false,
    voices: [
      pocketVoice(
        "alba",
        6_194_424,
        "69c32db63ca56843d994f81f343f62e0bf2d73f7e4c9bc73e44bb1110b1d8845",
      ),
      pocketVoice(
        "anna",
        7_816_440,
        "5ea82f78db006c9fd34e32ddd5aae82674b5b32646097977436458d00af80dfa",
      ),
      pocketVoice(
        "eve",
        6_538_488,
        "ea9c2faf862a6c9d2cb61910fdf02842ae56940382cc8c1000fdb1b43269692b",
      ),
      pocketVoice(
        "jane",
        7_374_072,
        "37386227ca8ec5bf1b8e516c13d132ce5ff5437a304fe90129a1c62f41d9a008",
      ),
      pocketVoice(
        "charles",
        6_194_424,
        "299edc20182eeccfbf94e308626f259da4fbf339daa8d5905218f2b1774639b8",
      ),
      pocketVoice(
        "george",
        6_243_576,
        "0c1c6c57c55a98d81254b33728150c7776f40647fe95258d1a6c1a02780b5d02",
      ),
      pocketVoice(
        "michael",
        7_275_768,
        "8937f724ac4719b9aa51ea0ba1f18f9de0af7a663ad6263558266c1a53c9722d",
      ),
      pocketVoice(
        "paul",
        6_980_856,
        "ed7a019168f94dfe77009f1b0de59387abc6fbb0db954d38ce722ecb77da61aa",
      ),
    ],
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
    /** MP3, delivered as each text chunk is synthesized. Stopping early cancels synthesis. */
    readonly stream: (
      request: SpeechSynthesisRequest,
    ) => Stream.Stream<Uint8Array, SpeechSynthesisError>;
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
    const linkedBefore = yield* Effect.forEach(LOCAL_SYNTHESIS_MODELS, (model) =>
      store.isReady(model.file),
    );
    const linked = yield* exclusive(
      store
        .link(LOCAL_SYNTHESIS_MODELS.flatMap(modelFiles), source)
        .pipe(Effect.mapError(installFailed)),
    );
    const linkedAfter = yield* Effect.forEach(LOCAL_SYNTHESIS_MODELS, (model) =>
      store.isReady(model.file),
    );
    const model = linked.length
      ? (LOCAL_SYNTHESIS_MODELS.find((_, index) => linkedAfter[index] && !linkedBefore[index]) ??
        LOCAL_SYNTHESIS_MODELS.find((_, index) => linkedAfter[index]))
      : undefined;
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
    queue: Queue.Queue<Uint8Array, SpeechSynthesisError | Cause.Done>,
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
    const spoken = model
      .stream(
        {
          text: request.text,
          ...(language ? { language } : {}),
          options: {
            ...(voicePath ? { voice_embedding_file: voicePath } : { voice_id: voice.id }),
            ...(definition.appliesSpeed ? { speed: String(request.speed) } : {}),
          },
        },
        (bytes) => Queue.offerUnsafe(queue, bytes),
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
    Stream.callback<Uint8Array, SpeechSynthesisError>((queue) => speak(request, queue)).pipe(
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
