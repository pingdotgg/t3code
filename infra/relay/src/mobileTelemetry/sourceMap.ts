/**
 * Source map lookups for mobile JavaScript stacks, sized for a Worker.
 *
 * A production Hermes map is one generated line with over a million
 * segments. General-purpose decoders hold each segment as its own array,
 * which costs more than a Worker isolate's whole memory budget, so this
 * decodes the mappings straight into typed arrays (about 20 bytes a segment).
 */

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_VALUES = new Int8Array(128).fill(-1);
for (let index = 0; index < BASE64.length; index += 1) {
  BASE64_VALUES[BASE64.charCodeAt(index)] = index;
}
const COMMA = 44;
const SEMICOLON = 59;

export interface CompactSourceMap {
  readonly sources: ReadonlyArray<string>;
  /** Segment index where each generated line starts, plus one past the last line. */
  readonly lineStarts: Int32Array;
  readonly generatedColumns: Int32Array;
  /** -1 for segments that map to no source. */
  readonly sourceIndexes: Int32Array;
  readonly originalLines: Int32Array;
  readonly originalColumns: Int32Array;
}

export interface OriginalPosition {
  readonly source: string;
  /** 1-based. */
  readonly line: number;
  /** 0-based, as source maps store it. */
  readonly column: number;
}

const isStringArray = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/**
 * Decodes a version 3 source map, or returns `undefined` for anything else,
 * including index maps with `sections`, which no React Native build emits.
 */
export function decodeSourceMap(raw: unknown): CompactSourceMap | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const version = Reflect.get(raw, "version");
  const mappings = Reflect.get(raw, "mappings");
  const sources = Reflect.get(raw, "sources");
  const sourceRoot = Reflect.get(raw, "sourceRoot");
  if (version !== 3 || typeof mappings !== "string" || !isStringArray(sources)) return undefined;

  // Every segment ends at a separator or at the end, so this bounds the count.
  let capacity = 1;
  let lineCount = 1;
  for (let index = 0; index < mappings.length; index += 1) {
    const code = mappings.charCodeAt(index);
    if (code === COMMA) capacity += 1;
    else if (code === SEMICOLON) {
      capacity += 1;
      lineCount += 1;
    }
  }

  const lineStarts = new Int32Array(lineCount + 1);
  const generatedColumns = new Int32Array(capacity);
  const sourceIndexes = new Int32Array(capacity);
  const originalLines = new Int32Array(capacity);
  const originalColumns = new Int32Array(capacity);

  // Names are decoded to keep the running offsets right, but not stored:
  // they name the identifier at a position, not the enclosing function.
  const fields = [0, 0, 0, 0, 0];
  let segmentCount = 0;
  let line = 0;
  let generatedColumn = 0;
  let sourceIndex = 0;
  let originalLine = 0;
  let originalColumn = 0;
  let index = 0;

  while (index <= mappings.length) {
    const code = index < mappings.length ? mappings.charCodeAt(index) : SEMICOLON;
    if (code === SEMICOLON) {
      line += 1;
      lineStarts[line] = segmentCount;
      generatedColumn = 0;
      index += 1;
      continue;
    }
    if (code === COMMA) {
      index += 1;
      continue;
    }

    let fieldCount = 0;
    while (index < mappings.length) {
      const next = mappings.charCodeAt(index);
      if (next === COMMA || next === SEMICOLON) break;
      let value = 0;
      let shift = 0;
      let digit: number;
      do {
        const char = mappings.charCodeAt(index);
        digit = char < 128 ? BASE64_VALUES[char]! : -1;
        if (digit === -1) return undefined;
        value += (digit & 31) * 2 ** shift;
        shift += 5;
        index += 1;
      } while (digit & 32);
      const negative = value % 2 === 1;
      value = Math.floor(value / 2);
      if (fieldCount < fields.length) fields[fieldCount] = negative ? -value : value;
      fieldCount += 1;
    }
    if (fieldCount !== 1 && fieldCount !== 4 && fieldCount !== 5) return undefined;

    generatedColumn += fields[0]!;
    generatedColumns[segmentCount] = generatedColumn;
    if (fieldCount === 1) {
      sourceIndexes[segmentCount] = -1;
    } else {
      sourceIndex += fields[1]!;
      originalLine += fields[2]!;
      originalColumn += fields[3]!;
      sourceIndexes[segmentCount] = sourceIndex;
      originalLines[segmentCount] = originalLine;
      originalColumns[segmentCount] = originalColumn;
    }
    segmentCount += 1;
  }

  const prefix = typeof sourceRoot === "string" && sourceRoot !== "" ? sourceRoot : undefined;
  return {
    sources: prefix ? sources.map((source) => `${prefix.replace(/\/?$/u, "/")}${source}`) : sources,
    lineStarts,
    generatedColumns,
    sourceIndexes,
    originalLines,
    originalColumns,
  };
}

/**
 * The original position of the closest segment at or before a generated
 * position. `line` is 1-based and `column` 0-based, the same convention as
 * `originalPositionFor` in `@jridgewell/trace-mapping`.
 */
export function originalPositionFor(
  map: CompactSourceMap,
  line: number,
  column: number,
): OriginalPosition | undefined {
  const lineIndex = line - 1;
  if (lineIndex < 0 || lineIndex >= map.lineStarts.length - 1) return undefined;
  let low = map.lineStarts[lineIndex]!;
  let high = map.lineStarts[lineIndex + 1]! - 1;
  const lineStart = low;
  let found = -1;
  // Columns within a line are sorted, so the last segment at or before `column` wins.
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (map.generatedColumns[middle]! <= column) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (found === -1) return undefined;
  // Hermes maps a function's first instruction twice (the declaration, then
  // the first statement). On an exact hit take the first, as other source map
  // libraries do.
  while (
    found > lineStart &&
    map.generatedColumns[found] === column &&
    map.generatedColumns[found - 1] === column
  ) {
    found -= 1;
  }
  const sourceIndex = map.sourceIndexes[found]!;
  const source = sourceIndex === -1 ? undefined : map.sources[sourceIndex];
  if (source === undefined) return undefined;
  return {
    source,
    line: map.originalLines[found]! + 1,
    column: map.originalColumns[found]!,
  };
}

/**
 * A Hermes frame in the app bundle, such as
 * `at render (address at index.android.bundle:1:48213)`. Hermes prints the
 * bytecode offset as the column, which is exactly the generated column in the
 * composed Hermes source map. Frames without `address at` (native code,
 * `InternalBytecode.js`) are not in the bundle and are left alone.
 */
const BUNDLE_FRAME = /address at ([^\s()]+):(\d+):(\d+)/u;

export interface SymbolicatedStack {
  readonly stack: string;
  /** Frames in the app bundle. */
  readonly bundleFrames: number;
  /** Bundle frames the map resolved. */
  readonly mappedFrames: number;
}

/**
 * Rewrites each bundle frame's location to its original file, line and
 * column (1-based, as JavaScript stacks print them), keeping the frame's
 * function name and every other line as it was.
 */
export function symbolicateStack(stack: string, map: CompactSourceMap): SymbolicatedStack {
  let bundleFrames = 0;
  let mappedFrames = 0;
  const lines = stack.split("\n").map((line) => {
    const match = BUNDLE_FRAME.exec(line);
    if (!match) return line;
    bundleFrames += 1;
    const position = originalPositionFor(map, Number(match[2]), Number(match[3]));
    if (!position) return line;
    mappedFrames += 1;
    return line.replace(match[0], `${position.source}:${position.line}:${position.column + 1}`);
  });
  return { stack: lines.join("\n"), bundleFrames, mappedFrames };
}
