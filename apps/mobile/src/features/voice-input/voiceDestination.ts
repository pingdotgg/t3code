import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
} from "@t3tools/contracts";
import {
  getEnvironmentSpeechModels,
  getEnvironmentSpeechStatus,
  transcribeEnvironmentPcm,
  VoiceTranscriptionError,
} from "@t3tools/client-runtime/voice-input";
import { FetchHttpClient, type HttpClient } from "effect/http";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { effectiveSpeechLanguage } from "@t3tools/shared/speech";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Atom, AsyncResult, AtomRegistry } from "effect/reactivity";
import { requireOptionalNativeModule } from "expo";
import { fetch as expoFetch } from "expo/fetch";

import { appAtomRegistry } from "../../state/atom-registry";
import { environmentPresentations } from "../../state/presentation";
import { environmentSession, sessionHasScope } from "../../state/session";
import { connectionAtomRuntime } from "../../connection/runtime";
import { uuidv4 } from "../../lib/uuid";
import { createEnvironmentTranscriber } from "./environmentTranscriber";
import { readVoiceGrant, writeVoiceGrant, type VoiceGrant } from "./voiceGrantStorage";

const storedGrant = Atom.make(Effect.promise(readVoiceGrant)).pipe(Atom.keepAlive);
const choice = Atom.make<VoiceGrant | null | undefined>(undefined).pipe(Atom.keepAlive);
export const voiceGrantAtom = Atom.make((get) => {
  const chosen = get(choice);
  if (chosen !== undefined) return chosen;
  return AsyncResult.getOrElse(get(storedGrant), () => null);
});

export function chooseVoiceDestination(environmentId: EnvironmentId | null) {
  // A failed change must not leave the old destination armed in this session.
  appAtomRegistry.set(choice, null);
  const grant: VoiceGrant | null =
    environmentId === null
      ? null
      : {
          id: uuidv4(),
          destination: { kind: "environment", environmentId },
        };
  writeVoiceGrant(grant);
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
export function runSpeech<A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient>,
  signal?: AbortSignal,
  canSend: () => boolean = () => true,
) {
  return Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, connectionAtomRuntime).pipe(
      Effect.flatMap((context) =>
        effect.pipe(
          Effect.provideService(FetchHttpClient.Fetch, async (url, options) => {
            if (signal?.aborted || !canSend())
              throw new VoiceTranscriptionError({
                code: "cancelled",
                message: "Your transcription choice changed.",
              });
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
      if (!status.supported)
        throw new VoiceTranscriptionError({ code: "unavailable", message: status.reason });
      if (status.state === "missing-model")
        throw new VoiceTranscriptionError({
          code: "unavailable",
          message:
            "Install a transcription model for this environment in Settings → Voice, then try again.",
        });
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
        throw new VoiceTranscriptionError({
          code: "unavailable",
          message: "Update T3 Code to transcribe on an environment.",
        });
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

const speechAtom = <A, E>(
  id: EnvironmentId,
  read: (prepared: PreparedConnection) => Effect.Effect<A, E, HttpClient.HttpClient>,
) =>
  Atom.make((get) => {
    const prepared = get(voiceConnectionAtom(id));
    return prepared
      ? Effect.tryPromise({
          try: (signal) => runSpeech(read(prepared), signal),
          catch: (cause) =>
            new VoiceTranscriptionError({
              code: "unavailable",
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        })
      : Effect.succeed(null);
  });

export const voiceSpeechStatusAtom = Atom.family((id: EnvironmentId) =>
  speechAtom(id, getEnvironmentSpeechStatus),
);
export const voiceSpeechModelsAtom = Atom.family((id: EnvironmentId) =>
  speechAtom(id, (prepared) => getEnvironmentSpeechModels(prepared)),
);
// Fetched once for the model sheet; download progress polls the lighter list above.
export const voiceSpeechBenchmarksAtom = Atom.family((id: EnvironmentId) =>
  speechAtom(id, (prepared) => getEnvironmentSpeechModels(prepared, true)),
);

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
