import { effectiveSpeechLanguage } from "@t3tools/shared/speech";
import {
  getEnvironmentSpeechStatus,
  getEnvironmentSpeechStreamUrl,
  openSpeechStream,
  throwIfVoiceTranscriptionAborted,
  transcribeEnvironmentPcm,
  VoiceTranscriptionError,
  type VoiceTranscriptionOptions,
} from "@t3tools/client-runtime/voice-input";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type { SpeechTranscriptionOptions, SpeechStreamText } from "@t3tools/contracts";

import { runtime } from "../lib/runtime";
import { createBrowserPcmCapture } from "./browserPcmCapture";

export function createBrowserVoiceInputPlatform(input: {
  readonly prepared: PreparedConnection;
  readonly hasAudioConsent: () => boolean;
  readonly getTranscriptionOptions: () => SpeechTranscriptionOptions;
  readonly getMicrophoneId: () => string;
  readonly onLevel: (level: number) => void;
  readonly onDurationLimit: () => void;
  readonly onText: (text: SpeechStreamText) => void;
  readonly onError: (message: string) => void;
}) {
  return createBrowserPcmCapture(input, async (options) => {
    const recordingOptions = input.getTranscriptionOptions();
    const status = await runtime.runPromise(getEnvironmentSpeechStatus(input.prepared), options);
    throwIfVoiceTranscriptionAborted(options.signal);
    if (!status.supported)
      throw new VoiceTranscriptionError({ code: "unavailable", message: status.reason });
    const language = status.languages
      ? effectiveSpeechLanguage(
          {
            languages: status.languages,
            supportsLanguageDetection: status.supportsLanguageDetection ?? false,
          },
          recordingOptions.speechLanguage,
        )
      : "auto";
    const locale =
      !status.supportsStreaming &&
      status.supportsTranslation &&
      recordingOptions.speechTranslateToEnglish
        ? "en"
        : language;
    const transcribeRecording = async (
      uri: string,
      { signal: transcriptionSignal }: VoiceTranscriptionOptions,
    ) => {
      try {
        const response = await fetch(uri, { signal: transcriptionSignal });
        const pcm = new Uint8Array(await response.arrayBuffer());
        const result = await runtime.runPromise(
          transcribeEnvironmentPcm(input.prepared, pcm, recordingOptions, input.hasAudioConsent),
          {
            signal: transcriptionSignal,
          },
        );
        throwIfVoiceTranscriptionAborted(transcriptionSignal);
        return result.text;
      } catch (cause) {
        throwIfVoiceTranscriptionAborted(transcriptionSignal);
        throw new VoiceTranscriptionError({
          code: "transcription-failed",
          message: "Voice transcription on this environment failed.",
          cause,
        });
      }
    };
    if (!status.supportsStreaming && !status.supportsBufferedStreaming) {
      return { locale, transcribe: transcribeRecording };
    }
    const url = await runtime.runPromise(getEnvironmentSpeechStreamUrl(input.prepared), options);
    return {
      locale,
      transcribe: transcribeRecording,
      streaming: openSpeechStream({
        url,
        canSend: input.hasAudioConsent,
        options: recordingOptions,
        signal: options.signal,
        onText: input.onText,
        onError: (error) => input.onError(error.message),
      }),
    };
  });
}
