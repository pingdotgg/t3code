import {
  VoiceTranscriptionError,
  VOICE_RECORDING_LIMIT_SECONDS,
  throwIfVoiceTranscriptionAborted,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";

const pcmBytesPerSecond = 16_000 * 2;
const maxPcmBytes = pcmBytesPerSecond * VOICE_RECORDING_LIMIT_SECONDS;

export function createEnvironmentTranscriber(input: {
  readonly canSend: () => boolean;
  readonly prepare: (signal: AbortSignal) => Promise<string>;
  readonly decode: (uri: string) => Promise<Uint8Array>;
  readonly upload: (pcm: Uint8Array, signal: AbortSignal) => Promise<string>;
}): VoiceTranscriber {
  function check(signal: AbortSignal) {
    throwIfVoiceTranscriptionAborted(signal);
    if (!input.canSend()) {
      throw new VoiceTranscriptionError({
        code: "cancelled",
        message: "Your transcription choice changed.",
      });
    }
  }
  return {
    async prepare({ signal }) {
      check(signal);
      const locale = await input.prepare(signal);
      check(signal);
      return {
        locale,
        async transcribe(uri, { signal }) {
          check(signal);
          const decoded = await input.decode(uri);
          check(signal);
          if (
            !decoded.length ||
            decoded.length % 2 ||
            decoded.length > maxPcmBytes + pcmBytesPerSecond
          ) {
            throw new VoiceTranscriptionError({
              code: "transcription-failed",
              message: "This recording couldn’t be read. Try recording again.",
            });
          }
          // A timed native stop can include a final encoder packet beyond the recording limit.
          const bytes = decoded.subarray(0, maxPcmBytes);
          const samples =
            bytes.byteOffset % 2 === 0
              ? new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2)
              : new Int16Array(Uint8Array.from(bytes).buffer);
          const pcm = new Float32Array(samples.length);
          for (let i = 0; i < samples.length; i++) pcm[i] = samples[i]! / 32768;
          const text = await input.upload(new Uint8Array(pcm.buffer), signal);
          check(signal);
          return text;
        },
      };
    },
  };
}
