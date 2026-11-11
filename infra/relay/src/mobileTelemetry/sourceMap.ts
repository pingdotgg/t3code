// A production Hermes map has over a million segments. General-purpose decoders hold
// each as its own array, past a Worker isolate's memory budget; typed arrays fit.

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_VALUES = new Int8Array(128).fill(-1);
for (let index = 0; index < BASE64.length; index += 1) {
  BASE64_VALUES[BASE64.charCodeAt(index)] = index;
}
const COMMA = 44;
const SEMICOLON = 59;
/** The relay caches two decoded maps in a 128 MB isolate. */
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

interface OriginalPosition {
  readonly source: string;
  /** 1-based. */
  readonly line: number;
  /** 0-based, as source maps store it. */
  readonly column: number;
}

const isStringArray = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/**
 * Calls `visit` per segment in order; `sourceIndex` is -1 for a segment that maps to no source.
 * False if a segment is malformed.
 */
function walkSegments(
  mappings: string,
  visit: (
    line: number,
    generatedColumn: number,
    sourceIndex: number,
    originalLine: number,
    originalColumn: number,
  ) => void,
): boolean {
  // Names keep the running offsets right but are not stored: they name an identifier, not the function.
  const fields = [0, 0, 0, 0, 0];
  let line = 0;
  let generatedColumn = 0;
  let sourceIndex = 0;
  let originalLine = 0;
  let originalColumn = 0;
  let index = 0;

  while (index < mappings.length) {
    const code = mappings.charCodeAt(index);
    if (code === SEMICOLON) {
      line += 1;
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
        if (digit === -1) return false;
        value += (digit & 31) * 2 ** shift;
        shift += 5;
        index += 1;
      } while (digit & 32);
      const negative = value % 2 === 1;
      value = Math.floor(value / 2);
      if (fieldCount < fields.length) fields[fieldCount] = negative ? -value : value;
      fieldCount += 1;
    }
    if (fieldCount !== 1 && fieldCount !== 4 && fieldCount !== 5) return false;

    generatedColumn += fields[0]!;
    if (fieldCount === 1) {
      visit(line, generatedColumn, -1, 0, 0);
    } else {
      sourceIndex += fields[1]!;
      originalLine += fields[2]!;
      originalColumn += fields[3]!;
      visit(line, generatedColumn, sourceIndex, originalLine, originalColumn);
    }
  }
  return true;
}

/**
 * `too_large` past the decode budget; `invalid` for anything but a version 3 map, including
 * index maps, which React Native never emits.
 */
export function decodeSourceMap(raw: unknown): CompactSourceMap | "too_large" | "invalid" {
  if (typeof raw !== "object" || raw === null) return "invalid";
  const version = Reflect.get(raw, "version");
  const mappings = Reflect.get(raw, "mappings");
  const sources = Reflect.get(raw, "sources");
  const sourceRoot = Reflect.get(raw, "sourceRoot");
  if (version !== 3 || typeof mappings !== "string" || !isStringArray(sources)) return "invalid";

  // Hermes maps most bytecode instructions to the same position as the one before; a lookup
  // lands on the earlier segment instead with the same answer. Dropping them shrinks our iOS
  // map from 2.1M segments to 1.2M, so the first pass counts what the second keeps.
  let lineCount = 1;
  for (let index = 0; index < mappings.length; index += 1) {
    if (mappings.charCodeAt(index) === SEMICOLON) lineCount += 1;
  }
  let kept = 0;
  let lastLine = -1;
  let lastSource = -2;
  let lastOriginalLine = 0;
  let lastOriginalColumn = 0;
  const repeats = (line: number, source: number, originalLine: number, originalColumn: number) => {
    const same =
      line === lastLine &&
      source === lastSource &&
      (source === -1 ||
        (originalLine === lastOriginalLine && originalColumn === lastOriginalColumn));
    lastLine = line;
    lastSource = source;
    lastOriginalLine = originalLine;
    lastOriginalColumn = originalColumn;
    return same;
  };
  const counted = walkSegments(mappings, (line, _column, source, originalLine, originalColumn) => {
    if (!repeats(line, source, originalLine, originalColumn)) kept += 1;
  });
  if (!counted) return "invalid";

  const prefixLength = typeof sourceRoot === "string" ? sourceRoot.length + 1 : 0;
  let sourceChars = 0;
  for (const source of sources) sourceChars += source.length + prefixLength;
  // A path takes up to two bytes a character, plus its string header and array slot.
  const decodedBytes = kept * 16 + (lineCount + 1) * 4 + sourceChars * 2 + sources.length * 32;
  if (decodedBytes > MAX_DECODED_BYTES) return "too_large";

  const lineStarts = new Int32Array(lineCount + 1);
  const generatedColumns = new Int32Array(kept);
  const sourceIndexes = new Int32Array(kept);
  const originalLines = new Int32Array(kept);
  const originalColumns = new Int32Array(kept);
  let segment = 0;
  let currentLine = 0;
  lastLine = -1;
  lastSource = -2;
  walkSegments(mappings, (line, generatedColumn, source, originalLine, originalColumn) => {
    if (repeats(line, source, originalLine, originalColumn)) return;
    while (currentLine < line) {
      currentLine += 1;
      lineStarts[currentLine] = segment;
    }
    generatedColumns[segment] = generatedColumn;
    sourceIndexes[segment] = source;
    originalLines[segment] = originalLine;
    originalColumns[segment] = originalColumn;
    segment += 1;
  });
  while (currentLine < lineCount) {
    currentLine += 1;
    lineStarts[currentLine] = segment;
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

/** `line` is 1-based and `column` 0-based, as in `@jridgewell/trace-mapping`. */
function originalPositionFor(
  map: CompactSourceMap,
  line: number,
  column: number,
): OriginalPosition | undefined {
  const lineIndex = line - 1;
  if (lineIndex < 0 || lineIndex >= map.lineStarts.length - 1) return undefined;
  const lineStart = map.lineStarts[lineIndex]!;
  // An exact hit takes the first segment at `column`: Hermes maps a function's first
  // instruction twice (declaration, then first statement), and other libraries take the first.
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
 * `at render (address at index.android.bundle:1:48213)`: Hermes prints the bytecode offset,
 * the composed map's generated column. On iOS the path is absolute, and an OTA bundle's
 * contains a space (`Application Support`).
 */
const BUNDLE_FRAME = /address at (.+?):(\d+):(\d+)(?=\)?$)/u;
/** Hermes's own runtime, not in the map. */
const HERMES_RUNTIME = "InternalBytecode.js";

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** iOS bundle paths carry per-install container UUIDs, which split one crash into many groups. */
export function stripBundlePaths(stack: string): string {
  return stack
    .split("\n")
    .map((line) => {
      const match = BUNDLE_FRAME.exec(line);
      if (!match || !match[1]!.includes("/")) return line;
      const start = match.index + "address at ".length;
      return line.slice(0, start) + baseName(match[1]!) + line.slice(start + match[1]!.length);
    })
    .join("\n");
}

interface SymbolicatedStack {
  readonly stack: string;
  /** Frames in the app bundle. */
  readonly bundleFrames: number;
  /** Bundle frames the map resolved. */
  readonly mappedFrames: number;
  /** How much longer the stack got. */
  readonly growth: number;
}

/** Once the stack would grow by more than `maxGrowth`, the remaining frames keep their offsets. */
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
    if (!match || baseName(match[1]!) === HERMES_RUNTIME) return line;
    bundleFrames += 1;
    if (exhausted) return line;
    const position = originalPositionFor(map, Number(match[2]), Number(match[3]));
    if (!position) return line;
    const lineAndColumn = `:${position.line}:${position.column + 1}`;
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
