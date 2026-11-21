/**
 * Audio capture (16kHz 16-bit mono PCM) and gapless playback (24kHz 16-bit mono PCM)
 * for the Gemini Multimodal Live API.
 */

export function downsampleFloat32(
  buffer: Float32Array,
  inputSampleRate: number,
  targetSampleRate: number,
): Float32Array {
  if (inputSampleRate === targetSampleRate || inputSampleRate <= 0 || targetSampleRate <= 0) {
    return buffer;
  }
  const ratio = inputSampleRate / targetSampleRate;
  const outputLength = Math.max(1, Math.round(buffer.length / ratio));
  const result = new Float32Array(outputLength);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.min(buffer.length, Math.round((offsetResult + 1) * ratio));
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer; i++) {
      accum += buffer[i] ?? 0;
      count++;
    }
    result[offsetResult] = count > 0 ? accum / count : 0;
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
}

export function pcm16Base64FromFloat32(
  samples: Float32Array,
  inputSampleRate = 16000,
  targetSampleRate = 16000,
): string {
  const resampled = downsampleFloat32(samples, inputSampleRate, targetSampleRate);
  const pcm16 = new Int16Array(resampled.length);
  for (let i = 0; i < resampled.length; i++) {
    const clamped = Math.max(-1, Math.min(1, resampled[i] ?? 0));
    pcm16[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  const bytes = new Uint8Array(pcm16.buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function float32FromPcm16Base64(base64: string): Float32Array {
  const binary = atob(base64);
  const byteLength = binary.length - (binary.length % 2);
  const bytes = new Uint8Array(byteLength);
  for (let i = 0; i < byteLength; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const view = new DataView(bytes.buffer);
  const sampleCount = byteLength / 2;
  const float32 = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const int16 = view.getInt16(i * 2, true);
    float32[i] = int16 / 0x8000;
  }
  return float32;
}

export function computeRmsLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) {
    const val = samples[i] ?? 0;
    sumSquares += val * val;
  }
  const rms = Math.sqrt(sumSquares / samples.length);
  return Math.min(1, rms * 4);
}

const WORKLET_PROCESSOR_CODE = `
class GeminiMicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(2048);
    this._offset = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const channel = input[0];
    for (let i = 0; i < channel.length; i++) {
      this._buffer[this._offset++] = channel[i];
      if (this._offset >= this._buffer.length) {
        this.port.postMessage(this._buffer.slice(0));
        this._offset = 0;
      }
    }
    return true;
  }
}
registerProcessor("gemini-mic-processor", GeminiMicProcessor);
`;

export interface GeminiMicCaptureCallbacks {
  readonly onAudioChunk: (base64Pcm16: string) => void;
  readonly onLevelChange?: (level: number) => void;
  readonly onError?: (error: Error) => void;
}

export class GeminiMicCapture {
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private fallbackProcessor: ScriptProcessorNode | null = null;
  private muted = false;
  private stopped = false;

  async start(callbacks: GeminiMicCaptureCallbacks): Promise<void> {
    this.stopped = false;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (this.stopped) {
        this.cleanupStream();
        return;
      }

      this.audioContext = new AudioContext({ sampleRate: 16000 });
      const actualSampleRate = this.audioContext.sampleRate;
      this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);

      const handleSamples = (samples: Float32Array) => {
        if (this.stopped || this.muted) {
          callbacks.onLevelChange?.(0);
          return;
        }
        const level = computeRmsLevel(samples);
        callbacks.onLevelChange?.(level);
        const base64 = pcm16Base64FromFloat32(samples, actualSampleRate, 16000);
        callbacks.onAudioChunk(base64);
      };

      if (this.audioContext.audioWorklet) {
        try {
          const blob = new Blob([WORKLET_PROCESSOR_CODE], { type: "application/javascript" });
          const url = URL.createObjectURL(blob);
          try {
            await this.audioContext.audioWorklet.addModule(url);
          } finally {
            URL.revokeObjectURL(url);
          }
          if (this.stopped) return;
          this.workletNode = new AudioWorkletNode(this.audioContext, "gemini-mic-processor");
          this.workletNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
            if (event.data instanceof Float32Array) {
              handleSamples(event.data);
            }
          };
          this.sourceNode.connect(this.workletNode);
          return;
        } catch {
          // Fall back to ScriptProcessorNode if AudioWorklet loading is blocked by CSP.
        }
      }

      const processor = this.audioContext.createScriptProcessor(2048, 1, 1);
      processor.onaudioprocess = (event: AudioProcessingEvent) => {
        const channelData = event.inputBuffer.getChannelData(0);
        handleSamples(new Float32Array(channelData));
      };
      this.fallbackProcessor = processor;
      this.sourceNode.connect(processor);
      processor.connect(this.audioContext.destination);
    } catch (err) {
      const error =
        err instanceof Error ? err : new Error("Failed to access microphone for voice mode.");
      callbacks.onError?.(error);
      throw error;
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.stream) {
      for (const track of this.stream.getAudioTracks()) {
        track.enabled = !muted;
      }
    }
  }

  isMuted(): boolean {
    return this.muted;
  }

  stop(): void {
    this.stopped = true;
    try {
      this.workletNode?.disconnect();
    } catch {
      // Ignore disconnect errors.
    }
    this.workletNode = null;
    try {
      this.fallbackProcessor?.disconnect();
    } catch {
      // Ignore disconnect errors.
    }
    this.fallbackProcessor = null;
    try {
      this.sourceNode?.disconnect();
    } catch {
      // Ignore disconnect errors.
    }
    this.sourceNode = null;
    if (this.audioContext) {
      void this.audioContext.close().catch(() => undefined);
      this.audioContext = null;
    }
    this.cleanupStream();
  }

  private cleanupStream(): void {
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
      this.stream = null;
    }
  }
}

export class GeminiAudioPlayer {
  private audioContext: AudioContext | null = null;
  private nextStartTime = 0;
  private activeSources = new Set<AudioBufferSourceNode>();
  private onSpeakingChange?: (speaking: boolean) => void;
  private onLevelChange?: (level: number) => void;

  constructor(options?: {
    onSpeakingChange?: (speaking: boolean) => void;
    onLevelChange?: (level: number) => void;
  }) {
    this.onSpeakingChange = options?.onSpeakingChange;
    this.onLevelChange = options?.onLevelChange;
  }

  private ensureContext(): AudioContext {
    if (!this.audioContext || this.audioContext.state === "closed") {
      this.audioContext = new AudioContext({ sampleRate: 24000 });
      this.nextStartTime = 0;
    }
    if (this.audioContext.state === "suspended") {
      void this.audioContext.resume().catch(() => undefined);
    }
    return this.audioContext;
  }

  enqueuePcm16Base64(base64: string, sampleRate = 24000): void {
    const samples = float32FromPcm16Base64(base64);
    if (samples.length === 0) return;

    const ctx = this.ensureContext();
    const audioBuffer = ctx.createBuffer(1, samples.length, sampleRate);
    audioBuffer.copyToChannel(samples, 0);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    const now = ctx.currentTime;
    const startAt = Math.max(now + 0.01, this.nextStartTime);
    this.nextStartTime = startAt + audioBuffer.duration;

    const wasEmpty = this.activeSources.size === 0;
    this.activeSources.add(source);
    if (wasEmpty) {
      this.onSpeakingChange?.(true);
    }
    this.onLevelChange?.(computeRmsLevel(samples));

    source.onended = () => {
      this.activeSources.delete(source);
      if (this.activeSources.size === 0) {
        this.onLevelChange?.(0);
        this.onSpeakingChange?.(false);
      }
    };

    source.start(startAt);
  }

  interrupt(): void {
    for (const source of this.activeSources) {
      try {
        source.stop();
        source.disconnect();
      } catch {
        // Ignore already stopped sources.
      }
    }
    this.activeSources.clear();
    if (this.audioContext) {
      this.nextStartTime = this.audioContext.currentTime;
    } else {
      this.nextStartTime = 0;
    }
    this.onLevelChange?.(0);
    this.onSpeakingChange?.(false);
  }

  dispose(): void {
    this.interrupt();
    if (this.audioContext) {
      void this.audioContext.close().catch(() => undefined);
      this.audioContext = null;
    }
  }
}
