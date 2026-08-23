import type { TranscribeModel } from "transcribe-cpp";

export class DesktopTranscriptionBackend {
  private readonly modelPath: string;
  private model: TranscribeModel | undefined;
  private loading: Promise<TranscribeModel> | undefined;

  constructor(modelPath: string) {
    this.modelPath = modelPath;
  }

  async prepare(): Promise<void> {
    if (this.model) return;
    this.loading ??= import("transcribe-cpp")
      .then(({ TranscribeModel }) => TranscribeModel.load(this.modelPath))
      .then((model) => {
        this.model = model;
        return model;
      });
    await this.loading;
  }

  async transcribe(pcm: Float32Array): Promise<string> {
    if (pcm.length === 0) throw new Error("no audio samples were provided");
    await this.prepare();
    const result = await this.model!.transcribe(pcm, {
      timestamps: "none",
      language: "en",
    });
    return result.text.trim();
  }

  async dispose(): Promise<void> {
    await this.loading?.catch(() => undefined);
    this.model?.dispose();
    this.model = undefined;
    this.loading = undefined;
  }
}
