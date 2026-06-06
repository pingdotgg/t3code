import type { PluginActivationContext, PluginCollection } from "@t3tools/plugin-api/server";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import { VOICE_INPUT_EVENTS } from "../shared/constants.ts";
import type {
  VoiceInputDependenciesStatusResult,
  VoiceInputSettings,
  VoiceInputSettingsPatch,
  VoiceInputTranscribeInput,
} from "../shared/schema.ts";
import { applyVoiceInputSettingsPatch, normalizeVoiceInputSettings } from "../shared/settings.ts";
import {
  checkFasterWhisper,
  checkFfmpeg,
  fasterWhisperInstallCommand,
  findPythonCommand,
  localWhisperVenvPath,
  localWhisperVenvPythonCommand,
  localWhisperVenvSetupCommand,
} from "./dependencies.ts";
import {
  downloadWhisperModel,
  smokeTestWhisperModel,
  transcribeWithLocalWhisper,
} from "./localWhisper.ts";
import { isWhisperModelCached, whisperModelCacheDir } from "./modelCache.ts";
import { withTempAudioFileEffect } from "./tempAudio.ts";

const SETTINGS_DOCUMENT_ID = "default";

class VoiceInputPluginError extends Data.TaggedError("VoiceInputPluginError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface VoiceInputCollections {
  readonly settings: PluginCollection<VoiceInputSettings>;
}

const getSettings = (collections: VoiceInputCollections) =>
  collections.settings.get(SETTINGS_DOCUMENT_ID).pipe(Effect.map(normalizeVoiceInputSettings));

const saveSettings = (
  collections: VoiceInputCollections,
  settings: VoiceInputSettings,
): Effect.Effect<void, Error> => collections.settings.upsert(SETTINGS_DOCUMENT_ID, settings);

const publishChanged = (ctx: PluginActivationContext, payload: unknown) =>
  ctx.events.publish({
    type: VOICE_INPUT_EVENTS.changed,
    payload,
  });

const getNormalizedPythonCommand = (settings: VoiceInputSettings): string =>
  settings.pythonCommand?.trim() ?? "";

function resolveInstallCommand(input: {
  readonly ctx: PluginActivationContext;
  readonly settings: VoiceInputSettings;
  readonly pythonCommand: string | null;
}): string {
  if (getNormalizedPythonCommand(input.settings).length > 0) {
    return fasterWhisperInstallCommand(input.pythonCommand);
  }
  return localWhisperVenvSetupCommand(input.ctx.paths.dataDir);
}

const dependencyStatus = (
  ctx: PluginActivationContext,
  settings: VoiceInputSettings,
): Effect.Effect<VoiceInputDependenciesStatusResult, VoiceInputPluginError> =>
  Effect.tryPromise({
    try: async () => {
      const venvPythonCommand = localWhisperVenvPythonCommand(ctx.paths.dataDir);
      const venvSetupCommand = localWhisperVenvSetupCommand(ctx.paths.dataDir);
      const python = await findPythonCommand({
        configuredCommand: getNormalizedPythonCommand(settings),
        venvPythonCommand,
      });
      const installCommand = resolveInstallCommand({
        ctx,
        settings,
        pythonCommand: python.command,
      });
      const [venvPython, fasterWhisper, ffmpeg, selectedModelCached] = await Promise.all([
        findPythonCommand({ configuredCommand: venvPythonCommand }).then((result) => result.check),
        checkFasterWhisper(python.command, installCommand),
        checkFfmpeg(),
        isWhisperModelCached(ctx.paths.cacheDir, settings.model),
      ]);
      return {
        python: python.check,
        venvPython,
        fasterWhisper,
        ffmpeg,
        selectedModelCached,
        cachePath: whisperModelCacheDir(ctx.paths.cacheDir),
        installCommand,
        venvPath: localWhisperVenvPath(ctx.paths.dataDir),
        venvPythonCommand,
        venvSetupCommand,
      };
    },
    catch: (cause) =>
      new VoiceInputPluginError({
        message: "Unable to check voice input dependencies.",
        cause,
      }),
  });

const requirePythonAndWhisper = (ctx: PluginActivationContext, settings: VoiceInputSettings) =>
  Effect.tryPromise({
    try: async () => {
      const python = await findPythonCommand({
        configuredCommand: getNormalizedPythonCommand(settings),
        venvPythonCommand: localWhisperVenvPythonCommand(ctx.paths.dataDir),
      });
      const installCommand = resolveInstallCommand({
        ctx,
        settings,
        pythonCommand: python.command,
      });
      if (!python.command) {
        throw new VoiceInputPluginError({
          message: python.check.detail ?? "Python is not available.",
        });
      }
      const fasterWhisper = await checkFasterWhisper(python.command, installCommand);
      if (!fasterWhisper.available) {
        throw new VoiceInputPluginError({
          message: fasterWhisper.detail ?? "faster-whisper is not available.",
        });
      }
      return python.command;
    },
    catch: (cause) =>
      cause instanceof VoiceInputPluginError
        ? cause
        : new VoiceInputPluginError({
            message: "Unable to check Local Whisper dependencies.",
            cause,
          }),
  });

function toVoiceInputError(message: string, cause: unknown): VoiceInputPluginError {
  return cause instanceof VoiceInputPluginError
    ? cause
    : new VoiceInputPluginError({ message, cause });
}

function publishModelDownloadFailed(
  ctx: PluginActivationContext,
  settings: VoiceInputSettings,
  error: VoiceInputPluginError,
) {
  return ctx.events
    .publish({
      type: VOICE_INPUT_EVENTS.modelDownloadFailed,
      payload: { model: settings.model, message: error.message },
    })
    .pipe(Effect.andThen(Effect.fail(error)));
}

export const makeVoiceInputRuntime = (
  ctx: PluginActivationContext,
  collections: VoiceInputCollections,
) =>
  Effect.gen(function* () {
    const modelDownloadLock = yield* Semaphore.make(1);
    const transcriptionBusyRef = yield* Ref.make(false);

    const rejectConcurrentTranscription = () =>
      new VoiceInputPluginError({
        message: "Voice transcription is already running.",
      });

    const withTranscriptionPermit = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const acquired = yield* Ref.modify(transcriptionBusyRef, (busy) =>
            busy ? [false, true] : [true, true],
          );
          if (!acquired) {
            return yield* rejectConcurrentTranscription();
          }

          return yield* restore(effect).pipe(Effect.ensuring(Ref.set(transcriptionBusyRef, false)));
        }),
      );

    const getSettingsResult = () =>
      getSettings(collections).pipe(
        Effect.map((settings) => ({
          settings,
          cachePath: whisperModelCacheDir(ctx.paths.cacheDir),
        })),
      );

    const updateSettings = (patch: VoiceInputSettingsPatch) =>
      Effect.gen(function* () {
        const current = yield* getSettings(collections);
        const settings = applyVoiceInputSettingsPatch(current, patch);
        yield* saveSettings(collections, settings);
        yield* publishChanged(ctx, { settings: true });
        return {
          settings,
          cachePath: whisperModelCacheDir(ctx.paths.cacheDir),
        };
      });

    const getDependenciesStatus = () =>
      Effect.gen(function* () {
        const settings = yield* getSettings(collections);
        return yield* dependencyStatus(ctx, settings);
      });

    const getClientState = () =>
      Effect.gen(function* () {
        const settings = yield* getSettings(collections);
        const status = yield* dependencyStatus(ctx, settings);
        return {
          settings,
          status,
          cachePath: whisperModelCacheDir(ctx.paths.cacheDir),
        };
      });

    const downloadModel = () =>
      modelDownloadLock.withPermit(
        Effect.gen(function* () {
          const settings = yield* getSettings(collections);
          const failDownload = (error: VoiceInputPluginError) =>
            publishModelDownloadFailed(ctx, settings, error);
          const pythonCommand = yield* requirePythonAndWhisper(ctx, settings).pipe(
            Effect.catch(failDownload),
          );
          yield* ctx.events.publish({
            type: VOICE_INPUT_EVENTS.modelDownloadStarted,
            payload: { model: settings.model },
          });
          yield* ctx.events.publish({
            type: VOICE_INPUT_EVENTS.modelDownloadProgress,
            payload: { model: settings.model, phase: "loading" },
          });
          const cached = yield* Effect.tryPromise({
            try: () => isWhisperModelCached(ctx.paths.cacheDir, settings.model),
            catch: (cause) =>
              new VoiceInputPluginError({
                message: "Unable to inspect Whisper model cache.",
                cause,
              }),
          }).pipe(Effect.catch(failDownload));
          if (!cached) {
            yield* downloadWhisperModel({
              pythonCommand,
              cacheDir: ctx.paths.cacheDir,
              settings,
            }).pipe(
              Effect.mapError((cause) =>
                toVoiceInputError("Could not download Whisper model.", cause),
              ),
              Effect.catch(failDownload),
            );
          }
          yield* ctx.events.publish({
            type: VOICE_INPUT_EVENTS.modelDownloadCompleted,
            payload: { model: settings.model },
          });
          yield* publishChanged(ctx, { model: settings.model });
          return { model: settings.model, cached: true };
        }),
      );

    const transcribe = (input: VoiceInputTranscribeInput) =>
      withTranscriptionPermit(
        Effect.gen(function* () {
          const settings = yield* getSettings(collections);
          if (!settings.enabled) {
            return yield* new VoiceInputPluginError({ message: "Voice input is disabled." });
          }
          if (input.sizeBytes > settings.maxUploadBytes) {
            return yield* new VoiceInputPluginError({
              message: "Recording exceeds the configured upload limit.",
            });
          }
          const pythonCommand = yield* requirePythonAndWhisper(ctx, settings);
          const startedAt = yield* Clock.currentTimeMillis;
          const result = yield* withTempAudioFileEffect(ctx.paths.tempDir, input, (audioPath) =>
            transcribeWithLocalWhisper({
              pythonCommand,
              cacheDir: ctx.paths.cacheDir,
              audioPath,
              settings,
            }),
          ).pipe(
            Effect.mapError((cause) => toVoiceInputError("Could not transcribe recording.", cause)),
          );
          if (result.text.trim().length === 0) {
            return yield* new VoiceInputPluginError({
              message:
                "No speech detected. Try speaking closer to the microphone or recording a longer message.",
            });
          }
          const completedAt = yield* Clock.currentTimeMillis;
          return {
            ...result,
            durationMs: Math.max(0, completedAt - startedAt),
          };
        }),
      );

    const testTranscription = () =>
      Effect.gen(function* () {
        const settings = yield* getSettings(collections);
        const cached = yield* Effect.tryPromise({
          try: () => isWhisperModelCached(ctx.paths.cacheDir, settings.model),
          catch: (cause) =>
            new VoiceInputPluginError({
              message: "Unable to inspect Whisper model cache.",
              cause,
            }),
        });
        if (!cached) {
          return {
            ok: false,
            message: `Model ${settings.model} is not marked as downloaded yet.`,
          };
        }
        const pythonCommand = yield* requirePythonAndWhisper(ctx, settings);
        yield* smokeTestWhisperModel({
          pythonCommand,
          cacheDir: ctx.paths.cacheDir,
          settings,
        }).pipe(
          Effect.mapError((cause) => toVoiceInputError("Could not load Whisper model.", cause)),
        );
        return {
          ok: true,
          message: `Model ${settings.model} loaded successfully.`,
        };
      });

    return {
      getSettingsResult,
      updateSettings,
      getDependenciesStatus,
      getClientState,
      downloadModel,
      transcribe,
      testTranscription,
    } as const;
  });

export type VoiceInputRuntime = Effect.Success<ReturnType<typeof makeVoiceInputRuntime>>;
