export const MAX_SYNTHESIS_BYTES = 32 * 1024 * 1024;

export function speechWave(pcm: Uint8Array, rate: number, channels = 1) {
  if (
    !Number.isInteger(rate) ||
    rate < 8000 ||
    rate > 192000 ||
    !Number.isInteger(channels) ||
    channels < 1 ||
    channels > 2 ||
    !pcm.length ||
    pcm.length % (channels * 2) ||
    pcm.length > MAX_SYNTHESIS_BYTES
  )
    throw new Error("Invalid speech audio.");
  const bytes = new Uint8Array(44 + pcm.length);
  const view = new DataView(bytes.buffer);
  const tag = (offset: number, text: string) => bytes.set(new TextEncoder().encode(text), offset);
  tag(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  tag(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, pcm.length, true);
  bytes.set(pcm, 44);
  return bytes;
}
