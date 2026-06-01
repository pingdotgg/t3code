import type { AudioTranscriptionFormat } from "@t3tools/contracts";

const PREFERRED_AUDIO_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
  "audio/ogg",
] as const;

export const MAX_AUDIO_TRANSCRIPTION_BYTES = 24 * 1024 * 1024;
export const MAX_AUDIO_TRANSCRIPTION_SIZE_LABEL = "24MB";

export function getPreferredAudioRecordingOptions(): MediaRecorderOptions | undefined {
  if (typeof MediaRecorder === "undefined") {
    return undefined;
  }
  const mimeType = PREFERRED_AUDIO_MIME_TYPES.find((candidate) =>
    MediaRecorder.isTypeSupported(candidate),
  );
  return mimeType ? { mimeType } : undefined;
}

export function audioMimeTypeToTranscriptionFormat(mimeType: string): AudioTranscriptionFormat {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("mpeg") || normalized.includes("mp3")) return "mp3";
  if (normalized.includes("mp4") || normalized.includes("m4a")) return "m4a";
  if (normalized.includes("ogg")) return "ogg";
  if (normalized.includes("wav")) return "wav";
  if (normalized.includes("flac")) return "flac";
  if (normalized.includes("aac")) return "aac";
  if (normalized.includes("aiff")) return "aiff";
  if (normalized.includes("webm")) return "webm";
  return "webm";
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener(
      "load",
      () => {
        const result = typeof reader.result === "string" ? reader.result : "";
        const separatorIndex = result.indexOf(",");
        resolve(separatorIndex >= 0 ? result.slice(separatorIndex + 1) : result);
      },
      { once: true },
    );
    reader.addEventListener(
      "error",
      () => reject(reader.error ?? new Error("Failed to read audio recording.")),
      { once: true },
    );
    reader.readAsDataURL(blob);
  });
}

export function appendTranscriptionToPrompt(existingText: string, transcription: string): string {
  const addition = transcription.trim();
  if (!addition) {
    return existingText;
  }

  const existingWithoutHorizontalTrailingSpace = existingText.replace(/[ \t]+$/u, "");
  if (!existingWithoutHorizontalTrailingSpace.trim()) {
    return addition;
  }
  if (existingWithoutHorizontalTrailingSpace.endsWith("\n")) {
    return `${existingWithoutHorizontalTrailingSpace}${addition}`;
  }
  if (/^[,.;:!?)]/u.test(addition)) {
    return `${existingWithoutHorizontalTrailingSpace}${addition}`;
  }
  if (/[([{]$/u.test(existingWithoutHorizontalTrailingSpace)) {
    return `${existingWithoutHorizontalTrailingSpace}${addition}`;
  }
  return `${existingWithoutHorizontalTrailingSpace} ${addition}`;
}
