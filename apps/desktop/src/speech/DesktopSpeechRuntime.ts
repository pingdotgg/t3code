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

type RuntimeOptions = {
  readonly supported: boolean;
  readonly unsupportedReason?: string;
  readonly modelPath: string;
  readonly modelReady: () => Promise<boolean>;
  readonly downloadModel: (
    signal: AbortSignal,
    onProgress: (downloaded: number, total: number) => void,
  ) => Promise<string>;
  readonly removeModel: () => Promise<void>;
  readonly createCapture: () => Promise<Capture>;
  readonly createBackend: (modelPath: string) => Backend;
  readonly createRecordingUri: () => string;
  readonly emit: (event: DesktopSpeechEvent) => void;
};

const MIN_CAPTURE_RMS = 0.0005;

function captureLevel(pcm: Float32Array): number {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (const sample of pcm) sum += sample * sample;
  return Math.sqrt(sum / pcm.length);
}

export class DesktopSpeechRuntime {
  private readonly options: RuntimeOptions;
  private readonly recordings = new Map<string, Float32Array>();
  private capture: Capture | undefined;
  private backend: Backend | undefined;
  private preparationAbortController: AbortController | undefined;
  private state: "missing-model" | "downloading" | "ready" | "recording" | "transcribing" =
    "missing-model";

  constructor(options: RuntimeOptions) {
    this.options = options;
  }

  async getStatus(): Promise<DesktopSpeechStatus> {
    if (!this.options.supported) {
      return { supported: false, reason: this.options.unsupportedReason ?? "unsupported platform" };
    }
    if (this.state === "missing-model" && (await this.options.modelReady())) this.state = "ready";
    return { supported: true, state: this.state };
  }

  async prepare(): Promise<{ locale: string }> {
    this.assertSupported();
    if (!(await this.options.modelReady())) {
      this.setState("downloading");
      const abortController = new AbortController();
      this.preparationAbortController = abortController;
      try {
        await this.options.downloadModel(abortController.signal, (downloaded, total) =>
          this.options.emit({ type: "download-progress", downloaded, total }),
        );
      } catch (error) {
        this.setState((await this.options.modelReady()) ? "ready" : "missing-model");
        throw error;
      } finally {
        if (this.preparationAbortController === abortController) {
          this.preparationAbortController = undefined;
        }
      }
    }

    this.backend ??= this.options.createBackend(this.options.modelPath);
    try {
      await this.backend.prepare();
    } catch (error) {
      this.setState("ready");
      throw error;
    }
    this.setState("ready");
    return { locale: "en" };
  }

  cancelPreparation(): void {
    this.preparationAbortController?.abort();
  }

  async startRecording(): Promise<void> {
    this.assertSupported();
    if (this.capture) throw new Error("microphone capture is already active");
    const capture = await this.options.createCapture();
    capture.start();
    this.capture = capture;
    this.setState("recording");
  }

  async stopRecording(): Promise<string> {
    const capture = this.capture;
    if (!capture) throw new Error("microphone capture is not active");
    this.capture = undefined;
    const pcm = await capture.stop();
    const uri = this.options.createRecordingUri();
    this.recordings.set(uri, pcm);
    return uri;
  }

  async cancelRecording(): Promise<void> {
    const capture = this.capture;
    this.capture = undefined;
    await capture?.cancel();
    if (this.options.supported)
      this.setState((await this.options.modelReady()) ? "ready" : "missing-model");
  }

  async transcribe(uri: string): Promise<string> {
    const pcm = this.recordings.get(uri);
    if (!pcm) throw new Error("voice recording is unavailable");
    this.setState("transcribing");
    if (captureLevel(pcm) < MIN_CAPTURE_RMS) {
      this.setState("ready");
      return "";
    }
    if (!this.backend) throw new Error("voice transcription is not prepared");
    try {
      return await this.backend.transcribe(pcm);
    } finally {
      this.setState("ready");
    }
  }

  deleteRecording(uri: string): void {
    this.recordings.delete(uri);
  }

  async removeModel(): Promise<DesktopSpeechStatus> {
    if (this.capture) throw new Error("stop voice input before removing its model");
    await this.backend?.dispose();
    this.backend = undefined;
    this.recordings.clear();
    await this.options.removeModel();
    this.setState("missing-model");
    return { supported: true, state: "missing-model" };
  }

  async shutdown(): Promise<void> {
    this.cancelPreparation();
    await this.cancelRecording().catch(() => undefined);
    await this.backend?.dispose().catch(() => undefined);
    this.backend = undefined;
    this.recordings.clear();
  }

  private assertSupported(): void {
    if (!this.options.supported) {
      throw new Error(this.options.unsupportedReason ?? "voice input is unsupported");
    }
  }

  private setState(state: typeof this.state): void {
    this.state = state;
    this.options.emit({ type: "status", status: { supported: true, state } });
  }
}
