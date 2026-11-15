// @effect-diagnostics nodeBuiltinImport:off - worker parallelism comes from the host's CPU count.
import * as NodeOS from "node:os";
import {
  SpeechSynthesisError,
  type SpeechSynthesisCatalog,
  type SpeechSynthesisRequest,
} from "@t3tools/contracts";
import { AUDIO_CPP_VERSION, audioCppRuntimes, type AudioCppRuntime } from "@t3tools/audio-cpp";
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
import { isSpeechPlatformSupported } from "./platform.ts";
import * as SpeechModelStore from "./SpeechModelStore.ts";
import { loadLocalSynthesisModel, type LocalSynthesisModel } from "./localSynthesisWorker.ts";

type LocalModel = {
  readonly id: string;
  readonly name: string;
  readonly file: SpeechModelStore.ModelFile;
  readonly voices: readonly string[];
};

// Families that phonemize with eSpeak-ng (Kokoro, Kitten, Piper) need a GPL library that
// upstream does not ship, so only self-contained models belong here.
const LOCAL_SYNTHESIS_MODELS: readonly LocalModel[] = [
  {
    id: "supertonic-3",
    name: "Supertonic 3",
    file: {
      id: "audio-cpp/audio.cpp-gguf",
      revision: "ca0b203eb1bb87f333a7cfbad2d5f6672b4ccba7",
      filename: "Supertonic-3-GGUF/supertonic-3-f16.gguf",
      size: 312_785_732,
      sha256: "7a44c47d1f387e4fb163e2eed9615b58470c77e26ac8b2b1a6be49dfb8670899",
    },
    voices: ["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"],
  },
];

const IDLE_UNLOAD_MS = 10 * 60_000;

export class LocalSynthesisInstallError extends Schema.TaggedError<LocalSynthesisInstallError>()(
  "LocalSynthesisInstallError",
  {
    reason: Schema.Literals(["unknown-model", "unsupported-platform", "busy", "failed"]),
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

/** The audio.cpp builds a host installs, or why it cannot run local speech models. */
export function localSynthesisRuntimes(host: {
  readonly platform: string;
  readonly architecture: string;
  readonly libc: "gnu" | "musl" | undefined;
  readonly glibc: string | undefined;
}): { readonly runtimes: readonly AudioCppRuntime[]; readonly error?: string } {
  const runtimes = isSpeechPlatformSupported(host.platform, host.architecture, host.libc)
    ? audioCppRuntimes(host.platform, host.architecture)
    : [];
  if (!runtimes.length)
    return {
      runtimes,
      error: `Local speech models are not available on ${host.platform}-${host.architecture}.`,
    };
  const minimum = runtimes.find((runtime) => runtime.minimumGlibc)?.minimumGlibc;
  if (minimum && !(host.glibc && atLeast(host.glibc, minimum)))
    return {
      runtimes: [],
      error: `Local speech models need glibc ${minimum} or newer, such as Ubuntu 26.04. This environment has glibc ${host.glibc ?? "unknown"}.`,
    };
  return { runtimes };
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
  const { runtimes, error: unavailable } = localSynthesisRuntimes({
    platform,
    architecture,
    libc: platform === "linux" ? yield* HostProcess.LinuxLibc : undefined,
    glibc: platform === "linux" ? yield* HostProcess.GlibcVersion : undefined,
  });
  const runtimeRoot = path.join(
    config.stateDir,
    "speech",
    "runtime",
    `audio-cpp-${AUDIO_CPP_VERSION}-${platform}-${architecture}`,
  );
  const installs = runtimes.map((runtime) => {
    const directory = path.join(runtimeRoot, runtime.backend);
    return {
      runtime,
      file: {
        id: "0xShug0/audio.cpp",
        revision: AUDIO_CPP_VERSION,
        filename: runtime.filename,
        url: runtime.url,
        size: runtime.size,
        sha256: runtime.sha256,
      },
      directory,
      libraryPath: path.join(directory, runtime.library),
      // Written last, so a directory without it is an interrupted extraction.
      completeMarker: path.join(directory, ".t3-complete"),
    };
  });
  type RuntimeInstall = (typeof installs)[number];

  const missingRuntimes = Effect.filter(installs, (install) =>
    Effect.gen(function* () {
      return !(
        (yield* fs.exists(install.completeMarker)) && (yield* fs.exists(install.libraryPath))
      );
    }).pipe(Effect.orElseSucceed(() => true)),
  );

  // System tar reads .tar.gz on macOS and Linux and .zip on Windows 10 and later.
  const extract = Effect.fn("LocalSpeechSynthesis.extract")(function* (
    install: RuntimeInstall,
    archivePath: string,
  ) {
    const staging = `${install.directory}.${yield* random.uuidV4()}.part`;
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
      if (exitCode !== 0 || !(yield* fs.exists(path.join(staging, install.runtime.library))))
        return yield* new LocalSynthesisInstallError({
          reason: "failed",
          cause: `tar exited with ${exitCode} or the archive has no library.`,
        });
      yield* fs.writeFileString(path.join(staging, ".t3-complete"), AUDIO_CPP_VERSION);
      yield* fs.remove(install.directory, { recursive: true, force: true });
      yield* fs.rename(staging, install.directory);
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
    /** Fixed at the start, so extracting the runtime mid-transfer does not shrink it. */
    readonly size: number;
    runtime: number;
    model: number;
    verifying: boolean;
    fiber?: Fiber.Fiber<void, unknown>;
  };
  let transfer: Transfer | undefined;

  const catalog = Effect.gen(function* () {
    const missing = yield* missingRuntimes;
    const runtimeSize = missing.reduce((size, install) => size + install.file.size, 0);
    const models = yield* Effect.forEach(LOCAL_SYNTHESIS_MODELS, (model) =>
      Effect.gen(function* () {
        const active = transfer?.modelId === model.id ? transfer : undefined;
        const size = active?.size ?? model.file.size + runtimeSize;
        const install = active
          ? {
              state: active.verifying ? ("verifying" as const) : ("downloading" as const),
              size,
              downloaded: active.runtime + active.model,
            }
          : {
              state:
                installs.length && !missing.length && (yield* store.isReady(model.file))
                  ? ("installed" as const)
                  : ("downloadable" as const),
              size,
            };
        return { id: model.id, name: model.name, voices: model.voices, install };
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
    if (!installs.length)
      return yield* new LocalSynthesisInstallError({ reason: "unsupported-platform" });
    if (transfer && transfer.modelId !== modelId)
      return yield* new LocalSynthesisInstallError({ reason: "busy" });
    if (!transfer) {
      const missing = yield* missingRuntimes;
      const state: Transfer = {
        modelId,
        size: missing.reduce((size, install) => size + install.file.size, model.file.size),
        runtime: 0,
        model: 0,
        verifying: false,
      };
      transfer = state;
      const install = Effect.gen(function* () {
        let installed = 0;
        for (const install of missing) {
          const archivePath = yield* store.download(install.file, {
            onProgress: (downloaded) => {
              state.runtime = installed + downloaded;
              state.verifying = false;
            },
            onVerificationStart: () => {
              state.verifying = true;
            },
          });
          state.verifying = true;
          yield* extract(install, archivePath);
          yield* store.remove(install.file).pipe(Effect.ignore);
          installed += install.file.size;
          state.runtime = installed;
        }
        state.verifying = false;
        yield* store.download(model.file, {
          onProgress: (downloaded) => {
            state.model = downloaded;
            state.verifying = false;
          },
          onVerificationStart: () => {
            state.verifying = true;
          },
        });
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

  const remove = Effect.fn("LocalSpeechSynthesis.remove")(function* (modelId: string) {
    const model = yield* findModel(modelId);
    if (transfer?.modelId === modelId)
      return yield* new LocalSynthesisInstallError({ reason: "busy" });
    yield* permit.withPermits(1)(
      Effect.gen(function* () {
        if (worker?.modelId === modelId) yield* unloadWorker;
        yield* store.remove(model.file).pipe(Effect.mapError(installFailed));
        const remaining = yield* Effect.filter(LOCAL_SYNTHESIS_MODELS, (entry) =>
          store.isReady(entry.file),
        );
        if (remaining.length === 0)
          yield* fs
            .remove(runtimeRoot, { recursive: true, force: true })
            .pipe(Effect.mapError(installFailed));
      }),
    );
    return yield* catalog;
  });

  const failure = (reason: SpeechSynthesisError["reason"], cause?: unknown) =>
    new SpeechSynthesisError({
      provider: "local",
      reason,
      ...(cause === undefined ? {} : { cause }),
    });

  // Untraced: it runs inside the stream's own span.
  const speak = Effect.fnUntraced(function* (
    request: SpeechSynthesisRequest,
    queue: Queue.Queue<Uint8Array, SpeechSynthesisError | Cause.Done>,
  ) {
    if (!installs.length) return yield* failure("unavailable");
    const definition = LOCAL_SYNTHESIS_MODELS.find(
      (model) => model.id === (request.model || LOCAL_SYNTHESIS_MODELS[0]!.id),
    );
    if (!definition) return yield* failure("model-unavailable");
    if ((yield* missingRuntimes).length) return yield* failure("missing-model");
    const modelPath = yield* store.installedPath(definition.file);
    if (!modelPath) return yield* failure("missing-model");
    // Held until the stream ends, after any cancelled synthesis has stopped.
    yield* Effect.acquireRelease(Semaphore.take(permit, 1), () =>
      Semaphore.release(permit, 1).pipe(
        Effect.andThen(Effect.sync(() => Queue.offerUnsafe(idleDeadlines, undefined))),
      ),
    );
    if (!worker?.model.alive || worker.modelId !== definition.id) {
      yield* unloadWorker;
      // Uninterruptible, so a stream stopped mid-load still records the process it started.
      const loaded = yield* Effect.tryPromise({
        try: () =>
          loadLocalSynthesisModel({
            libraries: installs.map((install) => ({
              path: install.libraryPath,
              backend: install.runtime.backend,
            })),
            modelPath,
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
    }
    if (!worker) return yield* failure("unavailable");
    const { model } = worker;
    const language = localSynthesisLanguage(request.language, model.languages);
    const spoken = model
      .stream(
        {
          text: request.text,
          ...(language ? { language } : {}),
          options: {
            voice_id: definition.voices.includes(request.voice)
              ? request.voice
              : definition.voices[0]!,
            speed: String(request.speed),
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

  return LocalSpeechSynthesis.of({ catalog, download, cancel, remove, stream });
});

export const layer = Layer.effect(LocalSpeechSynthesis, make);
