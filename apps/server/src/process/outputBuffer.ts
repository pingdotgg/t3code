export interface LimitedChunk {
  readonly chunk: Uint8Array;
  readonly nextBytes: number;
  readonly truncated: boolean;
  readonly overflow: boolean;
}

export function limitChunkToByteLimit(
  chunk: Uint8Array,
  currentBytes: number,
  maxBytes: number,
): LimitedChunk {
  const remaining = maxBytes - currentBytes;
  if (remaining <= 0) {
    return {
      chunk: new Uint8Array(),
      nextBytes: currentBytes,
      truncated: true,
      overflow: true,
    };
  }

  if (chunk.byteLength <= remaining) {
    return {
      chunk,
      nextBytes: currentBytes + chunk.byteLength,
      truncated: false,
      overflow: false,
    };
  }

  return {
    chunk: chunk.subarray(0, remaining),
    nextBytes: currentBytes + remaining,
    truncated: true,
    overflow: true,
  };
}

export function appendTextChunkWithinByteLimit(
  target: string,
  currentBytes: number,
  chunk: Uint8Array,
  maxBytes: number,
): {
  readonly next: string;
  readonly nextBytes: number;
  readonly truncated: boolean;
} {
  const limited = limitChunkToByteLimit(chunk, currentBytes, maxBytes);

  return {
    next: `${target}${Buffer.from(limited.chunk).toString()}`,
    nextBytes: limited.nextBytes,
    truncated: limited.truncated,
  };
}
