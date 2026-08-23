// @effect-diagnostics nodeBuiltinImport:off - native model storage uses the resolved desktop data path.
import type { DesktopSpeechEvent, DesktopSpeechStatus } from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as NodePath from "node:path";

import * as DesktopAppIdentity from "../app/DesktopAppIdentity.ts";
import { DesktopMicrophoneCapture } from "./DesktopMicrophoneCapture.ts";
import { DesktopSpeechController } from "./DesktopSpeechController.ts";
import { DesktopTranscriptionBackend } from "./DesktopTranscriptionBackend.ts";
import {
  SPEECH_MODEL,
  downloadVerifiedModel,
  isSpeechModelReady,
  removeSpeechModel,
  speechModelPath,
} from "./speechModel.ts";

type SpeechEventListener = (event: DesktopSpeechEvent) => Effect.Effect<void>;

export class DesktopSpeechOperationError extends Schema.TaggedErrorClass<DesktopSpeechOperationError>()(
  "DesktopSpeechOperationError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop speech ${this.operation} failed.`;
  }
}

export class DesktopSpeech extends Context.Service<
  DesktopSpeech,
  {
    readonly getStatus: Effect.Effect<DesktopSpeechStatus, DesktopSpeechOperationError>;
    readonly start: Effect.Effect<DesktopSpeechStatus, DesktopSpeechOperationError>;
    readonly stop: Effect.Effect<DesktopSpeechStatus, DesktopSpeechOperationError>;
    readonly cancel: Effect.Effect<DesktopSpeechStatus, DesktopSpeechOperationError>;
    readonly removeModel: Effect.Effect<DesktopSpeechStatus, DesktopSpeechOperationError>;
    readonly subscribe: (listener: SpeechEventListener) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/speech/DesktopSpeech") {}

function support(
  platform: string,
  architecture: string,
): {
  supported: boolean;
  reason?: string;
} {
  if (platform === "win32" && architecture === "arm64") {
    return { supported: false, reason: "voice input is not available on Windows arm64 yet" };
  }
  const tuple = `${platform}-${architecture}`;
  const supported = new Set([
    "darwin-arm64",
    "darwin-x64",
    "win32-x64",
    "linux-x64",
    "linux-arm64",
  ]).has(tuple);
  return supported
    ? { supported: true }
    : { supported: false, reason: `voice input is not available on ${tuple}` };
}

function attempt<A>(
  operation: string,
  run: () => Promise<A>,
): Effect.Effect<A, DesktopSpeechOperationError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => new DesktopSpeechOperationError({ operation, cause }),
  });
}

export const make = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;
  const appIdentity = yield* DesktopAppIdentity.DesktopAppIdentity;
  const availability = support(platform, architecture);
  const directory = NodePath.join(yield* appIdentity.resolveUserDataPath, "speech", "models");
  const listeners = yield* Ref.make<ReadonlySet<SpeechEventListener>>(new Set());
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);

  const emit = (event: DesktopSpeechEvent): void => {
    runFork(
      Ref.get(listeners).pipe(
        Effect.flatMap((current) =>
          Effect.forEach(current, (listener) => listener(event), { discard: true }),
        ),
      ),
    );
  };

  const controller = new DesktopSpeechController({
    supported: availability.supported,
    ...(availability.reason ? { unsupportedReason: availability.reason } : {}),
    modelPath: speechModelPath(directory),
    modelReady: () => isSpeechModelReady(directory),
    downloadModel: (onProgress) =>
      downloadVerifiedModel({
        directory,
        filename: SPEECH_MODEL.filename,
        url: SPEECH_MODEL.url,
        size: SPEECH_MODEL.size,
        sha256: SPEECH_MODEL.sha256,
        onProgress,
      }),
    removeModel: () => removeSpeechModel(directory),
    createCapture: () =>
      new DesktopMicrophoneCapture((level, elapsedMs) => emit({ type: "level", level, elapsedMs })),
    createBackend: (modelPath) => new DesktopTranscriptionBackend(modelPath),
    emit,
  });

  yield* Effect.addFinalizer(() =>
    attempt("shutdown", () => controller.shutdown()).pipe(Effect.orDie),
  );

  const subscribe = (listener: SpeechEventListener): Effect.Effect<void, never, Scope.Scope> =>
    Effect.acquireRelease(
      Ref.update(listeners, (current) => new Set([...current, listener])),
      () =>
        Ref.update(listeners, (current) => {
          const next = new Set(current);
          next.delete(listener);
          return next;
        }),
    ).pipe(Effect.asVoid);

  return DesktopSpeech.of({
    getStatus: attempt("get status", () => controller.getStatus()),
    start: attempt("start", () => controller.start()),
    stop: attempt("stop", () => controller.stop()),
    cancel: attempt("cancel", () => controller.cancel()),
    removeModel: attempt("remove model", () => controller.removeModel()),
    subscribe,
  });
});

export const layer = Layer.effect(DesktopSpeech, make);
