// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import { AUDIO_BASE64_PATTERN } from "../shared/schema.ts";

interface TempAudioInput {
  readonly audioBase64: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}

class TempAudioFileError extends Data.TaggedError("TempAudioFileError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

function extensionForMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("webm")) return ".webm";
  if (normalized.includes("ogg")) return ".ogg";
  if (normalized.includes("mp4")) return ".m4a";
  if (normalized.includes("mpeg")) return ".mp3";
  if (normalized.includes("wav")) return ".wav";
  return ".audio";
}

function toTempAudioFileError(cause: unknown): TempAudioFileError {
  return cause instanceof TempAudioFileError
    ? cause
    : new TempAudioFileError({
        message: cause instanceof Error ? cause.message : "Temporary audio file operation failed.",
        cause,
      });
}

function decodeStrictBase64(value: string): Buffer {
  if (!AUDIO_BASE64_PATTERN.test(value)) {
    throw new TempAudioFileError({ message: "Recording payload was not valid base64." });
  }
  const audio = Buffer.from(value, "base64");
  if (audio.toString("base64") !== value) {
    throw new TempAudioFileError({ message: "Recording payload was not valid base64." });
  }
  return audio;
}

const writeTempAudioFile = (tempDir: string, input: TempAudioInput) =>
  Effect.tryPromise({
    try: async () => {
      const audio = decodeStrictBase64(input.audioBase64);
      if (audio.byteLength === 0) {
        throw new TempAudioFileError({ message: "Recording was empty." });
      }
      if (audio.byteLength !== input.sizeBytes) {
        throw new TempAudioFileError({
          message: "Recording size did not match the uploaded payload metadata.",
        });
      }

      const audioRoot = NodePath.join(tempDir, "audio");
      await NodeFs.mkdir(audioRoot, { recursive: true });
      let workDir: string | undefined;
      try {
        workDir = await NodeFs.mkdtemp(NodePath.join(audioRoot, "recording-"));
        const audioPath = NodePath.join(workDir, `input${extensionForMimeType(input.mimeType)}`);
        await NodeFs.writeFile(audioPath, audio);
        return { audioPath, workDir };
      } catch (error) {
        if (workDir !== undefined) {
          await NodeFs.rm(workDir, { recursive: true, force: true }).catch(() => {});
        }
        throw error;
      }
    },
    catch: toTempAudioFileError,
  });

export function withTempAudioFileEffect<A, E, R>(
  tempDir: string,
  input: TempAudioInput,
  useAudioFile: (audioPath: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | TempAudioFileError, R> {
  return Effect.acquireUseRelease(
    writeTempAudioFile(tempDir, input),
    ({ audioPath }) => useAudioFile(audioPath),
    ({ workDir }) =>
      Effect.promise(() => NodeFs.rm(workDir, { recursive: true, force: true })).pipe(
        Effect.ignore,
      ),
  );
}

export async function withTempAudioFile<A>(
  tempDir: string,
  input: TempAudioInput,
  useAudioFile: (audioPath: string) => Promise<A>,
): Promise<A> {
  return Effect.runPromise(
    withTempAudioFileEffect(tempDir, input, (audioPath) =>
      Effect.promise(() => useAudioFile(audioPath)),
    ),
  );
}
