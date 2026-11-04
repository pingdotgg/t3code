import {
  VoiceTranscriptionError,
  VOICE_RECORDING_LIMIT_SECONDS,
  throwIfVoiceTranscriptionAborted,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";

export function createEnvironmentTranscriber(input: {
  readonly canSend: () => boolean;
  readonly prepare: (signal: AbortSignal) => Promise<string>;
  readonly decode: (uri: string) => Promise<Uint8Array>;
  readonly upload: (pcm: Uint8Array, signal: AbortSignal) => Promise<string>;
}): VoiceTranscriber {
  function check(signal: AbortSignal) {
    throwIfVoiceTranscriptionAborted(signal);
    if (!input.canSend()) {
      throw new VoiceTranscriptionError("cancelled", "The transcription destination changed.");
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
            decoded.length > 16_000 * 2 * VOICE_RECORDING_LIMIT_SECONDS
          ) {
            throw new VoiceTranscriptionError("transcription-failed", "Invalid voice recording.");
          }
          const samples = new DataView(decoded.buffer, decoded.byteOffset, decoded.byteLength);
          const pcm = new Float32Array(decoded.length / 2);
          for (let i = 0; i < pcm.length; i++) pcm[i] = samples.getInt16(i * 2, true) / 32768;
          const text = await input.upload(new Uint8Array(pcm.buffer), signal);
          check(signal);
          return text;
        },
      };
    },
  };
}
