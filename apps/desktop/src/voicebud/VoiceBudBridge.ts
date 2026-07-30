import type {
  VoiceBudAcknowledgeDeliveryInput,
  VoiceBudBindRecordingInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import {
  VOICE_BUD_RECORDING_STARTED_CHANNEL,
  VOICE_BUD_TRANSCRIPTION_CHANNEL,
} from "../ipc/channels.ts";
import { VoiceBudBridgeServer } from "./VoiceBudBridgeServer.ts";
import { VoiceBudSessionRegistry } from "./VoiceBudSessionRegistry.ts";

export class VoiceBudBridgeStartError extends Schema.TaggedErrorClass<VoiceBudBridgeStartError>()(
  "VoiceBudBridgeStartError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "The private local VoiceBud bridge could not be started.";
  }
}

export class VoiceBudBridge extends Context.Service<
  VoiceBudBridge,
  {
    readonly start: Effect.Effect<void, VoiceBudBridgeStartError, Scope.Scope>;
    readonly bindRecording: (input: VoiceBudBindRecordingInput) => Effect.Effect<boolean>;
    readonly acknowledgeDelivery: (
      input: VoiceBudAcknowledgeDeliveryInput,
    ) => Effect.Effect<boolean>;
  }
>()("@t3tools/desktop/voicebud/VoiceBudBridge") {}

export function makeVoiceBudRegistryOperations(registry: VoiceBudSessionRegistry) {
  return {
    bindRecording: (input: VoiceBudBindRecordingInput) => registry.bind(input),
    acknowledgeDelivery: (input: VoiceBudAcknowledgeDeliveryInput) =>
      registry.acknowledge(input.deliveryId, input.applied),
  };
}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const context = yield* Effect.context<ElectronWindow.ElectronWindow>();
  const runEffect = Effect.runPromiseWith(context);
  let currentServer: VoiceBudBridgeServer | null = null;

  const sendMain = (channel: string, event: unknown) =>
    electronWindow.main.pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: (window) =>
            Effect.sync(() => {
              if (!window.isDestroyed()) {
                window.webContents.send(channel, event);
              }
            }),
        }),
      ),
    );

  const registry = new VoiceBudSessionRegistry({
    onRecordingStarted: (event) => sendMain(VOICE_BUD_RECORDING_STARTED_CHANNEL, event),
    onTranscription: (event) => sendMain(VOICE_BUD_TRANSCRIPTION_CHANNEL, event),
  });

  const start =
    environment.platform !== "darwin"
      ? Effect.void
      : Effect.acquireRelease(
          Effect.gen(function* () {
            if (currentServer) return currentServer;
            const server = new VoiceBudBridgeServer({
              directory: path.join(environment.stateDir, "integrations", "voicebud"),
              fileSystem,
              handler: {
                begin: (requestId, recordingId) =>
                  runEffect(registry.begin(requestId, recordingId)),
                complete: (deliveryId, recordingId, transcript) =>
                  runEffect(registry.complete(deliveryId, recordingId, transcript)),
                close: () => runEffect(registry.close()),
              },
              path,
            });
            yield* server
              .start()
              .pipe(Effect.mapError((cause) => new VoiceBudBridgeStartError({ cause })));
            currentServer = server;
            return server;
          }),
          (server) =>
            Effect.sync(() => {
              currentServer = null;
            }).pipe(Effect.andThen(server.stop()), Effect.orDie),
        ).pipe(Effect.asVoid);

  return VoiceBudBridge.of({
    start,
    ...makeVoiceBudRegistryOperations(registry),
  });
});

export const layer = Layer.effect(VoiceBudBridge, make);
