// Prepares resolved descriptors for shared wire operations. Decoding builds JavaScript
// objects and merges subsequent occurrences into the existing value. Defaults
// are installed only when a message is created. A final walk checks required
// fields and owns borrowed bytes, but is skipped when neither is present.
// Descriptor preparation selects field operations and wire tags once. Each
// call owns its message state, independently of the wire reader.

import * as Bytes from "../../Bytes.ts"
import * as InternalRecord from "../../internal/record.ts"
import * as Result from "../../Result.ts"
import type * as D from "../ProtobufDescriptor.ts"
import type * as ProtobufMessage from "../ProtobufMessage.ts"
import * as ProtobufReader from "../ProtobufReader.ts"
import * as ProtobufWriter from "../ProtobufWriter.ts"
import { WireType } from "./wireType.ts"

const unknownFields: unique symbol = Symbol.for("effect/protobuf/ProtobufMessage/unknownFields")

/** @internal */
export type DecodeOptions = Parameters<typeof ProtobufMessage.decode>[1]

/** @internal */
export type EncodeOptions = Parameters<typeof ProtobufMessage.encode>[1]

interface Message {
  [name: string]: any
  [unknownFields]?: Uint8Array
}
type Reader = ProtobufReader.ProtobufReader
type Writer = ProtobufWriter.ProtobufWriter

const DEFAULT_MAX_DEPTH = 100

const depthLimit = (value: number | undefined): number => {
  const depth = value ?? DEFAULT_MAX_DEPTH
  if (!Number.isInteger(depth) || depth < 0) fail("Expected maxDepth to be a non-negative integer")
  return depth
}

/**
 * A message failure and its field path. Throwing this internal value avoids
 * capturing a stack for expected malformed input; public functions return Result.
 *
 * @internal
 */
export class Failure {
  readonly reason: string
  readonly path: Array<PropertyKey>
  constructor(reason: string, path: Array<PropertyKey> = []) {
    this.reason = reason
    this.path = path
  }
  get message(): string {
    return this.path.length === 0 ? this.reason : `${formatPath(this.path)}: ${this.reason}`
  }
}

const formatPath = (path: ReadonlyArray<PropertyKey>): string => {
  let out = ""
  for (const key of path) {
    if (typeof key === "number") out += `[${key}]`
    else if (typeof key === "string" && /^[A-Za-z_$][\w$]*$/.test(key)) out += out === "" ? key : `.${key}`
    else out += `[${JSON.stringify(String(key))}]`
  }
  return out
}

const fail = (reason: string): never => {
  throw new Failure(reason)
}

// Prepends `key` to the path of a failure, and turns a reader error into one.
const rethrow = (e: unknown, key: PropertyKey): never => {
  if (e instanceof Failure) {
    e.path.unshift(key)
    throw e
  }
  if (e instanceof ProtobufReader.ProtobufReaderError) throw new Failure(e.message, [key])
  throw e
}

const show = (value: unknown): string => {
  switch (typeof value) {
    case "string":
      return JSON.stringify(value)
    case "bigint":
      return `${value}n`
    case "object":
      return value === null
        ? "null"
        : Array.isArray(value)
        ? "an array"
        : value instanceof Uint8Array
        ? "a Uint8Array"
        : "an object"
    default:
      return String(value)
  }
}

const expected = (what: string, value: unknown): never => fail(`Expected ${what}, got ${show(value)}`)

// "a uint64", "an int64".
const a = (scalar: string): string => scalar.startsWith("int") ? `an ${scalar}` : `a ${scalar}`

const scalarZero = (type: D.ScalarValueType): unknown => {
  switch (type.scalar) {
    case "bool":
      return false
    case "string":
      return ""
    case "bytes":
      return new Uint8Array(0)
    case "int64":
    case "uint64":
    case "sint64":
    case "fixed64":
    case "sfixed64":
      return type.jsType === "bigint" ? BIGINT_ZERO : type.jsType === "number" ? 0 : "0"
    default:
      return 0
  }
}

const BIGINT_ZERO = BigInt(0)

const wireTypeOf = (type: D.ValueType): number => {
  switch (type.kind) {
    case "enum":
      return WireType.Varint
    case "message":
      return type.delimited ? WireType.StartGroup : WireType.Len
    case "scalar":
      switch (type.scalar) {
        case "double":
        case "fixed64":
        case "sfixed64":
          return WireType.I64
        case "float":
        case "fixed32":
        case "sfixed32":
          return WireType.I32
        case "string":
        case "bytes":
          return WireType.Len
        default:
          return WireType.Varint
      }
  }
}

const is64Bit = (scalar: D.ScalarType): boolean =>
  scalar === "int64" || scalar === "uint64" || scalar === "sint64" || scalar === "fixed64" || scalar === "sfixed64"

const isUnsigned = (scalar: D.ScalarType): boolean =>
  scalar === "uint32" || scalar === "fixed32" || scalar === "uint64" || scalar === "fixed64"

const INT32_MIN = -2147483648
const INT32_MAX = 2147483647
const UINT32_MAX = 4294967295
const FLOAT32_MAX = 3.4028234663852886e38
const INT64_MIN = -(BigInt(1) << BigInt(63))
const INT64_MAX = (BigInt(1) << BigInt(63)) - BigInt(1)
const UINT64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1)

// A 64-bit integer given as a `bigint`, an integer `number` or a decimal
// `string`, in the range of the scalar.
const toInt64 = (scalar: D.ScalarType, value: unknown): bigint | number => {
  let n: bigint
  if (typeof value === "bigint") {
    n = value
  } else if (typeof value === "number") {
    if (!Number.isInteger(value)) return expected(`an integer for ${a(scalar)}`, value)
    if (Number.isSafeInteger(value)) return isUnsigned(scalar) && value < 0 ? outOfRange(scalar, value) : value
    n = BigInt(value)
  } else if (typeof value === "string" && /^-?[0-9]+$/.test(value)) {
    n = BigInt(value)
  } else {
    return expected(`a bigint, integer or decimal string for ${a(scalar)}`, value)
  }
  const unsigned = isUnsigned(scalar)
  return (unsigned ? n >= BIGINT_ZERO && n <= UINT64_MAX : n >= INT64_MIN && n <= INT64_MAX)
    ? n
    : outOfRange(scalar, value)
}

const outOfRange = (scalar: D.ScalarType, value: unknown): never => expected(`${a(scalar)} in range`, value)

const int32 = (scalar: D.ScalarType, value: unknown): number =>
  typeof value === "number" && Number.isInteger(value) && value >= INT32_MIN && value <= INT32_MAX
    ? value
    : expected(`an integer for ${a(scalar)}`, value)

const uint32 = (scalar: D.ScalarType, value: unknown): number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= UINT32_MAX
    ? value
    : expected(`a non-negative integer for ${a(scalar)}`, value)

const float = (v: unknown): number =>
  typeof v === "number" && !(Number.isFinite(v) && Math.abs(v) > FLOAT32_MAX)
    ? v
    : expected("a number in the range of a float", v)

const ownValue = (message: Message, key: string): any => Object.hasOwn(message, key) ? message[key] : undefined
const assign = InternalRecord.assignProperty

interface Layout {
  readonly byNumber: { readonly [number: number]: ReadField | undefined }
  readonly ordered: ReadonlyArray<WriteField>
  readonly oneofs: ReadonlyArray<readonly [D.OneofDescriptor, ReadonlySet<string>]>
  readonly defaults: ReadonlyArray<readonly [string, () => unknown]>
  readonly finish: ReadonlyArray<D.FieldDescriptor>
  readonly required: boolean
}

interface ReadField {
  readonly key: string
  readonly wire: number
  readonly packed: boolean
  readonly read: (
    context: DecodeContext,
    r: Reader,
    target: Message,
    depth: number,
    start: number,
    packed: boolean
  ) => void
}

interface WriteField {
  readonly key: string
  readonly write: (context: EncodeContext, w: Writer, target: Message, depth: number) => void
}

const layouts = new WeakMap<D.MessageDescriptor, Layout>()
const layoutOf = (descriptor: D.MessageDescriptor): Layout => {
  let layout = layouts.get(descriptor)
  if (layout === undefined) {
    const max = descriptor.fields.reduce((max, field) => Math.max(max, field.number), 0)
    const byNumber: { [number: number]: ReadField | undefined } = max <= 1024
      ? new Array(max + 1).fill(undefined)
      : Object.create(null)
    const defaults: Array<readonly [string, () => unknown]> = []
    const finish: Array<D.FieldDescriptor> = []
    let required = false
    for (const field of descriptor.fields) {
      byNumber[field.number] = {
        key: field.oneof?.name ?? field.name,
        wire: field.kind === "map" ? WireType.Len : wireTypeOf(field.type),
        packed: field.kind === "list" && packable(field.type),
        read: prepareRead(field)
      }
      if (
        field.oneof === undefined &&
        (field.kind !== "singular" || field.presence === "implicit" && field.type.kind !== "message")
      ) {
        const zero = field.kind === "list" ? emptyList : field.kind === "map" ?
          emptyMessage
          : field.type.kind === "scalar" && field.type.scalar === "bytes" ?
          emptyBytes
          : constantDefault(valueDefault(field.type))
        defaults.push([field.name, zero])
      }
      if (field.kind === "singular" && field.presence === "required") required = true
      if (
        field.type.kind === "message" || field.type.kind === "scalar" && field.type.scalar === "bytes" ||
        field.kind === "singular" && field.presence === "required"
      ) finish.push(field)
    }
    layout = {
      byNumber,
      ordered: [...descriptor.fields].sort((a, b) => a.number - b.number).map((field) => ({
        key: field.oneof?.name ?? field.name,
        write: prepareWrite(field)
      })),
      oneofs: descriptor.oneofs.map((oneof) => [oneof, new Set(oneof.fields.map((field) => field.name))]),
      defaults,
      finish,
      required
    }
    layouts.set(descriptor, layout)
  }
  return layout
}

const emptyList = (): Array<unknown> => []
const emptyMessage = (): Message => ({})
const emptyBytes = (): Uint8Array => new Uint8Array(0)
const constantDefault = (value: unknown): () => unknown => () => value

const createMessage = (context: DecodeContext, layout: Layout): Message => {
  const target: Message = {}
  for (const [key, zero] of layout.defaults) assign(target, key, zero())
  if (layout.required) context.needsFinish = true
  return target
}

const enumNumbers = new WeakMap<D.EnumDescriptor, ReadonlySet<number>>()
const acceptsEnum = (descriptor: D.EnumDescriptor, value: number): boolean => {
  if (descriptor.open) return true
  let numbers = enumNumbers.get(descriptor)
  if (numbers === undefined) {
    numbers = new Set(descriptor.values.map((value) => value.number))
    enumNumbers.set(descriptor, numbers)
  }
  return numbers.has(value)
}

const packable = (type: D.ValueType): type is D.ScalarValueType | D.EnumValueType =>
  type.kind === "enum" || (type.kind === "scalar" && type.scalar !== "string" && type.scalar !== "bytes")

const valueDefault = (type: D.ValueType): unknown => {
  switch (type.kind) {
    case "message":
      return {}
    case "enum":
      return type.enum.open ? 0 : type.enum.values[0].number
    case "scalar":
      return scalarZero(type)
  }
}

const LAX_UTF8 = { validateUtf8: false } as const

const readScalar = (r: Reader, type: D.ScalarValueType, jsType = type.jsType): unknown => scalarReader(type, jsType)(r)

const writeScalar = (w: Writer, scalar: D.ScalarType, value: unknown): void => {
  scalarWriters[scalar](w, value)
}

const writeEnum = (w: Writer, type: D.EnumValueType, value: unknown): void => {
  const number = int32("int32", value)
  if (!acceptsEnum(type.enum, number)) expected(`a value of ${type.enum.typeName}`, value)
  w.int32(number)
}

const isZero = (type: D.ValueType, value: unknown): boolean => {
  if (type.kind === "message") return false
  if (type.kind === "enum") return value === valueDefault(type)
  switch (type.scalar) {
    case "double":
    case "float":
      return value === 0 && 1 / value > 0
    case "bool":
      return value === false
    case "string":
      return value === ""
    case "bytes":
      return value instanceof Uint8Array && value.length === 0
    default:
      return is64Bit(type.scalar) ? value === 0 || value === BIGINT_ZERO || value === "0" : value === 0
  }
}

// -----------------------------------------------------------------------------
// decoding
// -----------------------------------------------------------------------------

interface DecodeContext {
  input: Uint8Array
  readonly maxDepth: number
  readonly keepUnknown: boolean
  needsFinish: boolean
  // Weak keys let replaced messages and their spans become unreachable together.
  unknown: WeakMap<Message, Array<Uint8Array>> | undefined
}

const retain = (context: DecodeContext, message: Message, bytes: Uint8Array): void => {
  if (!context.keepUnknown) return
  context.unknown ??= new WeakMap()
  const chunks = context.unknown.get(message)
  if (chunks === undefined) context.unknown.set(message, [bytes])
  else chunks.push(bytes)
}

const retainOccurrence = (context: DecodeContext, target: Message, start: number, end: number): void => {
  if (context.keepUnknown) retain(context, target, context.input.subarray(start, end))
}

const checkDepth = (depth: number, limit: number): void => {
  if (depth > limit) fail(`Expected messages nested at most ${limit} deep`)
}

const decodeMessage = (descriptor: D.MessageDescriptor, bytes: Uint8Array, options?: DecodeOptions): Message => {
  const context: DecodeContext = {
    input: bytes,
    maxDepth: depthLimit(options?.maxDepth),
    keepUnknown: options?.readUnknownFields !== false,
    needsFinish: false,
    unknown: undefined
  }
  const target = readFields(context, ProtobufReader.make(bytes), descriptor, undefined, 0)
  if (context.needsFinish || context.unknown !== undefined) finishMessage(context, descriptor, target)
  return target
}

/** @internal */
export const decode = (
  descriptor: D.MessageDescriptor,
  bytes: Uint8Array,
  options: DecodeOptions | undefined
): Result.Result<Record<string, unknown>, Failure> => {
  try {
    return Result.succeed(decodeMessage(descriptor, bytes, options))
  } catch (error) {
    return Result.fail(toFailure(error))
  }
}

const toFailure = (error: unknown): Failure => {
  if (error instanceof Failure) return error
  if (error instanceof ProtobufReader.ProtobufReaderError) return new Failure(error.message)
  throw error
}

const readFields = (
  context: DecodeContext,
  r: Reader,
  descriptor: D.MessageDescriptor,
  before: Message | undefined,
  depth: number,
  group?: number
): Message => {
  checkDepth(depth, context.maxDepth)
  const layout = layoutOf(descriptor)
  const target = before ?? createMessage(context, layout)
  const fields = layout.byNumber
  while (true) {
    if (group === undefined && r.isDone()) return target
    const start = r.offset
    const tag = r.tag()
    const number = tag >>> 3
    const actual = tag & 7
    if (actual === WireType.EndGroup) {
      if (number === group) return target
      fail(`Expected a start group tag before the end group tag of field ${number}`)
    }
    const entry = fields[number]
    const packed = actual === WireType.Len && entry?.packed === true
    if (entry === undefined || (actual !== entry.wire && !packed)) {
      r.skip(tag, context.maxDepth - depth)
      retainOccurrence(context, target, start, r.offset)
      continue
    }
    try {
      entry.read(context, r, target, depth, start, packed)
    } catch (error) {
      rethrow(error, entry.key)
    }
  }
}

const prepareRead = (field: D.FieldDescriptor): ReadField["read"] => {
  if (field.kind === "singular") {
    if (field.oneof === undefined && field.type.kind === "scalar") {
      const key = field.name
      const read = scalarReader(field.type)
      if (field.type.scalar === "bytes") {
        return (context, r, target) => {
          assign(target, key, read(r))
          context.needsFinish = true
        }
      }
      return (_context, r, target) => {
        assign(target, key, read(r))
      }
    }
    return (context, r, target, depth, start) => readSingular(context, r, field, target, depth, start)
  }
  if (field.kind === "list") {
    if (packable(field.type)) {
      const key = field.name
      const readPacked = preparePackedRead(field.type, field.number)
      return (context, r, target, depth, start, packed) => {
        if (packed) readPacked(context, r, target, target[key])
        else readList(context, r, field, target, depth, start)
      }
    }
    return (context, r, target, depth, start) => readList(context, r, field, target, depth, start)
  }
  return (context, r, target, depth, start) => readMap(context, r, field, target, depth, start)
}

const readValue = (
  context: DecodeContext,
  r: Reader,
  type: D.ValueType,
  number: number,
  before: unknown,
  depth: number
): unknown => {
  switch (type.kind) {
    case "scalar":
      if (type.scalar === "bytes") context.needsFinish = true
      return readScalar(r, type)
    case "enum":
      return r.int32()
    case "message": {
      return readFields(
        context,
        type.delimited ? r : r.delimited(),
        type.message,
        before as Message | undefined,
        depth + 1,
        type.delimited ? number : undefined
      )
    }
  }
}

const readSingular = (
  context: DecodeContext,
  r: Reader,
  field: D.SingularFieldDescriptor,
  target: Message,
  depth: number,
  start: number
): void => {
  const key = field.oneof?.name ?? field.name
  let before: unknown
  if (field.type.kind === "message") {
    const current = ownValue(target, key)
    before = field.oneof === undefined ? current : current?._tag === field.name ? current.value : undefined
  }
  const value = readValue(context, r, field.type, field.number, before, depth)
  // Classify the occurrence before changing the active oneof case.
  if (field.type.kind === "enum" && !acceptsEnum(field.type.enum, value as number)) {
    retainOccurrence(context, target, start, r.offset)
    return
  }
  assign(target, key, field.oneof === undefined ? value : { _tag: field.name, value })
}

const readList = (
  context: DecodeContext,
  r: Reader,
  field: D.ListFieldDescriptor,
  target: Message,
  depth: number,
  start: number
): void => {
  // Creation installs an own container for every repeated field, including
  // names such as __proto__ and constructor.
  const list = target[field.name] as Array<unknown>
  try {
    const value = readValue(context, r, field.type, field.number, undefined, depth)
    if (field.type.kind === "enum" && !acceptsEnum(field.type.enum, value as number)) {
      retainOccurrence(context, target, start, r.offset)
    } else list.push(value)
  } catch (error) {
    rethrow(error, list.length)
  }
}

// Prepared fields and packed payloads share these scalar operations. Packed
// arrays select an operation once, outside the element loop.
type PackedScalar = Exclude<D.ScalarType, "string" | "bytes">
const numericReaders: Record<PackedScalar, (r: Reader) => unknown> = {
  double: (r) => r.double(),
  float: (r) => r.float(),
  int32: (r) => r.int32(),
  uint32: (r) => r.uint32(),
  sint32: (r) => r.sint32(),
  fixed32: (r) => r.fixed32(),
  sfixed32: (r) => r.sfixed32(),
  bool: (r) => r.bool(),
  int64: (r) => r.int64(),
  uint64: (r) => r.uint64(),
  sint64: (r) => r.sint64(),
  fixed64: (r) => r.fixed64(),
  sfixed64: (r) => r.sfixed64()
}
const numberReaders: Partial<Record<D.ScalarType, (r: Reader) => number>> = {
  int64: (r) => r.int64Number(),
  uint64: (r) => r.uint64Number(),
  sint64: (r) => r.sint64Number(),
  fixed64: (r) => r.fixed64Number(),
  sfixed64: (r) => r.sfixed64Number()
}
const stringReaders: Partial<Record<D.ScalarType, (r: Reader) => string>> = {
  int64: (r) => String(r.int64()),
  uint64: (r) => String(r.uint64()),
  sint64: (r) => String(r.sint64()),
  fixed64: (r) => String(r.fixed64()),
  sfixed64: (r) => String(r.sfixed64())
}

const readString = (r: Reader): string => r.string()
const readStringLax = (r: Reader): string => r.string(LAX_UTF8)
const readBytes = (r: Reader): Uint8Array => r.bytesView()
const scalarReader = (type: D.ScalarValueType, jsType = type.jsType): (r: Reader) => unknown => {
  if (type.scalar === "string") return type.validateUtf8 ? readString : readStringLax
  if (type.scalar === "bytes") return readBytes
  const base = numericReaders[type.scalar]
  return jsType === "number" ?
    numberReaders[type.scalar] ?? base
    : jsType === "string"
    ? stringReaders[type.scalar] ?? base
    : base
}

type PackedReader = (context: DecodeContext, r: Reader, target: Message, list: Array<unknown>) => void

// Separate loops let scalar and floating-point arrays keep their own element
// types in the hot path. The operation is selected during descriptor preparation.
const preparePackedRead = (type: D.ScalarValueType | D.EnumValueType, number: number): PackedReader => {
  if (type.kind === "enum") {
    return (context, r, target, list) => {
      const child = r.delimited()
      let unknown: Writer | undefined
      try {
        while (!child.isDone()) {
          const value = child.int32()
          if (acceptsEnum(type.enum, value)) list.push(value)
          else if (context.keepUnknown) {
            unknown ??= ProtobufWriter.make()
            unknown.tag(number, WireType.Varint).int32(value)
          }
        }
      } catch (error) {
        rethrow(error, list.length)
      }
      if (unknown !== undefined) retain(context, target, unknown.finish())
    }
  }
  if (type.scalar === "double" || type.scalar === "float") {
    const size = type.scalar === "double" ? 8 : 4
    return (_context, r, _target, list) => {
      const bytes = r.bytesView()
      if (bytes.length % size !== 0) {
        const complete = bytes.length - bytes.length % size
        throw new Failure(`Expected a complete value at offset ${r.offset - bytes.length + complete}`, [
          list.length + complete / size
        ])
      }
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length)
      if (size === 8) {
        for (let i = 0; i < bytes.length; i += 8) list.push(view.getFloat64(i, true))
      } else {
        for (let i = 0; i < bytes.length; i += 4) list.push(view.getFloat32(i, true))
      }
    }
  }
  const read = scalarReader(type)
  return (_context, r, _target, list) => {
    const child = r.delimited()
    try {
      while (!child.isDone()) list.push(read(child))
    } catch (error) {
      rethrow(error, list.length)
    }
  }
}

const mapKeyDefault = (type: D.ScalarValueType): string =>
  type.scalar === "string" ? "" : type.scalar === "bool" ? "false" : "0"

const readMap = (
  context: DecodeContext,
  r: Reader,
  field: D.MapFieldDescriptor,
  target: Message,
  depth: number,
  start: number
): void => {
  const child = r.delimited()
  let key = mapKeyDefault(field.key)
  let value: unknown
  // Stage the entire entry before replacing any existing value at its key.
  while (!child.isDone()) {
    const tag = child.tag()
    if (tag >>> 3 === 1 && (tag & 7) === wireTypeOf(field.key)) {
      key = String(readScalar(child, field.key, "bigint"))
    } else if (tag >>> 3 === 2 && (tag & 7) === wireTypeOf(field.type)) {
      try {
        value = readValue(context, child, field.type, 2, value, depth)
      } catch (error) {
        rethrow(error, key)
      }
    } else child.skip(tag, context.maxDepth - depth)
  }
  if (field.type.kind === "enum" && value !== undefined && !acceptsEnum(field.type.enum, value as number)) {
    retainOccurrence(context, target, start, r.offset)
    return
  }
  if (value === undefined) {
    if (field.type.kind === "message") {
      try {
        checkDepth(depth + 1, context.maxDepth)
      } catch (error) {
        rethrow(error, key)
      }
    }
    value = field.type.kind === "message"
      ? createMessage(context, layoutOf(field.type.message))
      : valueDefault(field.type)
  }
  const record = target[field.name] as Message
  assign(record, key, value)
}

// Complete only surviving values. Explicit absence stays absent, and required
// fields never receive a default that could conceal their absence on the wire.
const finishMessage = (context: DecodeContext, descriptor: D.MessageDescriptor, target: Message): void => {
  const layout = layoutOf(descriptor)
  for (const field of layout.finish) {
    const key = field.oneof?.name ?? field.name
    const stored = ownValue(target, key)
    if (field.oneof !== undefined && stored?._tag !== field.name) continue
    const value = field.oneof === undefined ? stored : stored.value
    try {
      if (value === undefined) {
        if (field.kind === "singular" && field.presence === "required") {
          fail(`Expected required field ${field.name} of ${descriptor.typeName}`)
        }
        continue
      }
      // Scalars are already validated and immutable. Only messages and byte
      // arrays need finishing, regardless of the field's cardinality.
      if (field.type.kind !== "message" && !(field.type.kind === "scalar" && field.type.scalar === "bytes")) continue
      switch (field.kind) {
        case "singular": {
          const finished = finishValue(context, field.type, value)
          if (field.oneof === undefined) assign(target, key, finished)
          else stored.value = finished
          break
        }
        case "list":
          for (let i = 0; i < value.length; i++) {
            try {
              value[i] = finishValue(context, field.type, value[i])
            } catch (error) {
              rethrow(error, i)
            }
          }
          break
        case "map":
          for (const entry of Object.keys(value)) {
            try {
              assign(value, entry, finishValue(context, field.type, value[entry]))
            } catch (error) {
              rethrow(error, entry)
            }
          }
          break
      }
    } catch (error) {
      rethrow(error, key)
    }
  }
  const unknown = context.unknown?.get(target)
  if (unknown !== undefined) {
    target[unknownFields] = Bytes.concat(unknown)
    context.unknown!.delete(target)
  }
}

const finishValue = (context: DecodeContext, type: D.ValueType, value: any): unknown => {
  if (type.kind === "message") finishMessage(context, type.message, value)
  else if (type.kind === "scalar" && type.scalar === "bytes") return new Uint8Array(value)
  return value
}

// -----------------------------------------------------------------------------
// encoding
// -----------------------------------------------------------------------------

interface EncodeContext {
  readonly maxDepth: number
  readonly writeUnknown: boolean
}

/** @internal */
export const encode = (
  descriptor: D.MessageDescriptor,
  message: unknown,
  options: EncodeOptions | undefined
): Result.Result<Uint8Array<ArrayBuffer>, Failure> => {
  try {
    const w = ProtobufWriter.make()
    writeFields(
      { maxDepth: depthLimit(options?.maxDepth), writeUnknown: options?.writeUnknownFields !== false },
      w,
      descriptor,
      message,
      0
    )
    return Result.succeed(w.finish())
  } catch (error) {
    return Result.fail(toFailure(error))
  }
}

const writeFields = (
  context: EncodeContext,
  w: Writer,
  descriptor: D.MessageDescriptor,
  message: unknown,
  depth: number,
  layout = layoutOf(descriptor)
): void => {
  checkDepth(depth, context.maxDepth)
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    expected(`an object for ${descriptor.typeName}`, message)
  }
  const target = message as Message
  for (const [oneof, cases] of layout.oneofs) {
    const value = ownValue(target, oneof.name)
    if (value !== undefined && (typeof value !== "object" || value === null || !cases.has(ownValue(value, "_tag")))) {
      rethrow(new Failure(`Expected a case of oneof ${oneof.name}, got ${show(value?._tag ?? value)}`), oneof.name)
    }
  }
  for (const field of layout.ordered) {
    try {
      field.write(context, w, target, depth)
    } catch (error) {
      rethrow(error, field.key)
    }
  }
  if (context.writeUnknown) {
    const unknown = target[unknownFields]
    if (unknown !== undefined) {
      if (!(unknown instanceof Uint8Array)) expected("a Uint8Array of unknown fields", unknown)
      w.raw(unknown)
    }
  }
}

const prepareWrite = (field: D.FieldDescriptor): WriteField["write"] => {
  if (field.kind === "singular" && field.oneof === undefined && field.type.kind === "scalar") {
    const key = field.name
    const type = field.type
    const tag = field.number * 8 + wireTypeOf(type)
    const write = scalarWriters[type.scalar]
    const implicit = field.presence === "implicit"
    const required = field.presence === "required"
    return (_context, w, target) => {
      const value = ownValue(target, key)
      if (value === undefined) {
        if (required) fail(`Expected a value for required field ${key}`)
      } else if (!implicit || !isZero(type, value)) {
        w.uint32(tag)
        write(w, value)
      }
    }
  }
  const write = prepareValueWrite(field.type, field.kind === "map" ? 2 : field.number)
  return (context, w, target, depth) => writeField(context, w, field, target, depth, write)
}

const writeField = (
  context: EncodeContext,
  w: Writer,
  field: D.FieldDescriptor,
  target: Message,
  depth: number,
  write: ValueWriter
): void => {
  const stored = ownValue(target, field.oneof?.name ?? field.name)
  if (field.oneof !== undefined && stored?._tag !== field.name) return
  const value = field.oneof === undefined ? stored : ownValue(stored, "value")
  if (field.oneof === undefined && value === undefined) {
    if (field.kind === "singular" && field.presence === "required") {
      fail(`Expected a value for required field ${field.name}`)
    }
    return
  }
  switch (field.kind) {
    case "singular":
      if (field.presence !== "implicit" || !isZero(field.type, value)) {
        write(context, w, value, depth)
      }
      break
    case "list": {
      if (!Array.isArray(value)) expected("an array", value)
      if (value.length === 0) return
      if (field.packed && packable(field.type)) {
        writePacked(w, field.type, field.number, value)
      } else {
        for (let i = 0; i < value.length; i++) {
          try {
            write(context, w, value[i], depth)
          } catch (error) {
            rethrow(error, i)
          }
        }
      }
      break
    }
    case "map":
      if (typeof value !== "object" || value === null || Array.isArray(value)) expected("a record", value)
      for (const key of Object.keys(value)) {
        try {
          w.tag(field.number, WireType.Len).fork()
          writeMapKey(w, field.key, key)
          write(context, w, value[key], depth)
          w.join()
        } catch (error) {
          rethrow(error, key)
        }
      }
      break
  }
}

type ValueWriter = (context: EncodeContext, w: Writer, value: unknown, depth: number) => void

const prepareValueWrite = (type: D.ValueType, number: number): ValueWriter => {
  const tag = number * 8 + wireTypeOf(type)
  switch (type.kind) {
    case "scalar": {
      const write = scalarWriters[type.scalar]
      return (_context, w, value) => {
        w.uint32(tag)
        write(w, value)
      }
    }
    case "enum":
      return (_context, w, value) => {
        w.uint32(tag)
        writeEnum(w, type, value)
      }
    case "message": {
      const message = type.message
      let layout: Layout | undefined
      if (type.delimited) {
        const endTag = number * 8 + WireType.EndGroup
        return (context, w, value, depth) => {
          w.uint32(tag)
          writeFields(context, w, message, value, depth + 1, layout ??= layoutOf(message))
          w.uint32(endTag)
        }
      }
      return (context, w, value, depth) => {
        w.uint32(tag).fork()
        writeFields(context, w, message, value, depth + 1, layout ??= layoutOf(message))
        w.join()
      }
    }
  }
}

const scalarWriters: Record<D.ScalarType, (w: Writer, value: unknown) => unknown> = {
  string: (w, v) => w.string(typeof v === "string" ? v : expected("a string", v)),
  bytes: (w, v) => w.bytes(v instanceof Uint8Array ? v : expected("a Uint8Array", v)),
  double: (w, v) => w.double(typeof v === "number" ? v : expected("a number for a double", v)),
  float: (w, v) => w.float(float(v)),
  int32: (w, v) => w.int32(int32("int32", v)),
  uint32: (w, v) => w.uint32(uint32("uint32", v)),
  sint32: (w, v) => w.sint32(int32("sint32", v)),
  fixed32: (w, v) => w.fixed32(uint32("fixed32", v)),
  sfixed32: (w, v) => w.sfixed32(int32("sfixed32", v)),
  bool: (w, v) => w.bool(typeof v === "boolean" ? v : expected("a boolean", v)),
  int64: (w, v) => w.int64(toInt64("int64", v)),
  uint64: (w, v) => w.uint64(toInt64("uint64", v)),
  sint64: (w, v) => w.sint64(toInt64("sint64", v)),
  fixed64: (w, v) => w.fixed64(toInt64("fixed64", v)),
  sfixed64: (w, v) => w.sfixed64(toInt64("sfixed64", v))
}

const writePacked = (
  w: Writer,
  type: D.ScalarValueType | D.EnumValueType,
  number: number,
  list: ReadonlyArray<unknown>
): void => {
  w.tag(number, WireType.Len)
  const wire = wireTypeOf(type)
  const size = wire === WireType.I64 ? 8 : wire === WireType.I32 ? 4 : 0
  if (size === 0) {
    w.fork()
    writePackedValues(w, type, list)
    w.join()
    return
  }
  const length = list.length * size
  if (length > UINT32_MAX) fail("Expected a packed field length of at most 4294967295 bytes")
  w.uint32(length)
  if (type.kind !== "scalar" || (type.scalar !== "double" && type.scalar !== "float")) {
    writePackedValues(w, type, list)
    return
  }
  const view = new DataView(new ArrayBuffer(length))
  let index = 0
  try {
    if (size === 8) {
      for (; index < list.length; index++) {
        const value = list[index]
        view.setFloat64(index * 8, typeof value === "number" ? value : expected("a number for a double", value), true)
      }
    } else {
      for (; index < list.length; index++) view.setFloat32(index * 4, float(list[index]), true)
    }
  } catch (error) {
    rethrow(error, index)
  }
  w.raw(new Uint8Array(view.buffer))
}

const writePackedValues = (
  w: Writer,
  type: D.ScalarValueType | D.EnumValueType,
  list: ReadonlyArray<unknown>
): void => {
  let index = 0
  try {
    if (type.kind === "enum") {
      for (; index < list.length; index++) writeEnum(w, type, list[index])
    } else {
      const write = scalarWriters[type.scalar]
      for (; index < list.length; index++) write(w, list[index])
    }
  } catch (error) {
    rethrow(error, index)
  }
}

const writeMapKey = (w: Writer, type: D.ScalarValueType, key: string): void => {
  w.tag(1, wireTypeOf(type) as ProtobufWriter.WireType)
  switch (type.scalar) {
    case "string":
      writeScalar(w, type.scalar, key)
      break
    case "bool":
      writeScalar(w, type.scalar, key === "true" ? true : key === "false" ? false : expected("a boolean key", key))
      break
    default:
      if (!/^-?[0-9]+$/.test(key)) expected(`an integer key for ${a(type.scalar)}`, key)
      writeScalar(w, type.scalar, is64Bit(type.scalar) ? key : Number(key))
      break
  }
}

// -----------------------------------------------------------------------------
// extensions
// -----------------------------------------------------------------------------

// A MessageSet item: `repeated group Item = 1 { required int32 type_id = 2;
// required bytes message = 3; }`.
const ITEM_START = 1 * 8 + WireType.StartGroup
const ITEM_END = 1 * 8 + WireType.EndGroup

// Splits unknown fields into occurrences of an extension and the rest.
// MessageSet occurrences are bare message payloads; ordinary extensions
// include their field tags so they can decode into a holder.
const splitExtension = (
  message: any,
  extension: D.ExtensionDescriptor
): { readonly own: ReadonlyArray<Uint8Array>; readonly rest: ReadonlyArray<Uint8Array> } => {
  const bytes = message[unknownFields]
  const own: Array<Uint8Array> = []
  const rest: Array<Uint8Array> = []
  if (bytes === undefined) return { own, rest }
  if (!(bytes instanceof Uint8Array)) return expected("a Uint8Array of unknown fields", bytes)
  const number = extension.field.number
  const messageSet = extension.extendee.messageSetWireFormat
  const r = ProtobufReader.make(bytes)
  while (!r.isDone()) {
    const start = r.offset
    const tag = r.tag()
    if (messageSet && tag === ITEM_START) {
      const payload = readItem(r, number)
      if (payload === undefined) rest.push(bytes.subarray(start, r.offset))
      else own.push(payload)
      continue
    }
    // MessageSet also accepts ordinary length-delimited extension fields.
    // Keep both forms as bare payloads: its ID may exceed the range of tags.
    if (messageSet && tag >>> 3 === number && (tag & 7) === WireType.Len) {
      own.push(r.bytesView())
      continue
    }
    r.skip(tag)
    // A field with an incompatible wire type remains unknown when setting
    // or clearing the extension, just as it does during message decoding.
    const type = extension.field.type
    const actual = tag & 7
    const packed = extension.field.kind === "list" && actual === WireType.Len && packable(type)
    const matches = !messageSet && tag >>> 3 === number && (actual === wireTypeOf(type) || packed)
    ;(matches ? own : rest).push(bytes.subarray(start, r.offset))
  }
  return { own, rest }
}

// Reads the rest of a MessageSet item after its start tag, and returns its
// message bytes when its type id is `typeId`. Only the first type id and
// payload are used; incomplete items do not set an extension.
const readItem = (r: ProtobufReader.ProtobufReader, typeId: number): Uint8Array | undefined => {
  let id: number | undefined
  let payload: Uint8Array | undefined
  while (true) {
    const tag = r.tag()
    if (tag === ITEM_END) break
    if (tag === 2 * 8 + WireType.Varint) {
      const value = r.uint32()
      if (value === 0) fail("Expected a nonzero MessageSet type id")
      id ??= value
    } else if (tag === 3 * 8 + WireType.Len) {
      const value = r.bytesView()
      payload ??= value
    } else {
      r.skip(tag)
    }
  }
  return id === typeId ? payload : undefined
}

// A message of one field, an ordinary extension, which its occurrences decode into.
const holders = new WeakMap<D.ExtensionDescriptor, D.MessageDescriptor>()
const holderOf = (extension: D.ExtensionDescriptor): D.MessageDescriptor => {
  let descriptor = holders.get(extension)
  if (descriptor === undefined) {
    descriptor = { ...extension.extendee, fields: [extension.field], oneofs: [] }
    holders.set(extension, descriptor)
  }
  return descriptor
}

const readExtension = (extension: D.ExtensionDescriptor, occurrences: ReadonlyArray<Uint8Array>): Message =>
  decodeMessage(holderOf(extension), Bytes.concat(occurrences))

const messageSetDescriptor = (extension: D.ExtensionDescriptor): D.MessageDescriptor => {
  const field = extension.field
  if (field.kind !== "singular" || field.type.kind !== "message") {
    return fail("Expected a singular message extension of a MessageSet")
  }
  return field.type.message
}

// Called with at least one payload. Each reader is bounded to its occurrence,
// while merge state and retained unknown fields survive until final validation.
const readMessageSet = (extension: D.ExtensionDescriptor, occurrences: ReadonlyArray<Uint8Array>): Message => {
  const descriptor = messageSetDescriptor(extension)
  const context: DecodeContext = {
    input: occurrences[0],
    maxDepth: DEFAULT_MAX_DEPTH,
    keepUnknown: true,
    needsFinish: false,
    unknown: undefined
  }
  const target = createMessage(context, layoutOf(descriptor))
  for (const input of occurrences) {
    context.input = input
    // The payload is nested one level inside the extended message.
    readFields(context, ProtobufReader.make(input), descriptor, target, 1)
  }
  if (context.needsFinish || context.unknown !== undefined) finishMessage(context, descriptor, target)
  return target
}

/** @internal */
export const getExtension = (
  message: unknown,
  extension: D.ExtensionDescriptor
): Result.Result<unknown, Failure> => {
  try {
    const { own } = splitExtension(message, extension)
    const field = extension.field
    if (own.length === 0) return Result.succeed(field.kind === "list" ? [] : undefined)
    if (extension.extendee.messageSetWireFormat) {
      try {
        return Result.succeed(readMessageSet(extension, own))
      } catch (error) {
        rethrow(error, field.name)
      }
    }
    const target = readExtension(extension, own)
    return Result.succeed(ownValue(target, field.name))
  } catch (e) {
    return Result.fail(toFailure(e))
  }
}

/** @internal */
export const setExtension = (
  message: object,
  extension: D.ExtensionDescriptor,
  value: unknown
): Result.Result<Record<PropertyKey, unknown>, Failure> => {
  try {
    const { own, rest } = splitExtension(message, extension)
    const chunks = [...rest]
    // Closed-enum numbers outside the descriptor are unknown data, even
    // when they share the extension's field number or a packed occurrence.
    const type = extension.field.type
    if (own.length > 0 && type.kind === "enum" && !type.enum.open) {
      const unknown = readExtension(extension, own)[unknownFields]
      if (unknown !== undefined) chunks.push(unknown)
    }
    if (value !== undefined) {
      const w = ProtobufWriter.make()
      const context = { maxDepth: DEFAULT_MAX_DEPTH, writeUnknown: true }
      if (extension.extendee.messageSetWireFormat) {
        w.tag(1, WireType.StartGroup)
          .tag(2, WireType.Varint).uint32(extension.field.number)
          .tag(3, WireType.Len).fork()
        try {
          writeFields(context, w, messageSetDescriptor(extension), value, 1)
        } catch (error) {
          rethrow(error, extension.field.name)
        }
        w.join().tag(1, WireType.EndGroup)
      } else {
        writeFields(context, w, holderOf(extension), { [extension.field.name]: value }, 0)
      }
      chunks.push(w.finish())
    }
    const out: Record<PropertyKey, unknown> = { ...message }
    if (chunks.length === 0) delete out[unknownFields]
    else out[unknownFields] = Bytes.concat(chunks)
    return Result.succeed(out)
  } catch (e) {
    return Result.fail(toFailure(e))
  }
}
