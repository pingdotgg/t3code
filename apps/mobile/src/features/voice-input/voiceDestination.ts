import {
  VoiceTranscriptionDestination,
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
} from "@t3tools/contracts";
import {
  getEnvironmentSpeechStatus,
  transcribeEnvironmentPcm,
  VoiceTranscriptionError,
} from "@t3tools/client-runtime/voice-input";
import { FetchHttpClient, type HttpClient } from "effect/http";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { effectiveSpeechLanguage } from "@t3tools/shared/speech";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Atom, AsyncResult, AtomRegistry } from "effect/reactivity";
import { requireOptionalNativeModule } from "expo";
import { fetch as expoFetch } from "expo/fetch";
import * as SecureStore from "expo-secure-store";

import { whenProtectedDataAvailable } from "../../lib/protectedData";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentPresentations } from "../../state/presentation";
import { environmentSession, sessionHasScope } from "../../state/session";
import { connectionAtomRuntime } from "../../connection/runtime";
import { uuidv4 } from "../../lib/uuid";
import { createEnvironmentTranscriber } from "./environmentTranscriber";

const key = "t3code.voice.audio-grant.v1";
const deviceOnly = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const Grant = Schema.Struct({
  id: Schema.NonEmptyString,
  destination: VoiceTranscriptionDestination,
});
type Grant = typeof Grant.Type;
const decodeGrant = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.NullOr(Grant)));
const storedGrant = Atom.make(
  Effect.promise(async () => {
    await whenProtectedDataAvailable();
    try {
      const raw = await SecureStore.getItemAsync(key, deviceOnly);
      return raw ? decodeGrant(raw) : null;
    } catch {
      return null;
    }
  }),
).pipe(Atom.keepAlive);
const choice = Atom.make<Grant | null | undefined>(undefined).pipe(Atom.keepAlive);
export const voiceGrantAtom = Atom.make((get) => {
  const chosen = get(choice);
  if (chosen !== undefined) return chosen;
  return AsyncResult.getOrElse(get(storedGrant), () => null);
});

export function chooseVoiceDestination(environmentId: EnvironmentId | null) {
  const grant: Grant | null =
    environmentId === null
      ? null
      : {
          id: uuidv4(),
          destination: { kind: "environment", environmentId },
        };
  // Revocation takes effect even if the device cannot persist the new choice.
  appAtomRegistry.set(choice, null);
  SecureStore.setItem(key, JSON.stringify(grant), deviceOnly);
  appAtomRegistry.set(choice, grant);
}

const native = requireOptionalNativeModule<{
  decodeRecording?: (uri: string) => Promise<Uint8Array>;
}>("T3VoiceTranscription");
export const hasEnvironmentVoiceCapture = typeof native?.decodeRecording === "function";

export const voiceConnectionAtom = Atom.family((id: EnvironmentId) =>
  Atom.make((get) => {
    const environment = get(environmentPresentations.presentationAtom(id));
    if (
      !hasEnvironmentVoiceCapture ||
      environment?.connection.phase !== "connected" ||
      !environment.serverConfig?.environment.capabilities.voiceTranscription ||
      !sessionHasScope(get(environmentSession.sessionStateAtom(id)), AuthOrchestrationOperateScope)
    )
      return null;
    return Option.getOrNull(get(environmentSession.preparedConnectionValueAtom(id)));
  }),
);

// React Native's XMLHttpRequest fetch follows redirects. Expo's native transport honors redirect: "error".
function runSpeech<A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient>,
  signal: AbortSignal,
  canSend: () => boolean,
) {
  return Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, connectionAtomRuntime).pipe(
      Effect.flatMap((context) =>
        effect.pipe(
          Effect.provideService(FetchHttpClient.Fetch, async (url, options) => {
            if (signal.aborted || !canSend())
              throw new VoiceTranscriptionError(
                "cancelled",
                "The transcription destination changed.",
              );
            return expoFetch(url, { ...options, redirect: "error" });
          }),
          Effect.provide(context),
        ),
      ),
    ),
    { signal },
  );
}
function environmentTranscriber(prepared: PreparedConnection, canSend: () => boolean) {
  return createEnvironmentTranscriber({
    canSend,
    prepare: async (signal) => {
      const status = await runSpeech(getEnvironmentSpeechStatus(prepared), signal, canSend);
      if (!status.supported) throw new VoiceTranscriptionError("unavailable", status.reason);
      if (status.state === "missing-model")
        throw new VoiceTranscriptionError(
          "unavailable",
          "Install a transcription model in this environment’s Voice settings, then try again.",
        );
      return status.languages
        ? effectiveSpeechLanguage(
            {
              languages: status.languages,
              supportsLanguageDetection: status.supportsLanguageDetection ?? false,
            },
            "auto",
          )
        : "auto";
    },
    decode: (uri) => {
      if (!native?.decodeRecording)
        throw new VoiceTranscriptionError(
          "unavailable",
          "Update the app to use environment transcription.",
        );
      return native.decodeRecording(uri);
    },
    upload: async (pcm, signal) =>
      (
        await runSpeech(
          transcribeEnvironmentPcm(prepared, pcm, DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS, canSend),
          signal,
          canSend,
        )
      ).text,
  });
}

// null selects on-device; a grant with no usable transcriber must never fall back.
export const voiceRouteAtom = Atom.make((get) => {
  const grant = get(voiceGrantAtom);
  if (!grant) return null;
  const connectionAtom = voiceConnectionAtom(grant.destination.environmentId);
  const connection = get(connectionAtom);
  const registry = get.registry;
  return {
    transcriber:
      connection &&
      environmentTranscriber(
        connection,
        () => registry.get(voiceGrantAtom) === grant && registry.get(connectionAtom) === connection,
      ),
  };
});
