/**
 * Writes the protobuf wire format: tags, varints, fixed-width numbers, and
 * length-delimited data, into one growing buffer.
 *
 * **Mental model**
 *
 * - A message is a sequence of fields. Each field is a tag, made of a field
 *   number and a {@link WireType}, followed by its value.
 * - The writer knows nothing about messages or schemas. The caller writes
 *   each tag and value in the order it wants them on the wire.
 * - A nested message, string, or bytes field is length-delimited. Nested
 *   messages are written in place between {@link ProtobufWriter.fork} and
 *   {@link ProtobufWriter.join}, which fills in the length prefix afterwards.
 *
 * **Gotchas**
 *
 * - Values are not validated. As with `DataView`, numbers are truncated to
 *   integers, and integers outside the range of their type wrap around.
 *   Tags are checked and invalid field numbers or wire types throw `RangeError`.
 * - Unpaired UTF-16 surrogates in strings are written as U+FFFD, as with
 *   `TextEncoder`.
 *
 * **Example** (Writing a message with a nested message)
 *
 * ```ts import.meta.vitest
 * import { ProtobufWriter } from "effect/protobuf"
 *
 * // message Point { int32 x = 1; int32 y = 2; }
 * // message Shape { string name = 1; Point origin = 2; }
 * const { Len, Varint } = ProtobufWriter.WireType
 * const w = ProtobufWriter.make()
 * w.tag(1, Len).string("box")
 * w.tag(2, Len).fork()
 * w.tag(1, Varint).int32(3)
 * w.tag(2, Varint).int32(-1)
 * w.join()
 *
 * w.finish().length // => 20
 * ```
 *
 * @stability experimental
 * @since 4.1.5
 */
import * as internal from "./internal/wireType.ts"

/**
 * The wire types of the protobuf format, which a tag carries with the field
 * number.
 *
 * **Details**
 *
 * - `Varint`: `int32`, `int64`, `uint32`, `uint64`, `sint32`, `sint64`,
 *   `bool`, and enums.
 * - `I64`: `fixed64`, `sfixed64`, and `double`.
 * - `Len`: strings, bytes, nested messages, and packed repeated fields.
 * - `StartGroup` and `EndGroup`: the deprecated proto2 groups.
 * - `I32`: `fixed32`, `sfixed32`, and `float`.
 *
 * @stability experimental
 * @category constants
 * @since 4.1.5
 */
export const WireType: {
  readonly Varint: 0
  readonly I64: 1
  readonly Len: 2
  readonly StartGroup: 3
  readonly EndGroup: 4
  readonly I32: 5
} = internal.WireType

/**
 * A protobuf wire type, from 0 through 5.
 *
 * @stability experimental
 * @category models
 * @since 4.1.5
 */
export type WireType = typeof WireType[keyof typeof WireType]

/**
 * A writer of the protobuf wire format.
 *
 * **Details**
 *
 * Every write returns the writer, so writes chain: `w.tag(1, WireType.Len).string("a")`.
 * 64-bit integers are given as a `bigint`, a `number` that is an integer, or a
 * decimal `string`. {@link ProtobufWriter.finish} returns the bytes and resets
 * the writer, which can then write a new message. Create one with {@link make}.
 *
 * **Example** (Writing a field)
 *
 * ```ts import.meta.vitest
 * import { ProtobufWriter } from "effect/protobuf"
 *
 * // message Test { int32 a = 1; } with a = 150
 * ProtobufWriter.make()
 *   .tag(1, ProtobufWriter.WireType.Varint)
 *   .int32(150)
 *   .finish() // => new Uint8Array([0x08, 0x96, 0x01])
 * ```
 *
 * @stability experimental
 * @category models
 * @since 4.1.5
 */
export class ProtobufWriter {
  // A writer holds no buffer until its first write, and again after `finish`.
  private buf: Uint8Array<ArrayBuffer> = EMPTY
  private view: DataView = EMPTY_VIEW
  private pos = 0
  // The starts of the length-delimited values that are not joined yet.
  private readonly forks: Array<number> = []

  /**
   * Returns an owned copy of the written bytes and resets the writer. Later
   * writes cannot change the returned bytes. Throws if a
   * {@link ProtobufWriter.fork} is not joined.
   *
   * @since 4.1.5
   */
  finish(): Uint8Array<ArrayBuffer> {
    if (this.forks.length > 0) throw new Error("ProtobufWriter.finish with a fork that is not joined")
    // The buffer goes to the next message, of this writer or another.
    const out = this.buf.slice(0, this.pos)
    if (this.buf.length > 0 && this.buf.length <= SPARE_MAX) {
      spareBuf = this.buf
      spareView = this.view
    }
    this.buf = EMPTY
    this.view = EMPTY_VIEW
    this.pos = 0
    return out
  }

  /**
   * Starts a length-delimited value, such as a nested message or a packed
   * repeated field, after its tag. {@link ProtobufWriter.join} ends it.
   *
   * @since 4.1.5
   */
  fork(): this {
    this.forks.push(this.reserveLength())
    return this
  }

  /**
   * Ends the length-delimited value of the last {@link ProtobufWriter.fork},
   * filling in its length.
   *
   * @since 4.1.5
   */
  join(): this {
    const start = this.forks.pop()
    if (start === undefined) throw new Error("ProtobufWriter.join without a fork")
    this.fillLength(start)
    return this
  }

  /**
   * Writes a tag: an integer field number from 1 through 536870911 and a wire
   * type from 0 through 5. Invalid arguments throw `RangeError` before writing.
   *
   * @since 4.1.5
   */
  tag(fieldNumber: number, wireType: WireType): this {
    if (!Number.isInteger(fieldNumber) || fieldNumber < 1 || fieldNumber > 536870911) {
      throw new RangeError("ProtobufWriter.tag fieldNumber must be an integer from 1 through 536870911")
    }
    if (!Number.isInteger(wireType) || wireType < 0 || wireType > 5) {
      throw new RangeError("ProtobufWriter.tag wireType must be an integer from 0 through 5")
    }
    return this.uint32(fieldNumber * 8 + wireType)
  }

  /**
   * Writes a `uint32` varint.
   *
   * @since 4.1.5
   */
  uint32(n: number): this {
    this.ensure(5)
    const buf = this.buf
    n = n >>> 0
    while (n > 0x7F) {
      buf[this.pos++] = (n & 0x7F) | 0x80
      n = n >>> 7
    }
    buf[this.pos++] = n
    return this
  }

  /**
   * Writes an `int32` varint. Negative values take ten bytes, as for `int64`.
   *
   * @since 4.1.5
   */
  int32(n: number): this {
    n = n | 0
    if (n >= 0) return this.uint32(n)
    return this.varint64(n >>> 0, 0xFFFFFFFF)
  }

  /**
   * Writes a `sint32` varint, with the zigzag encoding.
   *
   * @since 4.1.5
   */
  sint32(n: number): this {
    return this.uint32(((n << 1) ^ (n >> 31)) >>> 0)
  }

  /**
   * Writes a `uint64` varint.
   *
   * @since 4.1.5
   */
  uint64(n: bigint | number | string): this {
    return this.int64(n)
  }

  /**
   * Writes an `int64` varint. Negative values take ten bytes.
   *
   * @since 4.1.5
   */
  int64(n: bigint | number | string): this {
    if (typeof n === "number" && n >>> 0 === n) return this.uint32(n)
    split64(n)
    return this.varint64(halvesView.getUint32(0, true), halvesView.getUint32(4, true))
  }

  /**
   * Writes a `sint64` varint, with the zigzag encoding.
   *
   * @since 4.1.5
   */
  sint64(n: bigint | number | string): this {
    split64(n)
    const lo = halvesView.getUint32(0, true)
    const hi = halvesView.getUint32(4, true)
    const sign = (hi | 0) >> 31
    return this.varint64(((lo << 1) ^ sign) >>> 0, (((hi << 1) | (lo >>> 31)) ^ sign) >>> 0)
  }

  /**
   * Writes a `bool` varint.
   *
   * @since 4.1.5
   */
  bool(value: boolean): this {
    this.ensure(1)
    this.buf[this.pos++] = value ? 1 : 0
    return this
  }

  /**
   * Writes a little-endian `fixed32`.
   *
   * @since 4.1.5
   */
  fixed32(n: number): this {
    this.ensure(4)
    this.view.setUint32(this.pos, n >>> 0, true)
    this.pos += 4
    return this
  }

  /**
   * Writes a little-endian `sfixed32`.
   *
   * @since 4.1.5
   */
  sfixed32(n: number): this {
    this.ensure(4)
    this.view.setInt32(this.pos, n | 0, true)
    this.pos += 4
    return this
  }

  /**
   * Writes a little-endian `fixed64`.
   *
   * @since 4.1.5
   */
  fixed64(n: bigint | number | string): this {
    split64(n)
    this.ensure(8)
    this.view.setUint32(this.pos, halvesView.getUint32(0, true), true)
    this.view.setUint32(this.pos + 4, halvesView.getUint32(4, true), true)
    this.pos += 8
    return this
  }

  /**
   * Writes a little-endian `sfixed64`.
   *
   * @since 4.1.5
   */
  sfixed64(n: bigint | number | string): this {
    return this.fixed64(n)
  }

  /**
   * Writes a little-endian 32-bit `float`.
   *
   * @since 4.1.5
   */
  float(n: number): this {
    this.ensure(4)
    this.view.setFloat32(this.pos, n, true)
    this.pos += 4
    return this
  }

  /**
   * Writes a little-endian 64-bit `double`.
   *
   * @since 4.1.5
   */
  double(n: number): this {
    this.ensure(8)
    this.view.setFloat64(this.pos, n, true)
    this.pos += 8
    return this
  }

  /**
   * Writes length-prefixed bytes.
   *
   * @since 4.1.5
   */
  bytes(bytes: Uint8Array): this {
    this.uint32(bytes.length)
    return this.raw(bytes)
  }

  /**
   * Writes bytes as they are, without a length prefix, such as fields that
   * are already encoded.
   *
   * **Example** (Copying encoded fields)
   *
   * ```ts import.meta.vitest
   * import { ProtobufWriter } from "effect/protobuf"
   *
   * const { Varint } = ProtobufWriter.WireType
   * const fields = ProtobufWriter.make().tag(1, Varint).uint32(150).finish()
   *
   * ProtobufWriter.make().tag(2, Varint).bool(true).raw(fields).finish() // => new Uint8Array([0x10, 0x01, 0x08, 0x96, 0x01])
   * ```
   *
   * @since 4.1.5
   */
  raw(bytes: Uint8Array): this {
    this.ensure(bytes.length)
    this.buf.set(bytes, this.pos)
    this.pos += bytes.length
    return this
  }

  /**
   * Writes a length-prefixed UTF-8 string.
   *
   * @since 4.1.5
   */
  string(s: string): this {
    const n = s.length
    const start = this.reserveLength()
    if (n > SHORT_STRING) {
      // Room for ASCII first. If that runs out, the rest takes at most three
      // bytes per UTF-16 code unit.
      this.ensure(n)
      const { read, written } = utf8Encoder.encodeInto(s, this.buf.subarray(this.pos))
      this.pos += written
      if (read < n) {
        this.ensure((n - read) * 3)
        this.pos += utf8Encoder.encodeInto(s.slice(read), this.buf.subarray(this.pos)).written
      }
      this.fillLength(start)
      return this
    }
    this.ensure(n * 3)
    const buf = this.buf
    let pos = this.pos
    for (let i = 0; i < n; i++) {
      let c = s.charCodeAt(i)
      if (c < 0x80) {
        buf[pos++] = c
        continue
      }
      if (c < 0x800) {
        buf[pos++] = 0xC0 | (c >> 6)
        buf[pos++] = 0x80 | (c & 0x3F)
        continue
      }
      if (c >= 0xD800 && c <= 0xDFFF) {
        const next = i + 1 < n ? s.charCodeAt(i + 1) : 0
        if (c <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) {
          const cp = 0x10000 + ((c - 0xD800) << 10) + (next - 0xDC00)
          i++
          buf[pos++] = 0xF0 | (cp >> 18)
          buf[pos++] = 0x80 | ((cp >> 12) & 0x3F)
          buf[pos++] = 0x80 | ((cp >> 6) & 0x3F)
          buf[pos++] = 0x80 | (cp & 0x3F)
          continue
        }
        // A lone surrogate is written as U+FFFD, as `TextEncoder` writes it.
        c = 0xFFFD
      }
      buf[pos++] = 0xE0 | (c >> 12)
      buf[pos++] = 0x80 | ((c >> 6) & 0x3F)
      buf[pos++] = 0x80 | (c & 0x3F)
    }
    this.pos = pos
    this.fillLength(start)
    return this
  }

  private ensure(n: number): void {
    if (this.pos + n > this.buf.length) this.grow(n)
  }

  private grow(n: number): void {
    if (this.buf.length === 0 && spareBuf !== undefined) {
      this.buf = spareBuf
      this.view = spareView!
      spareBuf = spareView = undefined
      if (n <= this.buf.length) return
    }
    let size = this.buf.length === 0 ? INITIAL_SIZE : this.buf.length * 2
    while (size < this.pos + n) size *= 2
    const next = new Uint8Array(size)
    next.set(this.buf.subarray(0, this.pos))
    this.buf = next
    this.view = new DataView(next.buffer)
  }

  // A 64-bit varint from its unsigned 32-bit halves.
  private varint64(lo: number, hi: number): this {
    this.ensure(10)
    const buf = this.buf
    while (hi > 0 || lo > 0x7F) {
      buf[this.pos++] = (lo & 0x7F) | 0x80
      lo = ((lo >>> 7) | (hi << 25)) >>> 0
      hi = hi >>> 7
    }
    buf[this.pos++] = lo
    return this
  }

  // A one-byte length placeholder, which `fillLength` widens if needed.
  private reserveLength(): number {
    this.ensure(1)
    return this.pos++
  }

  private fillLength(start: number): void {
    const length = this.pos - start - 1
    if (length < 0x80) {
      this.buf[start] = length
      return
    }
    let size = 1
    for (let n = length; n > 0x7F; n >>>= 7) size++
    this.ensure(size - 1)
    const buf = this.buf
    buf.copyWithin(start + size, start + 1, this.pos)
    this.pos += size - 1
    let n = length
    let p = start
    while (n > 0x7F) {
      buf[p++] = (n & 0x7F) | 0x80
      n = n >>> 7
    }
    buf[p] = n
  }
}

/**
 * Creates a writer.
 *
 * **Example** (Creating a writer)
 *
 * ```ts import.meta.vitest
 * import { ProtobufWriter } from "effect/protobuf"
 *
 * ProtobufWriter.make().uint32(150).finish() // => new Uint8Array([0x96, 0x01])
 * ```
 *
 * @stability experimental
 * @category constructors
 * @since 4.1.5
 */
export const make = (): ProtobufWriter => new ProtobufWriter()

// -----------------------------------------------------------------------------
// internal
// -----------------------------------------------------------------------------

// 64-bit integers are split into their unsigned 32-bit halves through a view,
// which is faster than bigint arithmetic.
const halvesView = new DataView(new ArrayBuffer(8))

// A string is read with `BigInt`.
const split64 = (n: bigint | number | string): void => {
  if (typeof n === "number") {
    n = Math.trunc(n)
    halvesView.setUint32(0, n >>> 0, true)
    halvesView.setUint32(4, Math.floor(n / 4294967296) >>> 0, true)
  } else {
    halvesView.setBigUint64(0, typeof n === "string" ? BigInt(n) : n, true)
  }
}

const utf8Encoder = new TextEncoder()

// The buffer of the last finished message, which the next one is written
// into. Only a message started while another is being written allocates one.
let spareBuf: Uint8Array<ArrayBuffer> | undefined
let spareView: DataView | undefined
const SPARE_MAX = 1 << 20
const INITIAL_SIZE = 1024

const EMPTY = new Uint8Array(0)
const EMPTY_VIEW = new DataView(EMPTY.buffer)

// Strings up to this length are encoded by hand, which is faster than calling
// the native encoder.
const SHORT_STRING = 32
