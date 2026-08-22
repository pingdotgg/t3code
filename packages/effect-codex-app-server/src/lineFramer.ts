export interface LineFramer {
  readonly push: (chunk: string) => ReadonlyArray<string>;
  readonly finish: () => string | undefined;
}

export function makeLineFramer(): LineFramer {
  // Keep incomplete lines fragmented so every incoming chunk is copied at most once.
  let fragments: Array<string> = [];

  const completeLine = (segment: string) => {
    if (fragments.length === 0) {
      return segment.endsWith("\r") ? segment.slice(0, -1) : segment;
    }
    if (segment.length > 0) {
      fragments.push(segment);
    }
    const line = fragments.join("");
    fragments = [];
    return line.endsWith("\r") ? line.slice(0, -1) : line;
  };

  return {
    push: (chunk) => {
      const lines: Array<string> = [];
      let segmentStart = 0;
      let newlineIndex = chunk.indexOf("\n");

      while (newlineIndex !== -1) {
        lines.push(completeLine(chunk.slice(segmentStart, newlineIndex)));
        segmentStart = newlineIndex + 1;
        newlineIndex = chunk.indexOf("\n", segmentStart);
      }

      if (segmentStart < chunk.length) {
        fragments.push(chunk.slice(segmentStart));
      }
      return lines;
    },
    finish: () => {
      if (fragments.length === 0) {
        return undefined;
      }
      const line = fragments.join("");
      fragments = [];
      return line;
    },
  };
}
