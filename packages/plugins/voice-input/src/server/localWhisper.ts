// @effect-diagnostics nodeBuiltinImport:off

import { execFile, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import type { VoiceInputSettings } from "../shared/schema.ts";
import { MODEL_DOWNLOAD_TIMEOUT_MS } from "../shared/schema.ts";
import { pythonCommandInvocation } from "./dependencies.ts";
import { markWhisperModelCached, whisperModelCacheDir } from "./modelCache.ts";

const HELPER_PATH = fileURLToPath(new URL("./local_whisper_helper.py", import.meta.url));
const INTERRUPT_KILL_GRACE_MS = 1_000;

interface HelperOutput {
  readonly stdout: string;
  readonly stderr: string;
}

class LocalWhisperProcessError extends Data.TaggedError("LocalWhisperProcessError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

function parseJsonObject(stdout: string): Record<string, unknown> {
  const parsed = JSON.parse(stdout.trim()) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Local Whisper helper returned an invalid JSON payload.");
  }
  return parsed as Record<string, unknown>;
}

function baseArgs(settings: VoiceInputSettings, cacheDir: string): string[] {
  return [
    "--model",
    settings.model,
    "--cache-dir",
    whisperModelCacheDir(cacheDir),
    "--device",
    settings.device,
  ];
}

function toLocalWhisperProcessError(cause: unknown): LocalWhisperProcessError {
  return cause instanceof LocalWhisperProcessError
    ? cause
    : new LocalWhisperProcessError({
        message: cause instanceof Error ? cause.message : "Local Whisper helper failed.",
        cause,
      });
}

function helperError(cause: unknown, stderr: string | Buffer): LocalWhisperProcessError {
  const error = toLocalWhisperProcessError(cause);
  const detail = String(stderr).trim();
  return detail.length === 0
    ? error
    : new LocalWhisperProcessError({ message: `${error.message}\n${detail}`, cause: error });
}

function waitForProcessClose(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    child.once("close", () => resolve());
  });
}

async function interruptChildProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  const closed = await Promise.race([
    waitForProcessClose(child).then(() => true),
    delay(INTERRUPT_KILL_GRACE_MS).then(() => false),
  ]);
  if (!closed && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await waitForProcessClose(child);
  }
}

function runHelper(
  pythonCommand: string,
  args: ReadonlyArray<string>,
  options: { readonly timeout: number; readonly maxBuffer: number },
): Effect.Effect<HelperOutput, LocalWhisperProcessError> {
  return Effect.callback<HelperOutput, LocalWhisperProcessError>((resume) => {
    const python = pythonCommandInvocation(pythonCommand);
    const child = (() => {
      try {
        return execFile(
          python.executable,
          [...python.args, ...args],
          {
            timeout: options.timeout,
            maxBuffer: options.maxBuffer,
          },
          (error, stdout, stderr) => {
            if (error) {
              resume(Effect.fail(helperError(error, stderr)));
              return;
            }
            resume(Effect.succeed({ stdout: String(stdout), stderr: String(stderr) }));
          },
        );
      } catch (error) {
        resume(Effect.fail(toLocalWhisperProcessError(error)));
        return null;
      }
    })();

    return child === null ? Effect.void : Effect.promise(() => interruptChildProcess(child));
  });
}

const markModelCached = (cacheDir: string, model: VoiceInputSettings["model"]) =>
  Effect.tryPromise({
    try: () => markWhisperModelCached(cacheDir, model),
    catch: toLocalWhisperProcessError,
  });

export function downloadWhisperModel(input: {
  readonly pythonCommand: string;
  readonly cacheDir: string;
  readonly settings: VoiceInputSettings;
}): Effect.Effect<void, LocalWhisperProcessError> {
  return Effect.gen(function* () {
    yield* runHelper(
      input.pythonCommand,
      [HELPER_PATH, "download", ...baseArgs(input.settings, input.cacheDir)],
      {
        timeout: MODEL_DOWNLOAD_TIMEOUT_MS,
        maxBuffer: 512 * 1024,
      },
    );
    yield* markModelCached(input.cacheDir, input.settings.model);
  });
}

export function smokeTestWhisperModel(input: {
  readonly pythonCommand: string;
  readonly cacheDir: string;
  readonly settings: VoiceInputSettings;
}): Effect.Effect<void, LocalWhisperProcessError> {
  return runHelper(
    input.pythonCommand,
    [HELPER_PATH, "smoke-test", ...baseArgs(input.settings, input.cacheDir)],
    {
      timeout: input.settings.transcriptionTimeoutSeconds * 1_000,
      maxBuffer: 512 * 1024,
    },
  ).pipe(Effect.asVoid);
}

export function transcribeWithLocalWhisper(input: {
  readonly pythonCommand: string;
  readonly cacheDir: string;
  readonly audioPath: string;
  readonly settings: VoiceInputSettings;
}): Effect.Effect<{ readonly text: string; readonly language?: string }, LocalWhisperProcessError> {
  const args = [
    HELPER_PATH,
    "transcribe",
    ...baseArgs(input.settings, input.cacheDir),
    "--audio",
    input.audioPath,
  ];
  if (input.settings.language !== "auto") {
    args.push("--language", input.settings.language);
  }
  const promptHint = input.settings.promptHint.trim();
  if (promptHint.length > 0) {
    args.push("--prompt", promptHint);
  }

  return Effect.gen(function* () {
    const result = yield* runHelper(input.pythonCommand, args, {
      timeout: input.settings.transcriptionTimeoutSeconds * 1_000,
      maxBuffer: 1024 * 1024,
    });
    const output = yield* Effect.try({
      try: () => parseJsonObject(result.stdout),
      catch: toLocalWhisperProcessError,
    });
    const text = typeof output["text"] === "string" ? output["text"].trim() : "";
    const language = typeof output["language"] === "string" ? output["language"] : undefined;
    yield* markModelCached(input.cacheDir, input.settings.model);
    return language ? { text, language } : { text };
  });
}
