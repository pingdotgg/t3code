// @effect-diagnostics globalTimers:off - this timer bounds native microphone capture.
import type { DesktopSpeechEvent, DesktopSpeechStatus } from "@t3tools/contracts";

type Capture = {
  start(): void;
  stop(): Promise<Float32Array>;
  cancel(): Promise<void>;
};

type Backend = {
  prepare(): Promise<void>;
  transcribe(pcm: Float32Array): Promise<string>;
  dispose(): Promise<void>;
};

type BackendPreparation = { readonly ok: true } | { readonly ok: false; readonly error: unknown };

type ControllerOptions = {
  supported: boolean;
  unsupportedReason?: string;
  modelPath: string;
  modelReady(): Promise<boolean>;
  downloadModel(onProgress: (downloaded: number, total: number) => void): Promise<string>;
  removeModel(): Promise<void>;
  createCapture(): Capture;
  createBackend(modelPath: string): Backend;
  emit(event: DesktopSpeechEvent): void;
  maxRecordingMs?: number;
};

export class DesktopSpeechController {
  private readonly options: ControllerOptions;
  private capture: Capture | undefined;
  private backend: Backend | undefined;
  private backendReady: Promise<BackendPreparation> | undefined;
  private modelPath: string | undefined;
  private state:
    | "missing-model"
    | "downloading"
    | "ready"
    | "recording"
    | "transcribing"
    | "error" = "missing-model";
  private operation: Promise<DesktopSpeechStatus> | undefined;
  private recordingTimer: ReturnType<typeof setTimeout> | undefined;
  private cancelRequested = false;

  constructor(options: ControllerOptions) {
    this.options = options;
  }

  async getStatus(): Promise<DesktopSpeechStatus> {
    if (!this.options.supported) {
      return { supported: false, reason: this.options.unsupportedReason ?? "unsupported platform" };
    }
    if (this.state === "missing-model" && (await this.options.modelReady())) this.state = "ready";
    return { supported: true, state: this.state };
  }

  start(): Promise<DesktopSpeechStatus> {
    return this.exclusive(async () => {
      this.cancelRequested = false;
      const initial = await this.getStatus();
      if (!initial.supported) return initial;
      if (this.capture) throw new Error("voice input is already recording");

      if (await this.options.modelReady()) {
        this.modelPath = this.options.modelPath;
      } else {
        this.setState("downloading");
        this.modelPath = await this.options.downloadModel((downloaded, total) =>
          this.options.emit({ type: "download-progress", downloaded, total }),
        );
      }
      if (this.cancelRequested) {
        this.setState((await this.options.modelReady()) ? "ready" : "missing-model");
        return { supported: true, state: this.state };
      }
      if (!this.modelPath) throw new Error("speech model path is unavailable");

      const capture = this.options.createCapture();
      const backend = this.options.createBackend(this.modelPath);
      this.capture = capture;
      this.backend = backend;
      this.backendReady = backend.prepare().then<BackendPreparation, BackendPreparation>(
        () => ({ ok: true }),
        (error: unknown) => ({ ok: false, error }),
      );
      try {
        capture.start();
      } catch (error) {
        this.capture = undefined;
        this.backend = undefined;
        this.backendReady = undefined;
        await backend.dispose().catch(() => undefined);
        throw error;
      }
      this.setState("recording");
      this.recordingTimer = setTimeout(
        () => void this.stop(),
        this.options.maxRecordingMs ?? 120_000,
      );
      this.recordingTimer.unref?.();
      return { supported: true, state: "recording" };
    });
  }

  stop(): Promise<DesktopSpeechStatus> {
    return this.exclusive(async () => {
      const capture = this.capture;
      const backend = this.backend;
      const ready = this.backendReady;
      if (!capture || !backend || !ready) return this.getStatus();
      this.capture = undefined;
      this.clearRecordingTimer();
      this.setState("transcribing");
      try {
        const pcm = await capture.stop();
        const preparation = await ready;
        if (!preparation.ok) throw preparation.error;
        if (this.cancelRequested) {
          this.setState("ready");
          return { supported: true, state: "ready" };
        }
        const text = (await backend.transcribe(pcm)).trim();
        if (!this.cancelRequested && text) this.options.emit({ type: "transcript", text });
        this.setState("ready");
        return { supported: true, state: "ready" };
      } finally {
        this.backend = undefined;
        this.backendReady = undefined;
        await backend.dispose().catch(() => undefined);
      }
    });
  }

  cancel(): Promise<DesktopSpeechStatus> {
    this.cancelRequested = true;
    return this.exclusive(async () => {
      const capture = this.capture;
      const backend = this.backend;
      this.capture = undefined;
      this.clearRecordingTimer();
      this.backend = undefined;
      this.backendReady = undefined;
      await capture?.cancel().catch(() => undefined);
      await backend?.dispose().catch(() => undefined);
      this.modelPath = (await this.options.modelReady()) ? this.options.modelPath : undefined;
      this.setState(this.modelPath ? "ready" : "missing-model");
      this.cancelRequested = false;
      return { supported: true, state: this.state };
    });
  }

  removeModel(): Promise<DesktopSpeechStatus> {
    return this.exclusive(async () => {
      if (this.capture) throw new Error("stop voice input before removing its model");
      await this.options.removeModel();
      this.modelPath = undefined;
      this.setState("missing-model");
      return { supported: true, state: "missing-model" };
    });
  }

  async shutdown(): Promise<void> {
    await this.cancel().catch(() => undefined);
  }

  private setState(state: typeof this.state): void {
    this.state = state;
    this.options.emit({ type: "status", status: { supported: true, state } });
  }

  private clearRecordingTimer(): void {
    if (this.recordingTimer) clearTimeout(this.recordingTimer);
    this.recordingTimer = undefined;
  }

  private exclusive(task: () => Promise<DesktopSpeechStatus>): Promise<DesktopSpeechStatus> {
    const previous = this.operation;
    const operation = (previous ?? Promise.resolve())
      .then(task)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.state = "error";
        this.options.emit({ type: "error", message });
        this.options.emit({
          type: "status",
          status: { supported: true, state: "error", message },
        });
        return { supported: true, state: "error", message } as const;
      })
      .finally(() => {
        if (this.operation === operation) this.operation = undefined;
      });
    this.operation = operation;
    return operation;
  }
}
