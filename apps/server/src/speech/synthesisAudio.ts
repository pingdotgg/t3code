export function pcm16Wave(pcm: Uint8Array, sampleRate: number) {
  const wave = new Uint8Array(44 + pcm.length);
  const header = new DataView(wave.buffer);
  const tag = (offset: number, value: string) => wave.set(new TextEncoder().encode(value), offset);
  tag(0, "RIFF");
  header.setUint32(4, wave.length - 8, true);
  tag(8, "WAVEfmt ");
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, sampleRate, true);
  header.setUint32(28, sampleRate * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  tag(36, "data");
  header.setUint32(40, pcm.length, true);
  wave.set(pcm, 44);
  return wave;
}
