/**
 * `git check-ignore --stdin` reads NUL-separated paths; chunking keeps a large workspace listing
 * from overflowing the pipe buffer while the child is still writing its answer.
 */
const CHECK_IGNORE_MAX_STDIN_BYTES = 256 * 1024;

/** Splits newline-framed process output, such as one JSON record per line. A truncated read ends
 * mid-record, so the last frame is dropped rather than parsed. */
export function splitLineSeparatedPaths(input: string, truncated: boolean): string[] {
  const frames = input.split(/\r?\n/g);
  if (truncated && frames[frames.length - 1]?.length) {
    frames.pop();
  }
  return frames.map((line) => line.trim()).filter((line) => line.length > 0);
}

export function chunkPathsForCheckIgnore(relativePaths: ReadonlyArray<string>): string[][] {
  const chunks: string[][] = [];
  let chunk: string[] = [];
  let chunkBytes = 0;

  for (const relativePath of relativePaths) {
    const relativePathBytes = Buffer.byteLength(relativePath) + 1;
    if (chunk.length > 0 && chunkBytes + relativePathBytes > CHECK_IGNORE_MAX_STDIN_BYTES) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 0;
    }

    chunk.push(relativePath);
    chunkBytes += relativePathBytes;

    if (chunkBytes >= CHECK_IGNORE_MAX_STDIN_BYTES) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 0;
    }
  }

  if (chunk.length > 0) {
    chunks.push(chunk);
  }

  return chunks;
}
