import { cloudSpeechLanguages, effectiveSpeechLanguage } from "@t3tools/shared/speech";
import {
  requireCloudSpeechKey,
  transcribeCloudPcm,
  getEnvironmentSpeechStatus,
  getEnvironmentSpeechStreamUrl,
  openSpeechStream,
  throwIfVoiceTranscriptionAborted,
  transcribeEnvironmentPcm,
  type VoiceInputErrorCode,
  VoiceTranscriptionError,
  type VoiceTranscriptionOptions,
} from "@t3tools/client-runtime/voice-input";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type {
  SpeechTranscriptionOptions,
  SpeechStreamText,
  EnvironmentSpeechStatus,
} from "@t3tools/contracts";
import type { CloudSpeechModelId, CloudSpeechProvider } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { createBrowserPcmCapture } from "./browserPcmCapture";
import { runEnvironmentSpeech } from "./runEnvironmentSpeech";
import { msg } from "gt-react";
import { m } from "../i18n/messages";

const isVoiceTranscriptionError = Schema.is(VoiceTranscriptionError);

export function createBrowserVoiceInputPlatform(input: {
  readonly prepared: PreparedConnection;
  readonly cloudProvider?: CloudSpeechProvider | undefined;
  /** The exact OpenRouter model the grant names; required with that provider. */
  readonly cloudModel?: CloudSpeechModelId | undefined;
  readonly hasAudioConsent: () => boolean;
  readonly getTranscriptionOptions: () => SpeechTranscriptionOptions;
  readonly getStatusListener?: () => ((status: EnvironmentSpeechStatus) => void) | undefined;
  readonly getStreamingEnabled: () => boolean;
  readonly getMicrophoneId: () => string | Promise<string>;
  readonly onLevel: (level: number) => void;
  readonly onDurationLimit: () => void;
  readonly onText: (text: SpeechStreamText) => void;
  readonly onError: (message: string, code?: VoiceInputErrorCode) => void;
}) {
  return createBrowserPcmCapture(input, async (options, canStream) => {
    const onStatus = input.getStatusListener?.();
    const recordingOptions = input.getTranscriptionOptions();
    const streamingEnabled = input.getStreamingEnabled();
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
          message: m(msg("Voice transcription failed. Check the destination in Settings → Voice.")),
          cause,
        });
      }
    };
    if (input.cloudProvider) {
      if (input.cloudProvider === "openrouter" && !input.cloudModel)
        throw new VoiceTranscriptionError({
          code: "unavailable",
          message: m(msg("Choose an OpenRouter model in Settings → Voice.")),
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
    onStatus?.(status);
    throwIfVoiceTranscriptionAborted(options.signal);
    if (!status.supported)
      throw new VoiceTranscriptionError({ code: "unavailable", message: status.reason });
    if (status.state === "missing-model")
      throw new VoiceTranscriptionError({
        code: "unavailable",
        message: m(msg("Could not start voice input")),
      });
    const language = status.languages
      ? effectiveSpeechLanguage(
          {
            languages: status.languages,
            supportsLanguageDetection: status.supportsLanguageDetection ?? false,
          },
          recordingOptions.speechLanguage,
        )
      : "auto";
    const nativeStreaming = status.supportsStreaming && streamingEnabled;
    const batchLocale =
      status.supportsTranslation && recordingOptions.speechTranslateToEnglish ? "en" : language;
    const batch = { locale: batchLocale, transcribe: transcribeRecording };
    if (
      !canStream() ||
      (status.supportsStreaming ? !nativeStreaming : !status.supportsBufferedStreaming)
    ) {
      return batch;
    }
    const url = await runEnvironmentSpeech(getEnvironmentSpeechStreamUrl(input.prepared), options);
    if (!canStream()) return batch;
    return {
      locale: nativeStreaming ? language : batchLocale,
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
