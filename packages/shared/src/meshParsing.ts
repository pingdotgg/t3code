// @effect-diagnostics globalTimers:off - Plain async parsing shared by the server and browsers, which
// yields between batches without an Effect runtime.
/**
 * Building blocks for the mesh parsers. Parsers read numbers straight from bytes instead of
 * decoding text, store indexed geometry in typed arrays sized up front where the format allows,
 * and yield to the event loop so large files never freeze a server or a page.
 */

/** Indexed triangle geometry in Z-up coordinates. */
export interface Mesh {
  /** Three coordinates per vertex. */
  readonly points: Float32Array;
  /** Three vertex indices per triangle, or `null` when every three points form a triangle. */
  readonly indices: Uint32Array | null;
}

export interface MeshLimits {
  readonly maxTriangles: number;
}

export function triangleCount(mesh: Mesh): number {
  return mesh.indices ? mesh.indices.length / 3 : mesh.points.length / 9;
}

// Works in Node and browsers; batches are large enough that timer clamping does not matter.
const yieldToEventLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Counts work and yields every `every` units, checking for cancellation each time. */
export function workBudget(signal: AbortSignal, every: number) {
  let spent = 0;
  return {
    /** True when the caller should `await budget.pause()`. */
    spend(units = 1) {
      spent += units;
      return spent >= every;
    },
    async pause() {
      spent = 0;
      await yieldToEventLoop();
      signal.throwIfAborted();
    },
  };
}

/** A typed array that doubles when full, for formats that do not state their counts. */
export class GrowableArray<T extends Float32Array | Uint32Array> {
  data: T;
  length = 0;
  private readonly make: (size: number) => T;

  constructor(make: (size: number) => T, initial = 3 * 1024) {
    this.make = make;
    this.data = make(initial);
  }

  push3(a: number, b: number, c: number) {
    if (this.length + 3 > this.data.length) {
      const grown = this.make(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    this.data[this.length] = a;
    this.data[this.length + 1] = b;
    this.data[this.length + 2] = c;
    this.length += 3;
  }

  /** The filled part, copied once so the spare capacity can be freed. */
  finish(): T {
    return this.data.slice(0, this.length) as T;
  }
}

const POWERS_OF_TEN = Array.from({ length: 23 }, (_, power) => 10 ** power);

const SPACE = 0x20;
const TAB = 0x09;
const CARRIAGE_RETURN = 0x0d;
const NEWLINE = 0x0a;

export function isDigit(byte: number) {
  return byte >= 0x30 && byte <= 0x39;
}

/**
 * Reads ASCII numbers and words directly from bytes. Avoiding a decoded string keeps memory at the
 * size of the file and is several times faster than splitting text.
 */
export class ByteReader {
  bytes: Uint8Array;
  position: number;
  end: number;

  constructor(bytes: Uint8Array, position = 0, end = bytes.length) {
    this.bytes = bytes;
    this.position = position;
    this.end = end;
  }

  /** Skips spaces and tabs, but not line breaks. */
  skipSpaces() {
    while (this.position < this.end) {
      const byte = this.bytes[this.position];
      if (byte !== SPACE && byte !== TAB && byte !== CARRIAGE_RETURN) return;
      this.position += 1;
    }
  }

  /** Skips all whitespace, including line breaks. */
  skipWhitespace() {
    while (this.position < this.end && this.bytes[this.position]! <= SPACE) this.position += 1;
  }

  /** Moves past the next line break. */
  nextLine() {
    const found = this.bytes.indexOf(NEWLINE, this.position);
    this.position = found < 0 || found >= this.end ? this.end : found + 1;
  }

  atLineEnd() {
    return this.position >= this.end || this.bytes[this.position] === NEWLINE;
  }

  /** Skips the current token: everything up to the next whitespace. */
  skipToken() {
    while (this.position < this.end && this.bytes[this.position]! > SPACE) this.position += 1;
  }

  /**
   * Reads a decimal number such as `-12`, `0.5` or `1.5e-3` and stops after it. Returns `NaN`, and
   * skips the token, when there is no number here.
   */
  number(): number {
    const { bytes, end } = this;
    let at = this.position;
    let negative = false;
    if (at < end && (bytes[at] === 0x2d || bytes[at] === 0x2b)) {
      negative = bytes[at] === 0x2d;
      at += 1;
    }
    let mantissa = 0;
    let exponent = 0;
    let digits = 0;
    while (at < end && isDigit(bytes[at]!)) {
      // Beyond 17 significant digits a double cannot hold more; keep the magnitude.
      if (digits < 17) mantissa = mantissa * 10 + (bytes[at]! - 0x30);
      else exponent += 1;
      digits += 1;
      at += 1;
    }
    if (at < end && bytes[at] === 0x2e) {
      at += 1;
      while (at < end && isDigit(bytes[at]!)) {
        if (digits < 17) {
          mantissa = mantissa * 10 + (bytes[at]! - 0x30);
          exponent -= 1;
        }
        digits += 1;
        at += 1;
      }
    }
    if (digits === 0) {
      this.skipToken();
      return Number.NaN;
    }
    if (at < end && (bytes[at] === 0x65 || bytes[at] === 0x45)) {
      let next = at + 1;
      let exponentNegative = false;
      if (next < end && (bytes[next] === 0x2d || bytes[next] === 0x2b)) {
        exponentNegative = bytes[next] === 0x2d;
        next += 1;
      }
      if (next < end && isDigit(bytes[next]!)) {
        let written = 0;
        while (next < end && isDigit(bytes[next]!)) {
          written = written * 10 + (bytes[next]! - 0x30);
          next += 1;
        }
        exponent += exponentNegative ? -written : written;
        at = next;
      }
    }
    this.position = at;
    const scale = Math.abs(exponent);
    const power = scale < POWERS_OF_TEN.length ? POWERS_OF_TEN[scale]! : 10 ** scale;
    const value = exponent < 0 ? mantissa / power : mantissa * power;
    return negative ? -value : value;
  }

  /** True, and moves past it, when the next bytes spell `word`. */
  consume(word: string) {
    if (this.position + word.length > this.end) return false;
    for (let index = 0; index < word.length; index += 1) {
      if (this.bytes[this.position + index] !== word.charCodeAt(index)) return false;
    }
    this.position += word.length;
    return true;
  }
}
