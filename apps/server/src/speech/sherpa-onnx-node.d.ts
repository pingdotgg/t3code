declare module "sherpa-onnx-node" {
  interface OfflineTtsKokoroConfig {
    readonly model: string;
    readonly voices: string;
    readonly tokens: string;
    readonly lexicon: string;
    readonly dataDir: string;
    readonly lengthScale: number;
  }

  interface OfflineTtsConfig {
    readonly model: {
      readonly kokoro: OfflineTtsKokoroConfig;
      readonly numThreads: number;
      readonly provider: "cpu";
      readonly debug: boolean;
    };
    readonly maxNumSentences: number;
  }

  class OfflineTts {
    static createAsync(config: OfflineTtsConfig): Promise<OfflineTts>;
    readonly sampleRate: number;
    generateAsync(request: {
      readonly text: string;
      readonly sid: number;
      readonly speed: number;
      /** Electron's V8 memory cage rejects buffers backed by native memory. */
      readonly enableExternalBuffer: boolean;
    }): Promise<{ readonly samples: Float32Array; readonly sampleRate: number }>;
  }

  const sherpa: { readonly OfflineTts: typeof OfflineTts };
  export default sherpa;
}
