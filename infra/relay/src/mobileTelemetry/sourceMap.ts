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
/**
 * A decoded map holds 16 bytes per possible segment, 4 per line and its
 * source paths, all known before any segment is read. The relay caches two
 * decoded maps in a 128 MB isolate, so each may take 32 MB, about 1.7 times a
 * production map today.
 */
const MAX_DECODED_BYTES = 32 * 1024 * 1024;

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

  const prefixLength = typeof sourceRoot === "string" ? sourceRoot.length + 1 : 0;
  let sourceChars = 0;
  for (const source of sources) sourceChars += source.length + prefixLength;
  // A path takes up to two bytes a character, plus its string header and array slot.
  const decodedBytes = capacity * 16 + (lineCount + 1) * 4 + sourceChars * 2 + sources.length * 32;
  if (decodedBytes > MAX_DECODED_BYTES) return undefined;

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
  const lineStart = map.lineStarts[lineIndex]!;
  // Columns within a line are sorted. Find the first segment at or after
  // `column`: an exact hit takes it, since Hermes maps a function's first
  // instruction twice (the declaration, then the first statement) and other
  // source map libraries take the first; otherwise the segment before wins.
  let low = lineStart;
  let high = map.lineStarts[lineIndex + 1]!;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (map.generatedColumns[middle]! < column) low = middle + 1;
    else high = middle;
  }
  const exact = low < map.lineStarts[lineIndex + 1]! && map.generatedColumns[low] === column;
  const found = exact ? low : low - 1;
  if (found < lineStart) return undefined;
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
 * composed Hermes source map. Native frames have no `address at`, and Hermes
 * prints its own runtime as `address at InternalBytecode.js:...`, whose
 * offsets are not in the app's map; both are left alone.
 */
const BUNDLE_FRAME = /address at (?!InternalBytecode\.js:)([^\s()]+):(\d+):(\d+)/u;

export interface SymbolicatedStack {
  readonly stack: string;
  /** Frames in the app bundle. */
  readonly bundleFrames: number;
  /** Bundle frames the map resolved. */
  readonly mappedFrames: number;
  /** How much longer the stack got. */
  readonly growth: number;
}

/**
 * Rewrites each bundle frame's location to its original file, line and
 * column (1-based, as JavaScript stacks print them), keeping the frame's
 * function name and every other line as it was. Source paths are longer than
 * the offsets they replace, so once the stack would grow by more than
 * `maxGrowth` the remaining frames keep their offsets.
 */
export function symbolicateStack(
  stack: string,
  map: CompactSourceMap,
  maxGrowth: number,
): SymbolicatedStack {
  let bundleFrames = 0;
  let mappedFrames = 0;
  let growth = 0;
  let exhausted = false;
  const lines = stack.split("\n").map((line) => {
    const match = BUNDLE_FRAME.exec(line);
    if (!match) return line;
    bundleFrames += 1;
    if (exhausted) return line;
    const position = originalPositionFor(map, Number(match[2]), Number(match[3]));
    if (!position) return line;
    const lineAndColumn = `:${position.line}:${position.column + 1}`;
    // Checked before the location string exists, so a long path costs nothing once over.
    const added = position.source.length + lineAndColumn.length - match[0].length;
    if (growth + added > maxGrowth) {
      exhausted = true;
      return line;
    }
    growth += added;
    mappedFrames += 1;
    // Spliced, not `replace`d: a replacement string would expand `$&` and `$'` in the path.
    const end = match.index + match[0].length;
    return line.slice(0, match.index) + position.source + lineAndColumn + line.slice(end);
  });
  return { stack: lines.join("\n"), bundleFrames, mappedFrames, growth };
}
