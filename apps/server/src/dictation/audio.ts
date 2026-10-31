import { DICTATION_SAMPLE_RATE } from "@t3tools/contracts";

/** Validate and convert the wire PCM without accepting containers or truncated samples. */
export function decodePcm(pcm: string): Float32Array {
  if (pcm.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(pcm)) {
    throw new Error("Invalid PCM encoding.");
  }
  const bytes = Buffer.from(pcm, "base64");
  if (bytes.toString("base64") !== pcm) throw new Error("Invalid PCM encoding.");
  if (bytes.length % 2 !== 0) throw new Error("Incomplete PCM sample.");
  const samples = new Float32Array(bytes.length / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(i * 2) / 32768;
  return samples;
}

/** Consume only contiguous chunks; concurrent RPC delivery may leave gaps temporarily. */
export function takeOrderedChunks(chunks: Map<number, Float32Array>, next: number) {
  const ordered: Float32Array[] = [];
  while (chunks.has(next)) {
    ordered.push(chunks.get(next)!);
    chunks.delete(next++);
  }
  return { ordered, next };
}

export function concatenate(samples: readonly Float32Array[]): Float32Array {
  const result = new Float32Array(samples.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of samples) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/** Split after 4 seconds at a 250 ms pause, or near the quietest frame at the 20 s cap. */
export function findSplit(samples: Float32Array): number | null {
  const minimum = 4 * DICTATION_SAMPLE_RATE;
  const maximum = 20 * DICTATION_SAMPLE_RATE;
  if (samples.length < minimum) return null;
  const frame = DICTATION_SAMPLE_RATE / 50;
  const end = Math.min(samples.length, maximum);
  const energies: number[] = [];
  for (let start = 0; start + frame <= end; start += frame) {
    let energy = 0;
    for (let i = start; i < start + frame; i++) energy += samples[i]! ** 2;
    energies.push(Math.sqrt(energy / frame));
  }
  const peak = Math.max(...energies);
  const threshold = Math.max(0.003, Math.min(0.02, peak * 0.08));
  let quietFrames = 0;
  let split: number | null = null;
  for (let i = Math.floor((minimum - DICTATION_SAMPLE_RATE) / frame); i < energies.length; i++) {
    quietFrames = energies[i]! < threshold ? quietFrames + 1 : 0;
    if (quietFrames >= 13) split = (i + 1 - Math.floor(quietFrames / 2)) * frame;
  }
  if (split !== null) return split;
  if (samples.length < maximum) return null;
  let quietest = Math.floor((maximum - 4 * DICTATION_SAMPLE_RATE) / frame);
  for (let i = quietest + 1; i < energies.length; i++) {
    if (energies[i]! < energies[quietest]!) quietest = i;
  }
  return (quietest + 1) * frame;
}

export function joinTexts(texts: readonly string[]): string {
  return texts
    .map((text) => text.trim())
    .filter(Boolean)
    .join(" ");
}

/** Whisper's decoder may invent text for pure noise or quiet tails. */
export function isQuiet(samples: Float32Array): boolean {
  let energy = 0;
  for (const sample of samples) energy += sample * sample;
  return samples.length === 0 || Math.sqrt(energy / samples.length) < 0.003;
}

/** Drop exact non-speech markers while preserving phrases a person could actually dictate. */
export function cleanWhisperText(text: string): string {
  return /^(?:\[blank_audio\]|\[silence\]|\[music\])$/i.test(text.trim()) ? "" : text;
}
