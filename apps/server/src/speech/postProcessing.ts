// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - on-demand native TTS worker subprocess and idle unload timer require Node child_process and timers.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import {
  DEFAULT_SPEECH_POST_PROCESSING_PROMPT,
  type EnvironmentSpeechPostProcessingRequest,
  type EnvironmentSpeechSynthesizeRequest,
  type SpeechModelUnloadTimeout,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { resolveSpeechPostProcessingModelSelection } from "@t3tools/shared/serverSettings";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { buildTranscriptionPostProcessingPrompt } from "../textGeneration/TranscriptionPostProcessing.ts";
import { applySpeechAliases } from "./customWords.ts";
import { SpeechOperationError } from "./SpeechService.ts";

const UNLOAD_MILLISECONDS: Readonly<Record<Exclude<SpeechModelUnloadTimeout, "never">, number>> = {
  immediately: 0,
  min_2: 2 * 60_000,
  min_5: 5 * 60_000,
  min_10: 10 * 60_000,
  min_15: 15 * 60_000,
  hour_1: 60 * 60_000,
};

const SPOKEN_SUMMARY_INSTRUCTIONS = `Summarize this assistant response into 2 to 4 concise, natural spoken sentences suitable for reading aloud via text-to-speech.
Focus on the key takeaway, answer, or action taken.
Omit raw code blocks, diffs, URLs, and markdown syntax.
Use the same language as the response.
Return only the spoken summary text.`;

function prepareSpokenMarkdown(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " Code block omitted. ")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/^\s*\|[-:\s|]+\|\s*$/gm, " ")
    .replace(/\|/g, " ")
    .replace(/^\s{0,3}(?:#{1,6}|>+|-|\*|\+)\s+/gm, "")
    .replace(/(\*\*|__|~~)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractiveSpokenSummary(markdown: string): string {
  const cleaned = prepareSpokenMarkdown(markdown);
  if (cleaned.length <= 480) return cleaned;
  const sentences = cleaned.split(/(?<=[.!?])\s+/);
  let summary = "";
  for (const sentence of sentences) {
    const candidate = summary ? `${summary} ${sentence}` : sentence;
    if (candidate.length > 480 && summary.length > 0) break;
    summary = candidate;
    if (summary.length >= 360) break;
  }
  return summary || cleaned.slice(0, 480).trim();
}

function detectSpeechLanguage(text: string): string {
  return /[äöüßÄÖÜ]|\b(und|der|die|das|nicht|ist|für|mit|auf|ein|eine)\b/i.test(text)
    ? "de"
    : "en-us";
}

const KOKORO_WORKER_SCRIPT = `
import base64, io, json, sys
import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro

model_path, voices_path = sys.argv[1], sys.argv[2]
kokoro = Kokoro(model_path, voices_path)

for raw_line in sys.stdin:
    line = raw_line.strip()
    if not line:
        continue
    try:
        request = json.loads(line)
        text = request.get("text", "").strip()
        lang = request.get("lang", "en-us")
        voice = request.get("voice", "af_heart")
        chunks = [part.strip() for part in text.replace("\\n", " ").split(". ") if part.strip()]
        if not chunks:
            chunks = ["."]
        audio_parts = []
        sample_rate = 24000
        for chunk in chunks:
            segment = chunk if chunk.endswith((".", "!", "?")) else chunk + "."
            samples, sample_rate = kokoro.create(segment, voice=voice, speed=1.0, lang=lang)
            audio_parts.append(samples)
        combined = np.concatenate(audio_parts) if len(audio_parts) > 1 else audio_parts[0]
        buffer = io.BytesIO()
        sf.write(buffer, combined, sample_rate, format="WAV", subtype="PCM_16")
        encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
        sys.stdout.write(json.dumps({"ok": True, "wavBase64": encoded}) + "\\n")
        sys.stdout.flush()
    except Exception as exc:
        sys.stdout.write(json.dumps({"ok": False, "error": str(exc)}) + "\\n")
        sys.stdout.flush()
`;

type PendingWorkerReply = {
  readonly resolve: (bytes: Uint8Array) => void;
  readonly reject: (error: Error) => void;
};

class OnDemandKokoroWorker {
  private child: NodeChildProcess.ChildProcessWithoutNullStreams | null = null;
  private queue: PendingWorkerReply[] = [];
  private unloadTimer: ReturnType<typeof setTimeout> | null = null;
  private serial: Promise<void> = Promise.resolve();

  private clearTimer() {
    if (this.unloadTimer !== null) {
      clearTimeout(this.unloadTimer);
      this.unloadTimer = null;
    }
  }

  private scheduleUnload(timeout: SpeechModelUnloadTimeout) {
    this.clearTimer();
    if (timeout === "never") return;
    const delayMs = UNLOAD_MILLISECONDS[timeout];
    if (delayMs <= 0) {
      this.stop();
      return;
    }
    this.unloadTimer = setTimeout(() => {
      this.stop();
    }, delayMs);
    this.unloadTimer.unref?.();
  }

  stop() {
    this.clearTimer();
    const running = this.child;
    this.child = null;
    if (running) {
      running.kill("SIGTERM");
    }
    const pending = this.queue.splice(0);
    for (const item of pending) {
      item.reject(new Error("TTS worker stopped."));
    }
  }

  private ensureProcess(modelPath: string, voicesPath: string) {
    if (this.child && !this.child.killed && this.child.exitCode === null) {
      return this.child;
    }
    const child = NodeChildProcess.spawn(
      "uv",
      [
        "run",
        "--offline",
        "--with",
        "kokoro-onnx",
        "--with",
        "soundfile",
        "python3",
        "-u",
        "-c",
        KOKORO_WORKER_SCRIPT,
        modelPath,
        voicesPath,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const reader = NodeReadline.createInterface({ input: child.stdout });
    reader.on("line", (line) => {
      const current = this.queue.shift();
      if (!current) return;
      try {
        const parsed = JSON.parse(line) as {
          readonly ok: boolean;
          readonly wavBase64?: string;
          readonly error?: string;
        };
        if (parsed.ok && parsed.wavBase64) {
          current.resolve(new Uint8Array(Buffer.from(parsed.wavBase64, "base64")));
        } else {
          current.reject(new Error(parsed.error ?? "Kokoro synthesis failed."));
        }
      } catch (error) {
        current.reject(error instanceof Error ? error : new Error("Invalid Kokoro worker reply."));
      }
    });
    const failAll = (reason: string) => {
      if (this.child === child) this.child = null;
      const pending = this.queue.splice(0);
      for (const item of pending) {
        item.reject(new Error(reason));
      }
    };
    child.on("error", (error) => failAll(error.message));
    child.on("close", (code) => failAll(`Kokoro worker exited with code ${code ?? "unknown"}.`));
    this.child = child;
    return child;
  }

  synthesize(text: string, timeout: SpeechModelUnloadTimeout): Promise<Uint8Array> {
    const home = NodeOS.homedir();
    const ttsDir = NodePath.join(home, ".cache", "t3code", "tts");
    const modelPath = NodePath.join(ttsDir, "kokoro-v1.0.int8.onnx");
    const voicesPath = NodePath.join(ttsDir, "voices-v1.0.bin");
    if (!NodeFS.existsSync(modelPath) || !NodeFS.existsSync(voicesPath)) {
      return Promise.reject(new Error("Kokoro model files are not installed."));
    }
    this.clearTimer();
    const task = this.serial.then(
      () =>
        new Promise<Uint8Array>((resolve, reject) => {
          const child = this.ensureProcess(modelPath, voicesPath);
          this.queue.push({ resolve, reject });
          const payload = JSON.stringify({
            text,
            lang: detectSpeechLanguage(text),
            voice: "af_heart",
          });
          child.stdin.write(`${payload}\n`, (error) => {
            if (error) {
              const index = this.queue.findIndex((entry) => entry.resolve === resolve);
              if (index >= 0) this.queue.splice(index, 1);
              reject(error);
            }
          });
        }),
    );
    this.serial = task.then(
      () => {
        this.scheduleUnload(timeout);
      },
      () => {
        this.scheduleUnload(timeout);
      },
    );
    return task;
  }
}

const sharedKokoroWorker = new OnDemandKokoroWorker();

function synthesizeWithMacSay(text: string): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-tts-"));
    const outputWav = NodePath.join(tempDir, "speech.wav");
    const cleanup = () => {
      try {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        return;
      }
    };
    const child = NodeChildProcess.spawn(
      "/usr/bin/say",
      ["-o", outputWav, "--data-format=LEI16@22050", text],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        cleanup();
        reject(new Error(`macOS say exited with code ${code ?? "unknown"}.`));
        return;
      }
      try {
        const bytes = new Uint8Array(NodeFS.readFileSync(outputWav));
        cleanup();
        resolve(bytes);
      } catch (error) {
        cleanup();
        reject(error instanceof Error ? error : new Error("Failed to read synthesized WAV."));
      }
    });
  });
}

export type SpeechAudioSynthesizer = (
  text: string,
  timeout: SpeechModelUnloadTimeout,
) => Effect.Effect<Uint8Array, SpeechOperationError>;

const makeDefaultSynthesizeAudio = (platform: NodeJS.Platform): SpeechAudioSynthesizer =>
  Effect.fn("SpeechPostProcessing.synthesizeAudio")(function* (
    text: string,
    timeout: SpeechModelUnloadTimeout,
  ) {
    return yield* Effect.tryPromise({
      try: () =>
        sharedKokoroWorker.synthesize(text, timeout).catch((error) => {
          if (platform === "darwin") return synthesizeWithMacSay(text);
          throw error;
        }),
      catch: (cause) => new SpeechOperationError({ operation: "synthesis", cause }),
    });
  });

export class SpeechPostProcessing extends Context.Service<
  SpeechPostProcessing,
  {
    readonly process: (
      input: EnvironmentSpeechPostProcessingRequest,
    ) => Effect.Effect<{ readonly text: string }, SpeechOperationError>;
    readonly synthesize: (
      input: EnvironmentSpeechSynthesizeRequest,
    ) => Effect.Effect<Uint8Array, SpeechOperationError>;
  }
>()("t3/speech/postProcessing/SpeechPostProcessing") {}

export const make = Effect.fn("SpeechPostProcessing.make")(function* (
  customSynthesizeAudio?: SpeechAudioSynthesizer,
) {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const platform = yield* HostProcess.Platform;
  const synthesizeAudio = customSynthesizeAudio ?? makeDefaultSynthesizeAudio(platform);
  return SpeechPostProcessing.of({
    process: Effect.fn("SpeechPostProcessing.process")(
      function* (input) {
        if (input.transcript.trim().length === 0) return { text: input.transcript };
        const settings = yield* settingsService.getSettings;
        const providers = yield* providerRegistry.getProviders;
        const { mode, customInstructions } = input.options.speechPostProcessingPrompt;
        const instructions =
          (mode === "custom" ? customInstructions.trim() : "") ||
          DEFAULT_SPEECH_POST_PROCESSING_PROMPT;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-voice-cleanup-" });
        const generated = yield* textGeneration.generateTranscriptionPostProcessing({
          cwd,
          prompt: buildTranscriptionPostProcessingPrompt(
            instructions,
            input.transcript,
            input.draft,
            input.options.speechCorrectionWord,
          ),
          modelSelection: resolveSpeechPostProcessingModelSelection(settings, providers),
        });
        const text = generated.transcription.trim();
        return {
          text:
            text.length > 0
              ? applySpeechAliases(text, input.options.speechCustomWords)
              : input.transcript,
        };
      },
      Effect.scoped,
      Effect.mapError((cause) => new SpeechOperationError({ operation: "post-processing", cause })),
    ),
    synthesize: Effect.fn("SpeechPostProcessing.synthesize")(
      function* (input) {
        const settings = yield* settingsService.getSettings;
        const cleaned = prepareSpokenMarkdown(input.text);
        let spokenText = cleaned || input.text.trim();
        if (input.mode === "summary" && spokenText.length > 240) {
          const providers = yield* providerRegistry.getProviders;
          const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-voice-summary-" });
          const generated = yield* textGeneration
            .generateTranscriptionPostProcessing({
              cwd,
              prompt: buildTranscriptionPostProcessingPrompt(
                SPOKEN_SUMMARY_INSTRUCTIONS,
                spokenText,
                { text: "", selection: { start: 0, end: 0 } },
                "",
              ),
              modelSelection: resolveSpeechPostProcessingModelSelection(settings, providers),
            })
            .pipe(
              Effect.orElseSucceed(() => ({
                transcription: extractiveSpokenSummary(input.text),
              })),
            );
          const candidate = prepareSpokenMarkdown(generated.transcription);
          spokenText = candidate.length > 0 ? candidate : extractiveSpokenSummary(input.text);
        }
        return yield* synthesizeAudio(spokenText, settings.speechModelUnloadTimeout);
      },
      Effect.scoped,
      Effect.mapError((cause) => new SpeechOperationError({ operation: "synthesis", cause })),
    ),
  });
});

export const layer = Layer.effect(SpeechPostProcessing, make());
