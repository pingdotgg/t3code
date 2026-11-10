import { cloudSpeechLanguages, effectiveSpeechLanguage } from "@t3tools/shared/speech";
import {
  requireCloudSpeechKey,
  transcribeCloudPcm,
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
import type { CloudSpeechProvider, SpeechModelId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { createBrowserPcmCapture } from "./browserPcmCapture";
import { runEnvironmentSpeech } from "./runEnvironmentSpeech";

const isVoiceTranscriptionError = Schema.is(VoiceTranscriptionError);

export function createBrowserVoiceInputPlatform(input: {
  readonly prepared: PreparedConnection;
  readonly cloudProvider?: CloudSpeechProvider | undefined;
  /** The exact model the grant names; required for OpenRouter and custom endpoints. */
  readonly cloudModel?: SpeechModelId | undefined;
  /** The custom endpoint base URL the grant consented to. */
  readonly cloudEndpoint?: string | undefined;
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
    const transcribeRecording = async (
      uri: string,
      { signal: transcriptionSignal }: VoiceTranscriptionOptions,
    ) => {
      try {
        const response = await fetch(uri, { signal: transcriptionSignal });
        const pcm = new Uint8Array(await response.arrayBuffer());
        const result = await runEnvironmentSpeech(
          input.cloudProvider
            ? transcribeCloudPcm(
                input.prepared,
                input.cloudProvider,
                pcm,
                recordingOptions,
                input.hasAudioConsent,
                input.cloudModel,
                input.cloudEndpoint,
              )
            : transcribeEnvironmentPcm(
                input.prepared,
                pcm,
                recordingOptions,
                input.hasAudioConsent,
              ),
          { signal: transcriptionSignal },
        );
        throwIfVoiceTranscriptionAborted(transcriptionSignal);
        return result.text;
      } catch (cause) {
        throwIfVoiceTranscriptionAborted(transcriptionSignal);
        if (isVoiceTranscriptionError(cause)) throw cause;
        throw new VoiceTranscriptionError({
          code: "transcription-failed",
          message: "Voice transcription failed. Check the destination in Settings → Voice.",
          cause,
        });
      }
    };
    if (input.cloudProvider) {
      if (input.cloudProvider === "openrouter" && !input.cloudModel)
        throw new VoiceTranscriptionError({
          code: "unavailable",
          message: "Choose an OpenRouter model in Settings → Voice.",
        });
      await runEnvironmentSpeech(
        requireCloudSpeechKey(input.prepared, input.cloudProvider),
        options,
      );
      throwIfVoiceTranscriptionAborted(options.signal);
      return {
        locale: effectiveSpeechLanguage(cloudSpeechLanguages, recordingOptions.speechLanguage),
        transcribe: transcribeRecording,
      };
    }
    const status = await runEnvironmentSpeech(getEnvironmentSpeechStatus(input.prepared), options);
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
    if (!status.supportsStreaming && !status.supportsBufferedStreaming) {
      return { locale, transcribe: transcribeRecording };
    }
    const url = await runEnvironmentSpeech(getEnvironmentSpeechStreamUrl(input.prepared), options);
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
