/**
 * Reads the protobuf wire format: tags, varints, fixed-width numbers, and
 * length-delimited data, from a byte array.
 *
 * **Mental model**
 *
 * - A message is a sequence of fields. Each field is a tag, made of a field
 *   number and a {@link WireType}, followed by its value.
 * - The reader knows nothing about messages or schemas. The caller reads a
 *   tag, picks the value to read by its field number, and skips the fields it
 *   does not know with {@link ProtobufReader.skip}.
 * - {@link ProtobufReader.delimited} reads a length prefix and returns a child
 *   reader restricted to that range. The parent advances past the range.
 *   Both readers report offsets in the original input.
 * - The reader borrows its input. {@link ProtobufReader.bytes} returns an
 *   independent copy; {@link ProtobufReader.bytesView} returns a view sharing
 *   the input's memory.
 *
 * **Gotchas**
 *
 * - Malformed input throws a {@link ProtobufReaderError}: a truncated value, a
 *   varint longer than ten bytes, a length past the end of the input, a tag
 *   with field number 0 or wire type 6 or 7, an unmatched group tag, or a
 *   string that is not valid UTF-8, unless validation is explicitly disabled.
 * - As in protobuf, `int32`, `uint32`, `sint32`, and enum varints of up to ten
 *   bytes are accepted and truncated to 32 bits.
 * - Skipping unknown groups uses a bounded stack. Callers can supply the
 *   remaining nesting budget to {@link ProtobufReader.skip}.
 *
 * **Example** (Reading a message with a nested message)
 *
 * ```ts import.meta.vitest
 * import { ProtobufReader, ProtobufWriter } from "effect/protobuf"
 *
 * // message Point { int32 x = 1; int32 y = 2; }
 * const readPoint = (r: ProtobufReader.ProtobufReader) => {
 *   let x = 0
 *   let y = 0
 *   while (!r.isDone()) {
 *     const tag = r.tag()
 *     switch (ProtobufReader.fieldNumber(tag)) {
 *       case 1:
 *         x = r.int32()
 *         break
 *       case 2:
 *         y = r.int32()
 *         break
 *       default:
 *         r.skip(tag)
 *     }
 *   }
 *   return { x, y }
 * }
 *
 * // message Shape { string name = 1; Point origin = 2; }
 * const { Len, Varint } = ProtobufWriter.WireType
 * const w = ProtobufWriter.make()
 * w.tag(1, Len).string("box")
 * w.tag(2, Len).fork().tag(2, Varint).int32(-1).join()
 *
 * const r = ProtobufReader.make(w.finish())
 * r.tag()
 * r.string() // => "box"
 * r.tag()
 * readPoint(r.delimited()) // => { x: 0, y: -1 }
 * r.isDone() // => true
 * ```
 *
 * @stability experimental
 * @since 4.1.5
 */
import * as Data from "../Data.ts"
import * as Utf8 from "../internal/utf8.ts"
import * as internal from "./internal/wireType.ts"

/**
 * The wire types of the protobuf format, which a tag carries with the field
 * number. The same as `ProtobufWriter.WireType`.
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
 * The error thrown by a {@link ProtobufReader} for malformed input.
 *
 * **Details**
 *
 * `offset` is the position in the input where reading failed.
 *
 * **Example** (Catching malformed input)
 *
 * ```ts import.meta.vitest
 * import { ProtobufReader } from "effect/protobuf"
 *
 * // A varint whose last byte is missing
 * const r = ProtobufReader.make(new Uint8Array([0x08, 0x96]))
 * r.tag()
 * try {
 *   r.int32()
 * } catch (e) {
 *   e instanceof ProtobufReader.ProtobufReaderError // => true
 *   String((e as ProtobufReader.ProtobufReaderError).message) // => "Expected a complete value at offset 2"
 * }
 * ```
 *
 * @stability experimental
 * @category errors
 * @since 4.1.5
 */
export class ProtobufReaderError extends Data.TaggedError("ProtobufReaderError")<{
  readonly message: string
  readonly offset: number
}> {}

/**
 * A reader of the protobuf wire format, positioned at its current offset.
 *
 * **Details**
 *
 * Every method throws a {@link ProtobufReaderError} for malformed input.
 * 64-bit integers are read as a `bigint`, or as a `number` with
 * {@link ProtobufReader.int64Number} and its siblings. Create one with
 * {@link make}.
 *
 * **Example** (Reading a field)
 *
 * ```ts import.meta.vitest
 * import { ProtobufReader } from "effect/protobuf"
 *
 * // message Test { int32 a = 1; } with a = 150
 * const r = ProtobufReader.make(new Uint8Array([0x08, 0x96, 0x01]))
 * const tag = r.tag()
 * ProtobufReader.fieldNumber(tag) // => 1
 * r.int32() // => 150
 * r.isDone() // => true
 * ```
 *
 * @stability experimental
 * @category models
 * @since 4.1.5
 */
export class ProtobufReader {
  private readonly buf: Uint8Array
  private pos = 0
  // The end of this reader's range in the original input.
  private limit: number
  // The halves of the last 64-bit varint.
  private lo = 0
  private hi = 0

  /**
   * Creates a reader borrowing `bytes`. Mutating `bytes` affects subsequent
   * reads and any views returned by {@link ProtobufReader.bytesView}.
   *
   * @since 4.1.5
   */
  constructor(bytes: Uint8Array) {
    this.buf = bytes
    this.limit = bytes.length
  }

  /**
   * The position of the next byte to read.
   *
   * @since 4.1.5
   */
  get offset(): number {
    return this.pos
  }

  /**
   * Whether every byte of the message being read has been read.
   *
   * @since 4.1.5
   */
  isDone(): boolean {
    return this.pos >= this.limit
  }

  private fail(expected: string): never {
    throw new ProtobufReaderError({ message: `Expected ${expected} at offset ${this.pos}`, offset: this.pos })
  }

  /**
   * Reads a tag, which {@link fieldNumber} and {@link wireType} take apart.
   *
   * @since 4.1.5
   */
  tag(): number {
    const tag = this.length32()
    if (tag >>> 3 === 0 || (tag & 7) > I32) this.fail("a tag with a nonzero field number and a wire type up to 5")
    return tag
  }

  private byte(): number {
    if (this.pos >= this.limit) this.fail(COMPLETE)
    return this.buf[this.pos++]
  }

  private need(n: number): void {
    if (this.pos + n > this.limit) this.fail(COMPLETE)
  }

  // A varint of at most 32 bits, as tags and lengths are. Longer ones are
  // rejected rather than truncated, so that bytes cannot be framed two ways.
  private length32(): number {
    let result = 0
    for (let i = 0; i < 5; i++) {
      const b = this.byte()
      if (i === 4 && b > 0x0F) break
      result |= (b & 0x7F) << (7 * i)
      if (b < 0x80) return result >>> 0
    }
    return this.fail("a varint of at most 32 bits")
  }

  /**
   * Reads a `uint32` varint.
   *
   * @since 4.1.5
   */
  uint32(): number {
    const buf = this.buf
    let p = this.pos
    let b = buf[p]
    // Most varints are a single byte.
    if (b < 0x80 && p < this.limit) {
      this.pos = p + 1
      return b
    }
    // With ten bytes left, no varint can run past the end.
    if (p + 10 > this.limit) return this.uint32Checked()
    b = buf[p++]
    let result = b & 0x7F
    if (b >= 0x80) {
      b = buf[p++]
      result |= (b & 0x7F) << 7
      if (b >= 0x80) {
        b = buf[p++]
        result |= (b & 0x7F) << 14
        if (b >= 0x80) {
          b = buf[p++]
          result |= (b & 0x7F) << 21
          if (b >= 0x80) {
            b = buf[p++]
            result |= (b & 0x7F) << 28
            for (let i = 0; b >= 0x80; i++) {
              if (i === 5) {
                this.pos = p
                this.fail(VARINT_64)
              }
              b = buf[p++]
            }
          }
        }
      }
    }
    this.pos = p
    return result >>> 0
  }

  private uint32Checked(): number {
    let result = 0
    for (let i = 0; i < 10; i++) {
      const b = this.byte()
      if (i < 5) result |= (b & 0x7F) << (7 * i)
      if (b < 0x80) return result >>> 0
    }
    return this.fail(VARINT_64)
  }

  /**
   * Reads an `int32` varint.
   *
   * @since 4.1.5
   */
  int32(): number {
    return this.uint32() | 0
  }

  /**
   * Reads a `sint32` varint, with the zigzag encoding.
   *
   * @since 4.1.5
   */
  sint32(): number {
    const n = this.uint32()
    return (n >>> 1) ^ -(n & 1)
  }

  // Reads a varint of up to ten bytes into `lo` and `hi`.
  private varint64(): void {
    const buf = this.buf
    let p = this.pos
    let b = buf[p]
    if (b < 0x80 && p < this.limit) {
      this.pos = p + 1
      this.lo = b
      this.hi = 0
      return
    }
    if (p + 10 > this.limit) return this.varint64Checked()
    b = buf[p++]
    let lo = b & 0x7F
    let hi = 0
    if (b >= 0x80) {
      for (let shift = 7; shift < 28; shift += 7) {
        b = buf[p++]
        lo |= (b & 0x7F) << shift
        if (b < 0x80) break
      }
      if (b >= 0x80) {
        b = buf[p++]
        lo |= (b & 0x0F) << 28
        hi = (b & 0x7F) >> 4
        for (let shift = 3; b >= 0x80; shift += 7) {
          if (shift > 31) {
            this.pos = p
            this.fail(VARINT_64)
          }
          b = buf[p++]
          hi |= (b & 0x7F) << shift
        }
      }
    }
    this.pos = p
    this.lo = lo >>> 0
    this.hi = hi >>> 0
  }

  private varint64Checked(): void {
    let lo = 0
    let hi = 0
    let b = 0x80
    for (let shift = 0; shift < 28 && b >= 0x80; shift += 7) {
      b = this.byte()
      lo |= (b & 0x7F) << shift
    }
    if (b >= 0x80) {
      b = this.byte()
      lo |= (b & 0x0F) << 28
      hi = (b & 0x7F) >> 4
      for (let shift = 3; b >= 0x80; shift += 7) {
        if (shift > 31) this.fail(VARINT_64)
        b = this.byte()
        hi |= (b & 0x7F) << shift
      }
    }
    this.lo = lo >>> 0
    this.hi = hi >>> 0
  }

  /**
   * Reads a `uint64` varint.
   *
   * @since 4.1.5
   */
  uint64(): bigint {
    this.varint64()
    return uint64FromHalves(this.lo, this.hi)
  }

  /**
   * Reads an `int64` varint.
   *
   * @since 4.1.5
   */
  int64(): bigint {
    this.varint64()
    return int64FromHalves(this.lo, this.hi)
  }

  /**
   * Reads a `sint64` varint, with the zigzag encoding.
   *
   * @since 4.1.5
   */
  sint64(): bigint {
    this.varint64()
    const mask = -(this.lo & 1)
    const lo = ((this.lo >>> 1) | (this.hi << 31)) ^ mask
    const hi = (this.hi >>> 1) ^ mask
    return int64FromHalves(lo >>> 0, hi >>> 0)
  }

  /**
   * Reads a `uint64` varint as a `number`.
   *
   * **Details**
   *
   * Outside the safe integer range the number is rounded, as `Number` rounds
   * a `bigint`, which `Number.isSafeInteger` detects. It saves creating a
   * `bigint` for each value.
   *
   * @since 4.1.5
   */
  uint64Number(): number {
    this.varint64()
    return this.hi * TWO_32 + this.lo
  }

  /**
   * Reads an `int64` varint as a `number`.
   *
   * **Details**
   *
   * Outside the safe integer range the number is rounded, as `Number` rounds
   * a `bigint`, which `Number.isSafeInteger` detects. It saves creating a
   * `bigint` for each value.
   *
   * **Example** (Reading an `int64` as a number)
   *
   * ```ts import.meta.vitest
   * import { ProtobufReader, ProtobufWriter } from "effect/protobuf"
   *
   * const bytes = ProtobufWriter.make().int64(-2).int64(2n ** 60n).finish()
   * const r = ProtobufReader.make(bytes)
   * r.int64Number() // => -2
   * Number.isSafeInteger(r.int64Number()) // => false
   * ```
   *
   * @since 4.1.5
   */
  int64Number(): number {
    this.varint64()
    return (this.hi | 0) * TWO_32 + this.lo
  }

  /**
   * Reads a `sint64` varint, with the zigzag encoding, as a `number`.
   *
   * **Details**
   *
   * Outside the safe integer range the number is rounded, as `Number` rounds
   * a `bigint`, which `Number.isSafeInteger` detects. It saves creating a
   * `bigint` for each value.
   *
   * @since 4.1.5
   */
  sint64Number(): number {
    this.varint64()
    const mask = -(this.lo & 1)
    const lo = ((this.lo >>> 1) | (this.hi << 31)) ^ mask
    const hi = (this.hi >>> 1) ^ mask
    return hi * TWO_32 + (lo >>> 0)
  }

  /**
   * Reads a `bool` varint: any nonzero value is `true`.
   *
   * @since 4.1.5
   */
  bool(): boolean {
    this.varint64()
    return this.lo !== 0 || this.hi !== 0
  }

  /**
   * Reads a little-endian `sfixed32`.
   *
   * @since 4.1.5
   */
  sfixed32(): number {
    this.need(4)
    const buf = this.buf
    const p = this.pos
    this.pos = p + 4
    return buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16) | (buf[p + 3] << 24)
  }

  /**
   * Reads a little-endian `fixed32`.
   *
   * @since 4.1.5
   */
  fixed32(): number {
    return this.sfixed32() >>> 0
  }

  /**
   * Reads a little-endian `fixed64`.
   *
   * @since 4.1.5
   */
  fixed64(): bigint {
    this.need(8)
    const lo = this.fixed32()
    return uint64FromHalves(lo, this.fixed32())
  }

  /**
   * Reads a little-endian `sfixed64`.
   *
   * @since 4.1.5
   */
  sfixed64(): bigint {
    this.need(8)
    const lo = this.fixed32()
    return int64FromHalves(lo, this.fixed32())
  }

  /**
   * Reads a little-endian `fixed64` as a `number`.
   *
   * **Details**
   *
   * Outside the safe integer range the number is rounded, as `Number` rounds
   * a `bigint`, which `Number.isSafeInteger` detects. It saves creating a
   * `bigint` for each value.
   *
   * @since 4.1.5
   */
  fixed64Number(): number {
    this.need(8)
    const lo = this.fixed32()
    return this.fixed32() * TWO_32 + lo
  }

  /**
   * Reads a little-endian `sfixed64` as a `number`.
   *
   * **Details**
   *
   * Outside the safe integer range the number is rounded, as `Number` rounds
   * a `bigint`, which `Number.isSafeInteger` detects. It saves creating a
   * `bigint` for each value.
   *
   * @since 4.1.5
   */
  sfixed64Number(): number {
    this.need(8)
    const lo = this.fixed32()
    return this.sfixed32() * TWO_32 + lo
  }

  /**
   * Reads a little-endian 32-bit `float`.
   *
   * @since 4.1.5
   */
  float(): number {
    halvesView.setInt32(0, this.sfixed32(), true)
    return halvesView.getFloat32(0, true)
  }

  /**
   * Reads a little-endian 64-bit `double`.
   *
   * @since 4.1.5
   */
  double(): number {
    this.need(8)
    halvesView.setInt32(0, this.sfixed32(), true)
    halvesView.setInt32(4, this.sfixed32(), true)
    return halvesView.getFloat64(0, true)
  }

  // Reads a length prefix and returns the offset where the data ends.
  private end(): number {
    const length = this.length32()
    this.need(length)
    return this.pos + length
  }

  /**
   * Reads length-prefixed bytes, as a copy.
   *
   * @since 4.1.5
   */
  bytes(): Uint8Array<ArrayBuffer> {
    // A copy, also of a Node.js `Buffer`, whose `slice` is a view.
    return new Uint8Array(this.bytesView())
  }

  /**
   * Reads length-prefixed bytes as a view of the input. Mutating the input or
   * the returned view changes the other; use {@link ProtobufReader.bytes}
   * when the result must own its bytes.
   *
   * @since 4.1.5
   */
  bytesView(): Uint8Array {
    const end = this.end()
    const out = this.buf.subarray(this.pos, end)
    this.pos = end
    return out
  }

  /**
   * Reads a length-prefixed string. Invalid UTF-8 fails by default; setting
   * `validateUtf8` to `false` replaces invalid sequences with U+FFFD.
   *
   * @since 4.1.5
   */
  string(options?: { readonly validateUtf8?: boolean | undefined }): string {
    const end = this.end()
    const out = options?.validateUtf8 === false
      ? Utf8.decodeLax(this.buf, this.pos, end)
      : Utf8.decode(this.buf, this.pos, end)
    if (out === undefined) return this.fail("valid UTF-8")
    this.pos = end
    return out
  }

  /**
   * Reads a length prefix and returns a child reader restricted to its payload.
   * Advances this reader past the payload immediately. The child borrows the
   * same input and reports absolute offsets; it cannot read enclosing fields.
   * Leaving part of the child unread does not affect the parent's position.
   *
   * @since 4.1.5
   */
  delimited(): ProtobufReader {
    const end = this.end()
    const child = new ProtobufReader(this.buf)
    child.pos = this.pos
    child.limit = end
    this.pos = end
    return child
  }

  /**
   * Skips the value of the field of `tag`, including all of a group. Group
   * nesting is bounded by `maxDepth`, 512 by default, and uses an explicit
   * stack. A zero limit rejects groups but permits other wire types. The limit
   * must be a non-negative integer; otherwise this throws `RangeError`.
   *
   * @since 4.1.5
   */
  skip(tag: number, maxDepth = MAX_GROUP_DEPTH): void {
    if (!Number.isInteger(maxDepth) || maxDepth < 0) {
      throw new RangeError("ProtobufReader.skip maxDepth must be a non-negative integer")
    }
    let groups: Array<number> | undefined
    while (true) {
      switch (tag & 7) {
        case VARINT:
          this.varint64()
          break
        case I64:
          this.need(8)
          this.pos += 8
          break
        case LEN:
          this.pos = this.end()
          break
        case START_GROUP:
          groups ??= []
          if (groups.length >= maxDepth) this.fail(`groups nested at most ${maxDepth} deep`)
          groups.push(tag >>> 3)
          break
        case END_GROUP: {
          const number = groups?.pop()
          if (number === undefined) this.fail(`a start group tag before the end group tag of field ${tag >>> 3}`)
          if (tag >>> 3 !== number) this.fail(`an end group tag for field ${number}`)
          break
        }
        case I32:
          this.need(4)
          this.pos += 4
          break
        default:
          this.fail("a wire type up to 5")
      }
      if (groups === undefined || groups.length === 0) return
      tag = this.tag()
    }
  }
}

/**
 * The field number of a tag from {@link ProtobufReader.tag}.
 *
 * @stability experimental
 * @category utils
 * @since 4.1.5
 */
export const fieldNumber = (tag: number): number => tag >>> 3

/**
 * The wire type of a tag from {@link ProtobufReader.tag}.
 *
 * @stability experimental
 * @category utils
 * @since 4.1.5
 */
export const wireType = (tag: number): WireType => (tag & 7) as WireType

/**
 * Creates a reader of `bytes`, which are not copied.
 *
 * **Example** (Creating a reader)
 *
 * ```ts import.meta.vitest
 * import { ProtobufReader } from "effect/protobuf"
 *
 * ProtobufReader.make(new Uint8Array([0x96, 0x01])).uint32() // => 150
 * ```
 *
 * @stability experimental
 * @category constructors
 * @since 4.1.5
 */
export const make = (bytes: Uint8Array): ProtobufReader => new ProtobufReader(bytes)

// -----------------------------------------------------------------------------
// internal
// -----------------------------------------------------------------------------

const { EndGroup: END_GROUP, I32, I64, Len: LEN, StartGroup: START_GROUP, Varint: VARINT } = internal.WireType

// Default bound on the explicit stack used to skip unknown groups.
const MAX_GROUP_DEPTH = 512

const COMPLETE = "a complete value"
const VARINT_64 = "a varint of at most 10 bytes"

// 64-bit integers are read as their unsigned 32-bit halves, and joined through
// a view, which is faster than bigint arithmetic. Floats are read through it
// too, which saves a `DataView` of the input for each reader.
const halvesView = new DataView(new ArrayBuffer(8))

// A 64-bit integer is its high half times this plus its unsigned low half,
// which rounds once, as `Number` rounds a `bigint`.
const TWO_32 = 4294967296

const int64FromHalves = (lo: number, hi: number): bigint => {
  halvesView.setUint32(0, lo, true)
  halvesView.setUint32(4, hi, true)
  return halvesView.getBigInt64(0, true)
}

const uint64FromHalves = (lo: number, hi: number): bigint => {
  halvesView.setUint32(0, lo, true)
  halvesView.setUint32(4, hi, true)
  return halvesView.getBigUint64(0, true)
}
