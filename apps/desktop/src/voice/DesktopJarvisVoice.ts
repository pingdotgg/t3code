// oxlint-disable t3code/no-global-process-runtime -- Desktop owns this native process boundary.
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { DesktopJarvisVoiceState, DesktopJarvisVoiceStatus } from "@t3tools/contracts";
import { createVoiceCaptureError, isVoiceCaptureErrorCode } from "@t3tools/jarvis-native-voice";
import * as Electron from "electron";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import {
  type DesktopVoiceWorkerCommand,
  type DesktopVoiceWorkerCaptureSource,
  type DesktopVoiceWorkerMessage,
  parseDesktopVoiceWorkerMessage,
} from "./DesktopVoiceWorkerProtocol.ts";
import * as IpcChannels from "../ipc/channels.ts";

type VoiceChild = NodeChildProcess.ChildProcess;
type Pending = {
  readonly resolve: () => void;
  readonly reject: (cause: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};
type PendingPcmSend = {
  readonly promise: Promise<boolean>;
  readonly settle: (accepted: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type DesktopJarvisVoicePcmFrame = {
  readonly sessionId: string;
  readonly generation: number;
  readonly samples: Float32Array;
};

const STARTUP_TIMEOUT_MS = 15_000;
const PCM_SEND_TIMEOUT_MS = 2_000;
const CAPTURE_COMMAND_TIMEOUT_MS = 5_000;
const { logInfo: logVoiceInfo } = makeComponentLogger("desktop-jarvis-voice");

const isCaptureCommand = (
  type: DesktopVoiceWorkerCommand["type"],
): type is "capture-start" | "capture-release" | "capture-cancel" =>
  type === "capture-start" || type === "capture-release" || type === "capture-cancel";

const isNativePlatform = (platform: NodeJS.Platform): boolean =>
  platform === "darwin" || platform === "linux" || platform === "win32";

/**
 * Resolves the voice model directory from Desktop's own packaged resources.
 * Companion is an optional remote peripheral and is never a Desktop runtime
 * dependency.
 */
export function resolveDesktopJarvisVoiceResourceRoot(input: {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly executablePath: string;
  readonly developmentResourceRoot: string;
  readonly exists?: (path: string) => boolean;
}): string | null {
  const path = input.platform === "win32" ? NodePath.win32 : NodePath.posix;
  const exists = input.exists ?? NodeFS.existsSync;
  const candidates = input.isPackaged
    ? [path.join(input.resourcesPath, "jarvis-resources")]
    : [input.developmentResourceRoot];
  return candidates.find(exists) ?? null;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function state(status: DesktopJarvisVoiceStatus, native: boolean, errorCode?: string) {
  return {
    status,
    native,
    ...(errorCode === undefined ? {} : { errorCode }),
  } satisfies DesktopJarvisVoiceState;
}

/** Broadcasts a worker event defensively across renderers during teardown. */
export function broadcastDesktopJarvisVoiceMessage(input: {
  readonly message: DesktopVoiceWorkerMessage;
  readonly native: boolean;
  readonly windows?: readonly Electron.BrowserWindow[];
}): void {
  const send = (window: Electron.BrowserWindow, channel: string, value: unknown): void => {
    try {
      if (!window.isDestroyed()) window.webContents.send(channel, value);
    } catch {
      // A renderer can disappear between isDestroyed and send during quit.
    }
  };
  let windows: readonly Electron.BrowserWindow[];
  try {
    windows = input.windows ?? Electron.BrowserWindow.getAllWindows();
  } catch {
    return;
  }
  for (const window of windows) {
    const message = input.message;
    if (message.type === "state") {
      send(window, IpcChannels.JARVIS_VOICE_STATE_CHANNEL, state(message.state, input.native));
    } else if (message.type === "transcript") {
      send(window, IpcChannels.JARVIS_VOICE_TRANSCRIPT_CHANNEL, message.text);
    } else if (message.type === "error") {
      send(window, IpcChannels.JARVIS_VOICE_ERROR_CHANNEL, message.message);
    }
  }
}

export interface DesktopJarvisVoice {
  readonly getState: () => DesktopJarvisVoiceState;
  readonly prepare: () => Promise<DesktopJarvisVoiceState>;
  readonly startCapture: (
    source?: DesktopVoiceWorkerCaptureSource,
  ) => Promise<{ readonly accepted: boolean }>;
  readonly pushPcmFrame: (
    frame: DesktopJarvisVoicePcmFrame,
  ) => Promise<{ readonly accepted: boolean }>;
  readonly releaseCapture: () => Promise<{ readonly accepted: boolean }>;
  readonly cancelCapture: () => Promise<{ readonly accepted: boolean }>;
  readonly speak: (text: string) => Promise<{ readonly accepted: boolean }>;
  readonly interrupt: () => Promise<{ readonly accepted: boolean }>;
  readonly onState: (listener: (state: DesktopJarvisVoiceState) => void) => () => void;
  readonly onLevel: (listener: (level: number) => void) => () => void;
  readonly stop: () => void;
}

export class DesktopJarvisVoiceService extends Context.Service<
  DesktopJarvisVoiceService,
  DesktopJarvisVoice
>()("@t3tools/desktop/voice/DesktopJarvisVoice/DesktopJarvisVoiceService") {}

export function createDesktopJarvisVoice(input: {
  readonly platform: NodeJS.Platform;
  readonly architecture?: NodeJS.Architecture;
  readonly workerPath: string | null;
  readonly resourceRoot: string | null;
  readonly executablePath?: string;
  readonly spawn?: typeof NodeChildProcess.spawn;
  readonly emit?: (message: DesktopVoiceWorkerMessage) => void;
  readonly startupTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
}): DesktopJarvisVoice {
  const native = isNativePlatform(input.platform);
  const captureAvailable =
    (input.platform === "win32" || input.platform === "linux") &&
    (input.architecture ?? process.arch) === "x64";
  const rendererCaptureAvailable = input.platform === "darwin";
  const executablePath = input.executablePath ?? process.execPath;
  const spawn = input.spawn ?? NodeChildProcess.spawn;
  const emit = input.emit ?? (() => undefined);
  let current = state(
    input.workerPath === null || input.resourceRoot === null || !native
      ? "unavailable"
      : "starting",
    native,
  );
  let child: VoiceChild | null = null;
  let startup: Promise<void> | null = null;
  let sequence = 0;
  let stopped = false;
  let generation = 0;
  let output = "";
  const pending = new Map<string, Pending>();
  const pendingPcmSends = new Set<PendingPcmSend>();
  const commandTimeoutMs = input.commandTimeoutMs ?? CAPTURE_COMMAND_TIMEOUT_MS;
  let activeRendererCapture:
    | Extract<DesktopVoiceWorkerCaptureSource, { readonly type: "renderer-pcm" }>
    | undefined;
  let activeNativeCapture = false;
  const stateListeners = new Set<(next: DesktopJarvisVoiceState) => void>();
  const levelListeners = new Set<(level: number) => void>();

  const settlePendingPcmSends = (accepted: boolean): void => {
    for (const pendingPcmSend of pendingPcmSends) {
      clearTimeout(pendingPcmSend.timer);
      pendingPcmSends.delete(pendingPcmSend);
      pendingPcmSend.settle(accepted);
    }
  };

  const setState = (next: DesktopJarvisVoiceState) => {
    if (stopped) return;
    current = next;
    emit({ type: "state", state: next.status === "unavailable" ? "error" : next.status });
    for (const listener of stateListeners) {
      try {
        listener(next);
      } catch {
        // A shell/renderer observer must not affect worker orchestration.
      }
    }
  };

  const failAll = (cause: Error, expectedChild?: VoiceChild) => {
    if (stopped || (expectedChild !== undefined && child !== expectedChild)) return;
    const failedChild = child;
    for (const request of pending.values()) {
      if (request.timer !== undefined) clearTimeout(request.timer);
      request.reject(cause);
    }
    pending.clear();
    activeRendererCapture = undefined;
    activeNativeCapture = false;
    settlePendingPcmSends(false);
    child = null;
    startup = null;
    if (failedChild !== null && !failedChild.killed) failedChild.kill("SIGTERM");
    setState(state("error", native, "WORKER_EXITED"));
  };

  const handleMessage = (message: DesktopVoiceWorkerMessage): void => {
    if (message.type === "ready") {
      if (activeNativeCapture || activeRendererCapture !== undefined) return;
      setState(state("ready", native));
      return;
    }
    if (message.type === "state") {
      if (
        message.state === "ready" &&
        (activeNativeCapture || activeRendererCapture !== undefined)
      ) {
        return;
      }
      setState(state(message.state, native));
      return;
    }
    if (message.type === "transcript") {
      emit(message);
      return;
    }
    if (message.type === "level") {
      for (const listener of levelListeners) {
        try {
          listener(message.level);
        } catch {
          // A waveform observer must not affect worker orchestration.
        }
      }
      return;
    }
    if (message.type === "speech-timing") {
      emit(message);
      return;
    }
    if (message.type === "capture-result") {
      activeNativeCapture = false;
      activeRendererCapture = undefined;
      if (!message.ok) {
        emit({
          type: "error",
          message: message.message,
          ...(message.code === undefined ? {} : { code: message.code }),
        });
      }
      return;
    }
    if (message.type === "fatal") {
      emit({
        type: "error",
        message: message.message,
        ...(isVoiceCaptureErrorCode(message.code) ? { code: message.code } : {}),
      });
      setState(state("error", native, message.code ?? "VOICE_UNAVAILABLE"));
      return;
    }
    if (message.type !== "result") return;
    const request = pending.get(message.requestId);
    if (request === undefined) return;
    pending.delete(message.requestId);
    if (request.timer !== undefined) clearTimeout(request.timer);
    if (message.ok) request.resolve();
    else
      request.reject(
        message.code === undefined
          ? new Error(message.message)
          : createVoiceCaptureError(message.code, message.message),
      );
  };

  const send = (type: DesktopVoiceWorkerCommand["type"], extra: Record<string, unknown> = {}) => {
    const commandChild = child;
    const commandStdin = commandChild?.stdin;
    if (
      commandChild === null ||
      commandStdin === null ||
      commandStdin === undefined ||
      commandStdin.destroyed
    ) {
      return Promise.reject(new Error("Jarvis native voice worker is not running."));
    }
    const requestId = `voice-${sequence++}`;
    const command = { type, requestId, ...extra };
    return new Promise<void>((resolve, reject) => {
      const request: Pending = { resolve, reject };
      pending.set(requestId, request);
      if (isCaptureCommand(type)) {
        request.timer = setTimeout(() => {
          if (pending.get(requestId) !== request) return;
          const timeout = new Error(`Voice worker ${type} command timed out.`);
          failAll(timeout, commandChild);
        }, commandTimeoutMs);
      }
      commandStdin.write(`${JSON.stringify(command)}\n`, (cause) => {
        if (cause === undefined || cause === null) return;
        pending.delete(requestId);
        if (request.timer !== undefined) clearTimeout(request.timer);
        reject(cause);
      });
    });
  };

  const ensureWorker = async (): Promise<void> => {
    if (stopped) throw new Error("Jarvis native voice worker has been stopped.");
    if (!native || input.workerPath === null || input.resourceRoot === null) {
      throw new Error("Native voice is unavailable on this platform.");
    }
    if (startup !== null) return startup;
    if (child !== null && current.status !== "error") return;
    if (child !== null) {
      // A fatal worker message can leave the process alive. Do not layer a
      // second worker over it on Retry: clear its pending requests and stop it
      // before replacing the handle.
      const staleChild = child;
      child = null;
      for (const request of pending.values()) {
        request.reject(new Error("Voice worker restarted."));
      }
      pending.clear();
      if (!staleChild.killed) staleChild.kill("SIGTERM");
    }
    startup = new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        if (child !== null && !child.killed) child.kill("SIGTERM");
        settled = true;
        reject(new Error("Native voice worker did not become ready."));
      }, input.startupTimeoutMs ?? STARTUP_TIMEOUT_MS);
      const finish = (cause?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (cause === undefined) resolve();
        else reject(cause);
      };
      try {
        output = "";
        child = spawn(executablePath, [input.workerPath!], {
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: "1",
            JARVIS_VOICE_ROOT: input.resourceRoot!,
            JARVIS_POCKET_ROOT: NodePath.join(input.resourceRoot!, "pocket"),
          },
          stdio: ["pipe", "pipe", "pipe", "ipc"],
          serialization: "advanced",
          windowsHide: true,
        });
      } catch (cause) {
        finish(new Error(errorMessage(cause)));
        return;
      }
      const activeChild = child;
      const activeGeneration = ++generation;
      activeChild.stdout?.on("data", (chunk: Buffer | string) => {
        if (stopped || child !== activeChild || generation !== activeGeneration) return;
        output += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        const lines = output.split(/\r?\n/u);
        output = lines.pop() ?? "";
        for (const line of lines) {
          try {
            const parsed: unknown = JSON.parse(line);
            const message = parseDesktopVoiceWorkerMessage(parsed);
            if (message !== null) {
              handleMessage(message);
              if (message.type === "ready") finish();
              if (message.type === "fatal") finish(new Error(message.message));
            }
          } catch {
            // Keep the protocol line-oriented and ignore diagnostics that do
            // not conform to the worker contract.
          }
        }
      });
      activeChild.stderr?.on("data", () => undefined);
      activeChild.once("error", (cause) => {
        failAll(cause instanceof Error ? cause : new Error(String(cause)), activeChild);
        finish(cause instanceof Error ? cause : new Error(String(cause)));
      });
      activeChild.once("exit", (code) => {
        if (stopped || child !== activeChild || generation !== activeGeneration) return;
        if (!settled) finish(new Error(`Native voice worker exited (${code ?? "unknown"}).`));
        failAll(new Error("Native voice worker exited."), activeChild);
      });
    }).finally(() => {
      startup = null;
    });
    try {
      await startup;
    } catch (cause) {
      setState(state("error", native, "WORKER_START_FAILED"));
      throw cause;
    }
  };

  const command = async (
    type: DesktopVoiceWorkerCommand["type"],
    extra?: Record<string, unknown>,
  ): Promise<{ readonly accepted: boolean }> => {
    try {
      await ensureWorker();
      await send(type, extra);
      return { accepted: true };
    } catch {
      return { accepted: false };
    }
  };

  const pushPcmFrame = (
    frame: DesktopJarvisVoicePcmFrame,
  ): Promise<{ readonly accepted: boolean }> => {
    const active = activeRendererCapture;
    if (
      !rendererCaptureAvailable ||
      active === undefined ||
      active.sessionId !== frame.sessionId ||
      active.generation !== frame.generation ||
      child === null ||
      child.connected === false ||
      typeof child.send !== "function"
    ) {
      return Promise.resolve({ accepted: false });
    }
    const activeChild = child;
    let settle!: (accepted: boolean) => void;
    const sendPromise = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    const pendingPcmSend: PendingPcmSend = {
      promise: sendPromise,
      settle,
      timer: setTimeout(() => {
        if (!pendingPcmSends.delete(pendingPcmSend)) return;
        settle(false);
      }, PCM_SEND_TIMEOUT_MS),
    };
    pendingPcmSends.add(pendingPcmSend);
    const finishSend = (accepted: boolean): void => {
      if (!pendingPcmSends.delete(pendingPcmSend)) return;
      clearTimeout(pendingPcmSend.timer);
      settle(accepted);
    };
    try {
      activeChild.send?.(
        {
          type: "renderer-pcm",
          sessionId: frame.sessionId,
          generation: frame.generation,
          samples: frame.samples,
        },
        (cause) => {
          finishSend(cause === null);
        },
      );
    } catch {
      finishSend(false);
    }
    return sendPromise.then((accepted) => ({ accepted }));
  };

  const releaseCapture = async (): Promise<{ readonly accepted: boolean }> => {
    if (!captureAvailable && activeRendererCapture === undefined && !activeNativeCapture) {
      return { accepted: false };
    }
    const releaseChild = child;
    try {
      await Promise.allSettled([...pendingPcmSends].map((pending) => pending.promise));
      if (releaseChild !== null && child !== releaseChild) return { accepted: false };
      return await command("capture-release");
    } finally {
      activeRendererCapture = undefined;
      activeNativeCapture = false;
    }
  };

  const cancelCapture = async (): Promise<{ readonly accepted: boolean }> => {
    if (!captureAvailable && activeRendererCapture === undefined && !activeNativeCapture) {
      return { accepted: false };
    }
    const cancelChild = child;
    try {
      settlePendingPcmSends(false);
      if (cancelChild !== null && child !== cancelChild) return { accepted: false };
      return await command("capture-cancel");
    } finally {
      activeRendererCapture = undefined;
      activeNativeCapture = false;
    }
  };

  return {
    getState: () => current,
    prepare: async () => {
      await ensureWorker();
      await send("prepare");
      return current;
    },
    startCapture: async (source = { type: "native" as const }) => {
      if (source.type === "renderer-pcm") {
        if (!rendererCaptureAvailable) return { accepted: false };
        activeRendererCapture = source;
        const result = await command("capture-start", { source });
        if (!result.accepted && activeRendererCapture === source) activeRendererCapture = undefined;
        return result;
      }
      if (!captureAvailable) return { accepted: false };
      activeNativeCapture = true;
      const result = await command("capture-start");
      if (!result.accepted) activeNativeCapture = false;
      return result;
    },
    pushPcmFrame,
    releaseCapture,
    cancelCapture,
    speak: (text) =>
      text.trim().length === 0 ? Promise.resolve({ accepted: false }) : command("speak", { text }),
    interrupt: () => command("interrupt"),
    onState: (listener) => {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    onLevel: (listener) => {
      levelListeners.add(listener);
      return () => levelListeners.delete(listener);
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      generation += 1;
      const activeChild = child;
      child = null;
      activeRendererCapture = undefined;
      activeNativeCapture = false;
      settlePendingPcmSends(false);
      startup = null;
      for (const request of pending.values()) {
        if (request.timer !== undefined) clearTimeout(request.timer);
        request.reject(new Error("Voice worker stopped."));
      }
      pending.clear();
      if (activeChild !== null && !activeChild.killed) activeChild.kill("SIGTERM");
    },
  };
}

export const layer = Layer.effect(
  DesktopJarvisVoiceService,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const context = yield* Effect.context<DesktopEnvironment.DesktopEnvironment>();
    const runFork = Effect.runForkWith(context);
    const workerPath = NodePath.join(environment.dirname, "desktopVoiceWorker.cjs");
    const resourceRoot = resolveDesktopJarvisVoiceResourceRoot({
      platform: environment.platform,
      isPackaged: environment.isPackaged,
      resourcesPath: environment.resourcesPath,
      executablePath: environment.executablePath,
      developmentResourceRoot: NodePath.resolve(
        environment.dirname,
        "../../../packages/jarvis-native-voice/resources",
      ),
    });
    return createDesktopJarvisVoice({
      platform: environment.platform,
      workerPath,
      resourceRoot,
      executablePath: environment.executablePath,
      emit: (message) => {
        if (message.type === "speech-timing") {
          runFork(logVoiceInfo("Pocket speech timing", message.timing));
        }
        broadcastDesktopJarvisVoiceMessage({
          message,
          native: isNativePlatform(environment.platform),
        });
      },
    });
  }),
);
