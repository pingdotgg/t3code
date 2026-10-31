const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_SPS_BYTES = 4096;

const unsignedGolomb = (value: number) => {
  const bits = (value + 1).toString(2);
  return "0".repeat(bits.length - 1) + bits;
};

function withReorderLimits(sps: Uint8Array): Uint8Array {
  if (sps.length < 4 || sps.length > MAX_SPS_BYTES || (sps[0]! & 0x9f) !== 7) return sps;
  const rbsp: number[] = [];
  let zeros = 0;
  for (let index = 1; index < sps.length; index++) {
    const byte = sps[index]!;
    if (zeros >= 2 && byte === 3) {
      if (index + 1 >= sps.length || sps[index + 1]! > 3) return sps;
      zeros = 0;
      continue;
    }
    rbsp.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  const bits = rbsp.map((byte) => byte.toString(2).padStart(8, "0")).join("");
  let position = 0;
  const read = (count: number) => {
    if (position + count > bits.length) throw new Error("Truncated H.264 SPS");
    const value = Number.parseInt(bits.slice(position, position + count), 2);
    position += count;
    return value;
  };
  const readUnsignedGolomb = () => {
    let leadingZeros = 0;
    while (read(1) === 0) {
      if (++leadingZeros > 31) throw new Error("Invalid H.264 Exp-Golomb value");
    }
    return 2 ** leadingZeros - 1 + (leadingZeros === 0 ? 0 : read(leadingZeros));
  };

  try {
    // Only handle the hub's 8-bit 4:2:0 High profile without scaling lists.
    // Unknown encoder configurations pass through rather than guessing their layout.
    if (read(8) !== 100) return sps;
    read(16);
    if (readUnsignedGolomb() > 31 || readUnsignedGolomb() !== 1) return sps;
    if (readUnsignedGolomb() !== 0 || readUnsignedGolomb() !== 0) return sps;
    read(1);
    if (read(1) !== 0) return sps;
    if (readUnsignedGolomb() > 12) return sps;
    const pictureOrderCountType = readUnsignedGolomb();
    if (pictureOrderCountType === 0) {
      if (readUnsignedGolomb() > 12) return sps;
    } else if (pictureOrderCountType === 1) {
      read(1);
      readUnsignedGolomb();
      readUnsignedGolomb();
      const cycleLength = readUnsignedGolomb();
      if (cycleLength > 255) return sps;
      for (let index = 0; index < cycleLength; index++) readUnsignedGolomb();
    } else if (pictureOrderCountType !== 2) return sps;
    const maxReferenceFrames = readUnsignedGolomb();
    if (maxReferenceFrames > 16) return sps;
    read(1);
    if (readUnsignedGolomb() > 65535 || readUnsignedGolomb() > 65535) return sps;
    if (read(1) === 0) read(1);
    read(1);
    if (read(1) !== 0) {
      for (let index = 0; index < 4; index++) readUnsignedGolomb();
    }
    const vuiPosition = position;
    if (read(1) !== 0) return sps;
    // With no VUI, only rbsp_stop_one_bit and byte padding may follow.
    if (!/^10{0,7}$/.test(bits.slice(position))) return sps;

    // serve-sim disables reordering, but its fallback encoder omits VUI, so Chromium
    // infers a large queue despite optimizeForLatency. Add VUI with zero reorder frames.
    // Flags omit eight optional sections and enable bitstream restrictions
    // and motion_vectors_over_pic_boundaries_flag.
    const restricted =
      bits.slice(0, vuiPosition) +
      "10000000011" +
      [2, 1, 16, 16, 0, maxReferenceFrames].map(unsignedGolomb).join("") +
      "1";
    const padded = restricted.padEnd(Math.ceil(restricted.length / 8) * 8, "0");
    const output = [sps[0]!];
    zeros = 0;
    for (let index = 0; index < padded.length; index += 8) {
      const byte = Number.parseInt(padded.slice(index, index + 8), 2);
      if (zeros >= 2 && byte <= 3) {
        output.push(3);
        zeros = 0;
      }
      output.push(byte);
      zeros = byte === 0 ? zeros + 1 : 0;
    }
    return Uint8Array.from(output);
  } catch {
    return sps;
  }
}

/** Repair missing reorder metadata only for serve-sim's non-reordering AVCC feed. */
export function simulatorAvcConfig(description: Uint8Array): Uint8Array {
  if (description.length < 7 || description.length > MAX_CONFIG_BYTES || description[0] !== 1)
    return description;
  const parameterSets = description[5]! & 0x1f;
  if (parameterSets === 0) return description;
  const parts: Uint8Array[] = [description.subarray(0, 6)];
  let position = 6;
  let changed = false;
  for (let index = 0; index < parameterSets; index++) {
    if (position + 2 > description.length) return description;
    const length = description[position]! * 256 + description[position + 1]!;
    position += 2;
    if (length === 0 || position + length > description.length) return description;
    const sps = description.subarray(position, position + length);
    const repaired = withReorderLimits(sps);
    changed ||= repaired !== sps;
    parts.push(Uint8Array.of(repaired.length >>> 8, repaired.length & 0xff), repaired);
    position += length;
  }
  const suffix = position;
  if (position >= description.length) return description;
  const pictureParameterSets = description[position++]!;
  for (let index = 0; index < pictureParameterSets; index++) {
    if (position + 2 > description.length) return description;
    const length = description[position]! * 256 + description[position + 1]!;
    position += 2;
    if (length === 0 || position + length > description.length) return description;
    position += length;
  }
  if (!changed) return description;
  parts.push(description.subarray(suffix));
  const output = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  position = 0;
  for (const part of parts) {
    output.set(part, position);
    position += part.length;
  }
  return output;
}
