// oxlint-disable t3code/no-global-process-runtime -- dedicated native voice child process.
// This entry point is run with the Electron executable in Node mode. It is
// intentionally not an Electron application: the desktop shell remains the
// only process that owns windows, menus, shortcuts, and renderer state.
// @effect-diagnostics nodeBuiltinImport:off globalProcess:off globalTimers:off

import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import {
  interruptNativeSpeech,
  onNativeSpeechTiming,
  parakeetModelPaths,
  prepareNativeMicrophone,
  prepareParakeetRecognition,
  speakNativeSpeech,
  startParakeetCapture,
  startParakeetPcmCapture,
  disposeNativeSpeech,
  classifyVoiceCaptureError,
} from "@t3tools/jarvis-native-voice";

import {
  parseDesktopVoiceWorkerCaptureSource,
  isDesktopVoiceWorkerRendererPcmCurrent,
  parseDesktopVoiceWorkerRendererPcmMessage,
  type DesktopVoiceWorkerCommand,
  type DesktopVoiceWorkerMessage,
  type DesktopVoiceWorkerState,
} from "./DesktopVoiceWorkerProtocol.ts";
import {
  createDesktopVoiceCaptureDeadline,
  DESKTOP_VOICE_FIRST_AUDIO_FRAME_DEADLINE_MS,
} from "./DesktopVoiceCaptureDeadline.ts";
import {
  bindDesktopVoiceCaptureResult,
  type DesktopVoiceCaptureSettlement,
} from "./DesktopVoiceCaptureCoordinator.ts";

let shuttingDown = false;
const captureAvailable =
  (process.platform === "win32" || process.platform === "linux") && process.arch === "x64";
const write = (message: DesktopVoiceWorkerMessage, allowDuringShutdown = false): void => {
  if (shuttingDown && !allowDuringShutdown) return;
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const removeSpeechTimingListener = onNativeSpeechTiming((timing) => {
  write({ type: "speech-timing", timing });
});

const resourceRoot = (): string => {
  const configured = process.env.JARVIS_VOICE_ROOT?.trim();
  if (configured) return configured;
  const electronResources = process.resourcesPath;
  if (typeof electronResources === "string") {
    return NodePath.join(electronResources, "jarvis-resources");
  }
  return NodePath.resolve(import.meta.dirname, "../../../packages/jarvis-native-voice/resources");
};

function configureVoiceResources(root: string): void {
  if (process.env.JARVIS_POCKET_ROOT?.trim()) return;
  process.env.JARVIS_POCKET_ROOT = NodePath.join(root, "pocket");
}

type WorkerCapture =
  | ReturnType<typeof startParakeetCapture>
  | ReturnType<typeof startParakeetPcmCapture>;
let capture: WorkerCapture | null = null;
let rendererCapture: ReturnType<typeof startParakeetPcmCapture> | null = null;
let rendererCaptureSessionId: string | undefined;
let rendererCaptureGeneration: number | undefined;
let captureReleased = false;
let captureFailureMessage: string | undefined;
let captureFailureCode: import("@t3tools/jarvis-native-voice").VoiceCaptureErrorCode | undefined;
const captureDeadline = createDesktopVoiceCaptureDeadline();
const firstAudioFrameDeadline = createDesktopVoiceCaptureDeadline({
  delayMs: DESKTOP_VOICE_FIRST_AUDIO_FRAME_DEADLINE_MS,
});

const clearCaptureDeadlines = (): void => {
  captureDeadline.clear();
  firstAudioFrameDeadline.clear();
};

const captureTimeoutMessage = "Voice capture timed out. Try again.";
const captureNoAudioMessage =
  "No audio was received from the microphone. Check microphone permissions and that an input device is connected.";

const setState = (next: DesktopVoiceWorkerState): void => {
  write({ type: "state", state: next });
};

const result = (requestId: string, cause?: unknown, allowDuringShutdown = false): void => {
  if (shuttingDown && !allowDuringShutdown) return;
  if (cause === undefined) {
    write({ type: "result", requestId, ok: true }, allowDuringShutdown);
    return;
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  const code = classifyVoiceCaptureError(cause);
  write({ type: "result", requestId, ok: false, message, code }, allowDuringShutdown);
};

const handle = async (command: DesktopVoiceWorkerCommand): Promise<boolean> => {
  if (shuttingDown && command.type !== "shutdown") return false;
  const root = resourceRoot();
  configureVoiceResources(root);
  const paths = parakeetModelPaths(NodePath.join(root, "parakeet"));
  try {
    switch (command.type) {
      case "prepare":
        if (captureAvailable) prepareNativeMicrophone();
        // Recognition is the resident path: keep Parakeet warm so the first
        // microphone frame never waits on model setup. Pocket remains lazy and
        // uses its own idle-offload lifecycle when a response actually speaks.
        await prepareParakeetRecognition(paths);
        if (capture === null) setState("ready");
        result(command.requestId);
        return false;
      case "capture-start":
        if (command.source?.type === "renderer-pcm" && process.platform !== "darwin") {
          result(command.requestId, new Error("Renderer PCM capture is only available on macOS."));
          return false;
        }
        if (command.source?.type !== "renderer-pcm" && !captureAvailable) {
          result(
            command.requestId,
            new Error("Microphone capture is unavailable on this platform."),
          );
          return false;
        }
        if (capture !== null) {
          result(command.requestId, new Error("Voice capture is already active."));
          return false;
        }
        // Push-to-talk is a barge-in action: stop Jarvis speaking before the
        // microphone opens, otherwise the recognizer can capture its own TTS.
        interruptNativeSpeech();
        setState("starting");
        const rendererSource = command.source?.type === "renderer-pcm" ? command.source : undefined;
        if (rendererSource === undefined) {
          capture = startParakeetCapture({
            paths,
            onReady: () => {
              if (shuttingDown || captureReleased) return;
              firstAudioFrameDeadline.arm(() => {
                if (shuttingDown || capture === null || captureReleased) return;
                captureFailureMessage = captureNoAudioMessage;
                captureFailureCode = "no-audio-frames";
                captureReleased = true;
                setState("transcribing");
                capture.cancel();
              });
              setState("capturing");
              write({ type: "capture-ready" });
            },
            onFirstAudioFrame: () => {
              firstAudioFrameDeadline.clear();
            },
            onAudioLevel: (level) => write({ type: "level", level }),
            onTranscript: (text) => write({ type: "transcript", text }),
          });
          rendererCapture = null;
          rendererCaptureSessionId = undefined;
          rendererCaptureGeneration = undefined;
        } else {
          rendererCapture = startParakeetPcmCapture({
            paths,
            sampleRate: rendererSource.sampleRate,
            channels: rendererSource.channels,
            platform: process.platform,
            onReady: () => {
              if (shuttingDown || captureReleased) return;
              firstAudioFrameDeadline.arm(() => {
                if (shuttingDown || capture === null || captureReleased) return;
                captureFailureMessage = captureNoAudioMessage;
                captureFailureCode = "no-audio-frames";
                captureReleased = true;
                setState("transcribing");
                capture.cancel();
              });
              setState("capturing");
              write({
                type: "capture-ready",
                sessionId: rendererSource.sessionId,
                generation: rendererSource.generation,
              });
            },
            onFirstAudioFrame: () => {
              firstAudioFrameDeadline.clear();
            },
            onAudioLevel: (level) => write({ type: "level", level }),
            onTranscript: (text) => write({ type: "transcript", text }),
          });
          capture = rendererCapture;
          rendererCaptureSessionId = rendererSource.sessionId;
          rendererCaptureGeneration = rendererSource.generation;
        }
        captureReleased = false;
        captureFailureMessage = undefined;
        captureFailureCode = undefined;
        captureDeadline.arm(() => {
          if (capture === null || captureReleased) return;
          captureFailureMessage = captureTimeoutMessage;
          captureFailureCode = "capture-timeout";
          captureReleased = true;
          setState("transcribing");
          capture.release();
        });
        const activeCapture = capture;
        bindDesktopVoiceCaptureResult({
          capture: activeCapture,
          result: activeCapture.result,
          isActive: (candidate) => capture === candidate,
          onSettled: (settlement: DesktopVoiceCaptureSettlement) => {
            clearCaptureDeadlines();
            if (settlement.ok) {
              write({ type: "capture-result", ok: true, text: settlement.text });
            } else {
              write({
                type: "capture-result",
                ok: false,
                message: captureFailureMessage ?? settlement.message,
                code:
                  captureFailureCode ??
                  settlement.code ??
                  classifyVoiceCaptureError(settlement.message),
              });
            }
            capture = null;
            rendererCapture = null;
            rendererCaptureSessionId = undefined;
            rendererCaptureGeneration = undefined;
            captureReleased = false;
            captureFailureMessage = undefined;
            captureFailureCode = undefined;
            setState("ready");
          },
        });
        result(command.requestId);
        return false;
      case "capture-release":
        clearCaptureDeadlines();
        if (capture !== null && !captureReleased) {
          setState("transcribing");
          captureReleased = true;
          capture.release();
        } else if (capture === null) setState("ready");
        result(command.requestId);
        return false;
      case "capture-cancel":
        clearCaptureDeadlines();
        if (capture !== null) {
          captureFailureMessage = "Voice capture was cancelled.";
          captureFailureCode = "cancelled";
          captureReleased = true;
          capture.cancel();
          setState("transcribing");
        } else setState("ready");
        result(command.requestId);
        return false;
      case "speak":
        setState("speaking");
        await speakNativeSpeech(command.text);
        setState("ready");
        result(command.requestId);
        return false;
      case "interrupt":
        clearCaptureDeadlines();
        captureFailureMessage = capture === null ? undefined : "Voice capture was cancelled.";
        captureFailureCode = capture === null ? undefined : "cancelled";
        interruptNativeSpeech();
        if (capture !== null) {
          captureReleased = true;
          capture.cancel();
        }
        if (capture === null) setState("ready");
        result(command.requestId);
        return false;
      case "shutdown":
        // This is deliberately synchronous: invalidate the capture and its
        // deadlines before awaiting model disposal, so stale callbacks cannot
        // publish a result during teardown.
        shuttingDown = true;
        removeSpeechTimingListener();
        clearCaptureDeadlines();
        captureFailureMessage = undefined;
        captureFailureCode = undefined;
        capture?.cancel();
        capture = null;
        rendererCapture = null;
        rendererCaptureSessionId = undefined;
        rendererCaptureGeneration = undefined;
        captureReleased = false;
        await disposeNativeSpeech();
        result(command.requestId, undefined, true);
        return true;
    }
  } catch (cause) {
    setState("error");
    result(command.requestId, cause);
    return false;
  }
};

const parseCommand = (line: string): DesktopVoiceWorkerCommand | null => {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null || !("type" in value)) return null;
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.requestId !== "string") return null;
    const source = parseDesktopVoiceWorkerCaptureSource(candidate.source);
    if (candidate.source !== undefined && source === undefined) return null;
    if (
      candidate.type === "prepare" ||
      candidate.type === "capture-start" ||
      candidate.type === "capture-release" ||
      candidate.type === "capture-cancel" ||
      candidate.type === "interrupt" ||
      candidate.type === "shutdown"
    ) {
      return {
        type: candidate.type,
        requestId: candidate.requestId,
        ...(candidate.type === "capture-start" && source !== undefined ? { source } : {}),
      } as DesktopVoiceWorkerCommand;
    }
    if (candidate.type === "speak" && typeof candidate.text === "string") {
      return { type: "speak", requestId: candidate.requestId, text: candidate.text };
    }
  } catch {
    // Malformed input is ignored; a broken renderer must not take down the
    // desktop process or turn the worker into an arbitrary command shell.
  }
  return null;
};

setState("starting");
void (async () => {
  try {
    if (captureAvailable) prepareNativeMicrophone();
    await prepareParakeetRecognition(parakeetModelPaths(NodePath.join(resourceRoot(), "parakeet")));
    setState("ready");
    write({ type: "ready" });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    write({ type: "fatal", message, code: "VOICE_UNAVAILABLE" });
    process.exitCode = 1;
  }
})();

const lines = NodeReadline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const command = parseCommand(line);
  if (command === null) return;
  void handle(command).then((shouldExit) => {
    if (shouldExit) {
      lines.close();
      if (process.connected) process.disconnect();
      process.exitCode = 0;
    }
  });
});

process.on("message", (value: unknown) => {
  const message = parseDesktopVoiceWorkerRendererPcmMessage(value);
  if (
    message === null ||
    shuttingDown ||
    captureReleased ||
    rendererCapture === null ||
    !isDesktopVoiceWorkerRendererPcmCurrent(
      message,
      rendererCaptureSessionId,
      rendererCaptureGeneration,
    )
  ) {
    return;
  }
  rendererCapture.feed(message.samples);
});
