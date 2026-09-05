// @effect-diagnostics nodeBuiltinImport:off - chunk files mirror the packaged native exchange.
// Minimal WAV file helpers for Pocket chunk exchange. The native daemon
// writes IEEE-float mono WAV files; the Node worker reads them for onset
// filtering and writes filtered chunks for playback. No audio device here.
import * as NodeFSP from "node:fs/promises";

export async function readWavFloat32Mono(path: string): Promise<{
  readonly samples: Float32Array;
  readonly sampleRate: number;
}> {
  const bytes = await NodeFSP.readFile(path);
  if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error(`Pocket emitted an invalid WAV chunk: ${path}`);
  }
  const sampleRate = bytes.readUInt32LE(24);
  if (sampleRate === 0) throw new Error(`Pocket emitted a WAV with no sample rate: ${path}`);
  // Find the data chunk (drwav writes a standard header; be tolerant).
  let offset = 12;
  let dataOffset = -1;
  let dataLength = 0;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === "data") {
      dataOffset = offset + 8;
      dataLength = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (dataOffset === -1) throw new Error(`Pocket WAV chunk has no data: ${path}`);
  const format = bytes.readUInt16LE(20);
  const bits = bytes.readUInt16LE(34);
  const available = bytes.length - dataOffset;
  const length = Math.min(dataLength, available);
  if (format === 3 && bits === 32) {
    const count = Math.floor(length / 4);
    const samples = new Float32Array(count);
    for (let index = 0; index < count; index += 1) {
      samples[index] = bytes.readFloatLE(dataOffset + index * 4);
    }
    return { samples, sampleRate };
  }
  if (format === 1 && bits === 16) {
    const count = Math.floor(length / 2);
    const samples = new Float32Array(count);
    for (let index = 0; index < count; index += 1) {
      samples[index] = bytes.readInt16LE(dataOffset + index * 2) / 32_768;
    }
    return { samples, sampleRate };
  }
  throw new Error(`Pocket WAV chunk has unsupported format (${format}/${bits}): ${path}`);
}

export function encodeWavFloat32Mono(samples: Float32Array, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + samples.length * 4, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(3, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(32, 34);
  header.write("data", 36);
  header.writeUInt32LE(samples.length * 4, 40);
  const body = Buffer.alloc(samples.length * 4);
  for (let index = 0; index < samples.length; index += 1) {
    body.writeFloatLE(samples[index] ?? 0, index * 4);
  }
  return Buffer.concat([header, body]);
}

export async function writeWavFloat32Mono(
  path: string,
  samples: Float32Array,
  sampleRate: number,
): Promise<void> {
  await NodeFSP.writeFile(path, encodeWavFloat32Mono(samples, sampleRate));
}
