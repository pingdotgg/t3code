import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { DesktopVoiceRequest, DesktopVoiceTranscript } from "@t3tools/contracts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import { DesktopVoiceSession } from "../../voice/DesktopVoiceSession.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as Channels from "../channels.ts";

class VoiceInputError extends Schema.TaggedError<VoiceInputError>()("VoiceInputError", {
  message: Schema.String,
}) {}

const voiceError = (cause: unknown) =>
  new VoiceInputError({
    message: cause instanceof Error ? cause.message : "Voice input failed. Try again.",
  });

export const installVoiceInput = Effect.fn("desktop.ipc.installVoiceInput")(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const ipc = yield* DesktopIpc.DesktopIpc;
  const helper =
    environment.platform !== "darwin"
      ? null
      : environment.isPackaged
        ? environment.path.join(environment.resourcesPath, "voice-input", "t3-voice-input")
        : environment.path.join(
            environment.rootDir,
            "native/voice-input/target",
            environment.processArch,
            "t3-voice-input",
          );
  const session = new DesktopVoiceSession(helper);
  yield* Effect.addFinalizer(() => Effect.promise(() => session.dispose()));
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: Channels.VOICE_AVAILABLE_CHANNEL,
      payload: Schema.Void,
      result: Schema.Boolean,
      handler: Effect.fn("desktop.voice.available")(() =>
        Effect.promise(() => session.available()),
      ),
    }),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: Channels.VOICE_START_CHANNEL,
      payload: DesktopVoiceRequest,
      result: DesktopVoiceTranscript,
      handler: Effect.fn("desktop.voice.start")((id, event) =>
        Effect.tryPromise({
          try: async () => {
            if (!event) throw new Error("Voice input requires a desktop window.");
            const window = Electron.webContents.fromId(event.sender.id);
            if (!window) throw new Error("The desktop window is no longer available.");
            const closed = () => {
              void session.cancel(event.sender.id, id);
            };
            const navigating = (
              event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
            ) => {
              if (event.isMainFrame && !event.isSameDocument) closed();
            };
            window.on("did-start-navigation", navigating);
            window.once("destroyed", closed);
            window.once("render-process-gone", closed);
            try {
              return await session.start(event.sender.id, id, () => {
                if (!window.isDestroyed()) window.send(Channels.VOICE_RECORDING_CHANNEL, id);
              });
            } finally {
              window.removeListener("did-start-navigation", navigating);
              window.removeListener("destroyed", closed);
              window.removeListener("render-process-gone", closed);
            }
          },
          catch: voiceError,
        }),
      ),
    }),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: Channels.VOICE_STOP_CHANNEL,
      payload: DesktopVoiceRequest,
      result: Schema.Void,
      handler: Effect.fn("desktop.voice.stop")((id, event) =>
        Effect.try({
          try: () => {
            if (!event) throw new Error("Voice input requires a desktop window.");
            session.stop(event.sender.id, id);
          },
          catch: voiceError,
        }),
      ),
    }),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: Channels.VOICE_CANCEL_CHANNEL,
      payload: DesktopVoiceRequest,
      result: Schema.Void,
      handler: Effect.fn("desktop.voice.cancel")((id, event) =>
        Effect.promise(() => (event ? session.cancel(event.sender.id, id) : Promise.resolve())),
      ),
    }),
  );
});
