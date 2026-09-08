/**
 * Binary codecs for PostgreSQL values, keyed by type OID.
 *
 * Version 1 implements the binary wire format (`format = 1`) only; passing
 * `format = 0` to `decode` is an error. Layouts follow rust-postgres'
 * `postgres-types`, including the infinity sentinels, and assume the server
 * was built with `integer_datetimes` (the only supported configuration since
 * PostgreSQL 10).
 *
 * There is no `typeof` inference: an OID is always supplied, either directly
 * or through a constructor such as `int4` that carries it.
 *
 * `timestamp` has no time zone on the wire and is treated as UTC in both
 * directions. Decoding drops sub-millisecond precision by truncating toward
 * zero, including for timestamps before the PostgreSQL epoch.
 *
 * @since 4.0.0
 */
import * as Data from "effect/Data"
import * as Result from "effect/Result"
import type * as PgProtocol from "./PgProtocol.ts"
import type { ValueSink } from "./PgProtocol.ts"

/**
 * Failure returned when a value cannot be encoded or decoded for its OID.
 *
 * @category errors
 * @since 4.0.0
 */
export class CodecError extends Data.TaggedError("PgTypesCodecError")<{
  readonly message: string
}> {}

const fail = (message: string): never => {
  throw new CodecError({ message })
}

const result = <A>(evaluate: () => A): Result.Result<A, CodecError> => {
  try {
    return Result.succeed(evaluate())
  } catch (error) {
    if (error instanceof CodecError) return Result.fail(error)
    throw error
  }
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder("utf-8", { fatal: true })

const writeInt16 = (bytes: Uint8Array, offset: number, value: number): void => {
  bytes[offset] = value >>> 8
  bytes[offset + 1] = value
}

const readInt16 = (bytes: Uint8Array, offset: number): number => ((bytes[offset] << 8) | bytes[offset + 1]) << 16 >> 16

const readUint16 = (bytes: Uint8Array, offset: number): number => (bytes[offset] << 8) | bytes[offset + 1]

const writeInt32 = (bytes: Uint8Array, offset: number, value: number): void => {
  bytes[offset] = value >>> 24
  bytes[offset + 1] = value >>> 16
  bytes[offset + 2] = value >>> 8
  bytes[offset + 3] = value
}

const readInt32 = (bytes: Uint8Array, offset: number): number =>
  (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]

/** Writes an int64, given a value the caller has checked fits a double exactly. */
const writeInt64 = (bytes: Uint8Array, offset: number, value: number): void => {
  const high = Math.floor(value / 4294967296)
  writeInt32(bytes, offset, high)
  writeInt32(bytes, offset + 4, value - high * 4294967296)
}

const readUint32 = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0

/**
 * Constructing a `DataView` costs more than the reads and writes it performs,
 * so the fixed-width codecs stage values through these instead of wrapping
 * every freshly allocated array.
 */
const scratch4 = new ArrayBuffer(4)
const scratchView4 = new DataView(scratch4)
const scratchBytes4 = new Uint8Array(scratch4)
const scratch8 = new ArrayBuffer(8)
const scratchView8 = new DataView(scratch8)
const scratchBytes8 = new Uint8Array(scratch8)

/**
 * Stages eight wire bytes into `scratchView8`. Two big-endian `setInt32` calls
 * beat both `Uint8Array.prototype.set` and eight stores, and unlike `set` they
 * read from anywhere in `bytes` without a view of their own.
 */
const stage8 = (bytes: Uint8Array, offset: number): void => {
  scratchView8.setInt32(0, readInt32(bytes, offset))
  scratchView8.setInt32(4, readInt32(bytes, offset + 4))
}

/** Decimal text for every two-digit number, so formatting never calls `padStart`. */
const twoDigits = /* @__PURE__ */ Array.from({ length: 100 }, (_, value) => (value < 10 ? "0" : "") + value)

/**
 * Above this length `TextEncoder.encodeInto` beats a per-character loop, below
 * it the call overhead dominates. Measured on V8: the loop runs at about a
 * nanosecond per character and `encodeInto` costs about 50 ns whatever the
 * length, so the crossover is around 50 characters.
 */
const asciiEncodeLimit = 48

/**
 * `encodeInto` needs somewhere to write. Encoding through this and copying out
 * still beats `TextEncoder.encode`, which allocates inside the call. Strings
 * that would need a larger one are rare enough to encode the slow way rather
 * than keep that much memory alive.
 */
let scratchUtf8 = new Uint8Array(4096)

const scratchUtf8Limit = 64 * 1024

/** Encodes into `scratchUtf8`, returning how many bytes it holds, or -1. */
const encodeUtf8Scratch = (text: string): number => {
  const capacity = text.length * 3
  if (capacity > scratchUtf8Limit) return -1
  if (capacity > scratchUtf8.length) scratchUtf8 = new Uint8Array(capacity)
  return textEncoder.encodeInto(text, scratchUtf8).written
}

const encodeUtf8 = (text: string): Uint8Array => {
  const length = text.length
  if (length <= asciiEncodeLimit) {
    const bytes = new Uint8Array(length)
    let i = 0
    for (; i < length; i++) {
      const code = text.charCodeAt(i)
      if (code > 0x7f) break
      bytes[i] = code
    }
    if (i === length) return bytes
  }
  const written = encodeUtf8Scratch(text)
  return written === -1 ? textEncoder.encode(text) : scratchUtf8.slice(0, written)
}

/** As `encodeUtf8`, but leaves `prefix` bytes free at the front. */
const encodeUtf8Prefixed = (text: string, prefix: number): Uint8Array => {
  const length = text.length
  if (length <= asciiEncodeLimit) {
    const bytes = new Uint8Array(prefix + length)
    let i = 0
    for (; i < length; i++) {
      const code = text.charCodeAt(i)
      if (code > 0x7f) break
      bytes[prefix + i] = code
    }
    if (i === length) return bytes
  }
  const written = encodeUtf8Scratch(text)
  if (written === -1) {
    const body = textEncoder.encode(text)
    const bytes = new Uint8Array(prefix + body.length)
    bytes.set(body, prefix)
    return bytes
  }
  const bytes = new Uint8Array(prefix + written)
  bytes.set(scratchUtf8.subarray(0, written), prefix)
  return bytes
}

/**
 * A view of `size` bytes at `offset`, or `bytes` itself when that is already
 * the whole of it. Only the codecs that hand their bytes to something else
 * need one; the rest read through `bytes` and `offset` directly.
 */
const region = (bytes: Uint8Array, offset: number, size: number): Uint8Array =>
  offset === 0 && size === bytes.length ? bytes : new Uint8Array(bytes.buffer, bytes.byteOffset + offset, size)

/**
 * Below this length building the string a character at a time beats
 * `TextDecoder.decode`, which costs about 50 ns before it looks at a byte.
 * Above it the per-character cost of about 3 ns takes over.
 */
const asciiDecodeLimit = 10

/**
 * Node's own UTF-8 decoder, which reads straight out of the buffer with no
 * view and about a quarter less overhead than `TextDecoder`. It swaps
 * replacement characters in where `TextDecoder` would fail, so a result that
 * contains one is handed to the strict decoder after all: either the
 * character was really in the text and the same string comes back, or the
 * bytes were invalid and the failure is the one `TextDecoder` always raised.
 */
const utf8Slice: ((this: Uint8Array, start: number, end: number) => string) | undefined = (globalThis as any).Buffer
  ?.prototype?.utf8Slice

const decodeUtf8 = (bytes: Uint8Array, offset: number, size: number): string => {
  if (size <= asciiDecodeLimit) {
    let text = ""
    let index = 0
    for (; index < size; index++) {
      const code = bytes[offset + index]
      if (code > 0x7f) break
      text += String.fromCharCode(code)
    }
    if (index === size) return text
  }
  if (utf8Slice !== undefined) {
    const text = utf8Slice.call(bytes, offset, offset + size)
    if (text.indexOf("\ufffd") === -1) return text
  }
  try {
    return textDecoder.decode(region(bytes, offset, size))
  } catch {
    return fail("Invalid UTF-8 in text value")
  }
}

const requireSize = (size: number, expected: number, name: string): void => {
  if (size !== expected) {
    fail(`Expected ${expected} byte(s) for ${name}, received ${size}`)
  }
}

const requireString = (value: unknown, name: string): string =>
  typeof value === "string" ? value : fail(`Expected a string for ${name}`)

const requireBigInt = (value: unknown, name: string): bigint =>
  typeof value === "bigint" ? value : fail(`Expected a bigint for ${name}`)

const requireNumber = (value: unknown, name: string): number =>
  typeof value === "number" ? value : fail(`Expected a number for ${name}`)

const requireInteger = (value: unknown, name: string, min: number, max: number): number => {
  const num = requireNumber(value, name)
  if (!Number.isInteger(num) || num < min || num > max) {
    fail(`Expected an integer in [${min}, ${max}] for ${name}, received ${num}`)
  }
  return num
}

const ZERO = BigInt(0)
const THOUSAND = BigInt(1000)
const INT64_MIN = BigInt("-9223372036854775808")
const INT64_MAX = BigInt("9223372036854775807")
const INT32_MIN = -2147483648
const INT32_MAX = 2147483647

/** Milliseconds between the Unix epoch and the PostgreSQL epoch (2000-01-01). */
const PG_EPOCH_MS = 946684800000
const PG_EPOCH_MICROS = 946684800000000
/** Days between the Unix epoch and the PostgreSQL epoch. */
const PG_EPOCH_DAYS = 10957

/**
 * Beyond this an integer no longer has an exact `Number`, so the timestamp
 * codecs fall back to `BigInt` rather than round. It is about 285 years of
 * microseconds either side of 2000-01-01.
 */
const MAX_EXACT = 9007199254740992
/** The `high` half of an int64 whose magnitude is below `MAX_EXACT`. */
const MAX_EXACT_HIGH = 0x200000

/** Midnight to midnight, the widest PostgreSQL `time` and `timetz` allow. */
const MAX_TIME_MICROS_NUMBER = 86_400_000_000
/** PostgreSQL accepts time zone displacements strictly inside +/-16 hours. */
const TZDISP_LIMIT_SECONDS = 57_600

// -----------------------------------------------------------------------------
// OIDs
// -----------------------------------------------------------------------------

/**
 * Type OIDs implemented by version 1 of this codec.
 *
 * @category constants
 * @since 4.0.0
 */
export const OID = {
  bool: 16,
  bytea: 17,
  name: 19,
  int8: 20,
  int2: 21,
  int4: 23,
  text: 25,
  oid: 26,
  json: 114,
  cidr: 650,
  float4: 700,
  float8: 701,
  inet: 869,
  bpchar: 1042,
  varchar: 1043,
  date: 1082,
  time: 1083,
  timestamp: 1114,
  timestamptz: 1184,
  timetz: 1266,
  numeric: 1700,
  uuid: 2950,
  jsonb: 3802,
  boolArray: 1000,
  byteaArray: 1001,
  nameArray: 1003,
  int8Array: 1016,
  int2Array: 1005,
  int4Array: 1007,
  textArray: 1009,
  oidArray: 1028,
  jsonArray: 199,
  cidrArray: 651,
  float4Array: 1021,
  float8Array: 1022,
  inetArray: 1041,
  bpcharArray: 1014,
  varcharArray: 1015,
  dateArray: 1182,
  timeArray: 1183,
  timestampArray: 1115,
  timestamptzArray: 1185,
  timetzArray: 1270,
  numericArray: 1231,
  uuidArray: 2951,
  jsonbArray: 3807
} as const

const arrayToElement = new Map<number, number>([
  [OID.boolArray, OID.bool],
  [OID.byteaArray, OID.bytea],
  [OID.nameArray, OID.name],
  [OID.int8Array, OID.int8],
  [OID.int2Array, OID.int2],
  [OID.int4Array, OID.int4],
  [OID.textArray, OID.text],
  [OID.oidArray, OID.oid],
  [OID.jsonArray, OID.json],
  [OID.cidrArray, OID.cidr],
  [OID.float4Array, OID.float4],
  [OID.float8Array, OID.float8],
  [OID.inetArray, OID.inet],
  [OID.bpcharArray, OID.bpchar],
  [OID.varcharArray, OID.varchar],
  [OID.dateArray, OID.date],
  [OID.timeArray, OID.time],
  [OID.timestampArray, OID.timestamp],
  [OID.timestamptzArray, OID.timestamptz],
  [OID.timetzArray, OID.timetz],
  [OID.numericArray, OID.numeric],
  [OID.uuidArray, OID.uuid],
  [OID.jsonbArray, OID.jsonb]
])

const elementToArray = new Map<number, number>(
  Array.from(arrayToElement, ([array, element]) => [element, array])
)

/**
 * Returns the array OID whose elements have the given OID, or `undefined`
 * when there is no array type registered for it.
 *
 * @category getters
 * @since 4.0.0
 */
export const arrayOidFor = (elementOid: number): number | undefined => elementToArray.get(elementOid)

// -----------------------------------------------------------------------------
// calendar helpers
// -----------------------------------------------------------------------------

const pad = (value: number, size: number): string => String(value).padStart(size, "0")

/** Civil date from days since 1970-01-01, after Howard Hinnant's algorithm. */
const civilFromDays = (days: number): { year: number; month: number; day: number } => {
  const z = days + 719468
  const era = Math.floor(z / 146097)
  const doe = z - era * 146097
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365)
  const y = yoe + era * 400
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1
  const month = mp < 10 ? mp + 3 : mp - 9
  return { year: month <= 2 ? y + 1 : y, month, day }
}

/** Days since 1970-01-01 from a civil date. */
const daysFromCivil = (year: number, month: number, day: number): number => {
  const y = month <= 2 ? year - 1 : year
  const era = Math.floor(y / 400)
  const yoe = y - era * 400
  const mp = month > 2 ? month - 3 : month + 9
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146097 + doe - 719468
}

const monthLengths = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

const isLeapYear = (year: number): boolean => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0

/** The two-digit number at `at`, or `-1` when those characters are not digits. */
const twoDigitsAt = (text: string, at: number): number => {
  const tens = text.charCodeAt(at) - 48
  const units = text.charCodeAt(at + 1) - 48
  return tens >= 0 && tens <= 9 && units >= 0 && units <= 9 ? tens * 10 + units : -1
}

/** Parses `[-]YYYY-MM-DD`, with as many year digits as the caller likes. */
const parseDate = (text: string): number => {
  const yearStart = text.charCodeAt(0) === 45 ? 1 : 0
  const yearEnd = text.length - 6
  if (yearEnd - yearStart < 4 || text.charCodeAt(yearEnd) !== 45 || text.charCodeAt(yearEnd + 3) !== 45) {
    return fail(`Expected a YYYY-MM-DD date, received "${text}"`)
  }
  let year = 0
  for (let index = yearStart; index < yearEnd; index++) {
    const digit = text.charCodeAt(index) - 48
    if (digit < 0 || digit > 9) {
      return fail(`Expected a YYYY-MM-DD date, received "${text}"`)
    }
    year = year * 10 + digit
  }
  const month = twoDigitsAt(text, yearEnd + 1)
  const day = twoDigitsAt(text, yearEnd + 4)
  if (month === -1 || day === -1) {
    return fail(`Expected a YYYY-MM-DD date, received "${text}"`)
  }
  if (yearStart === 1) year = -year
  // Enough digits and the year is Infinity, which `daysFromCivil` turns into a
  // NaN the range check below would let through as a zero.
  if (!Number.isFinite(year)) {
    return fail(`date out of range: "${text}"`)
  }
  const monthLength = month === 2 && isLeapYear(year) ? 29 : monthLengths[month]
  if (month < 1 || month > 12 || day < 1 || day > monthLength) {
    return fail(`Invalid date "${text}"`)
  }
  return daysFromCivil(year, month, day)
}

const formatDate = (days: number): string => {
  const { day, month, year } = civilFromDays(days)
  const yearText = year < 0
    ? `-${pad(-year, 4)}`
    : year < 10000
    ? twoDigits[(year / 100) | 0] + twoDigits[year % 100]
    : String(year)
  return `${yearText}-${twoDigits[month]}-${twoDigits[day]}`
}

const timeRegex = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?$/

/** Microseconds since midnight. A day of them is well inside `Number`'s exact range. */
const parseTimeOfDay = (text: string): number => {
  const match = timeRegex.exec(text)
  if (match === null) {
    return fail(`Expected a HH:MM[:SS[.ffffff]] time, received "${text}"`)
  }
  const hours = Number(match[1])
  const minutes = Number(match[2])
  const seconds = match[3] === undefined ? 0 : Number(match[3])
  const fraction = match[4] === undefined ? 0 : Number(match[4].padEnd(6, "0"))
  const micros = (hours * 3600 + minutes * 60 + seconds) * 1_000_000 + fraction
  if (hours > 24 || minutes > 59 || seconds > 60 || micros > MAX_TIME_MICROS_NUMBER) {
    return fail(`Invalid time "${text}"`)
  }
  return micros
}

const formatTimeOfDay = (micros: number): string => {
  const seconds = (micros / 1_000_000) | 0
  const fraction = micros - seconds * 1_000_000
  const base = `${twoDigits[(seconds / 3600) | 0]}:${twoDigits[((seconds / 60) | 0) % 60]}:${twoDigits[seconds % 60]}`
  if (fraction === 0) return base
  return `${base}.${pad(fraction, 6).replace(/0+$/, "")}`
}

const zoneRegex = /^(?:Z|([+-])(\d{2})(?::?(\d{2}))?(?::?(\d{2}))?)$/

/** Parses a trailing time zone into seconds east of UTC. */
const parseZone = (text: string): number => {
  const match = zoneRegex.exec(text)
  if (match === null) {
    return fail(`Expected a time zone offset, received "${text}"`)
  }
  if (match[1] === undefined) return 0
  const minutes = match[3] === undefined ? 0 : Number(match[3])
  const trailingSeconds = match[4] === undefined ? 0 : Number(match[4])
  const seconds = Number(match[2]) * 3600 + minutes * 60 + trailingSeconds
  if (minutes > 59 || trailingSeconds > 59 || seconds >= TZDISP_LIMIT_SECONDS) {
    return fail(`Time zone offset out of range, received "${text}"`)
  }
  return match[1] === "-" ? -seconds : seconds
}

const formatZone = (secondsEast: number): string => {
  const sign = secondsEast < 0 ? "-" : "+"
  const total = Math.abs(secondsEast)
  return `${sign}${pad((total / 3600) | 0, 2)}:${twoDigits[((total / 60) | 0) % 60]}`
}

// -----------------------------------------------------------------------------
// numeric
// -----------------------------------------------------------------------------

const NUMERIC_POS = 0x0000
const NUMERIC_NEG = 0x4000
const NUMERIC_NAN = 0xc000
const NUMERIC_PINF = 0xd000
const NUMERIC_NINF = 0xf000

const numericRegex = /^([+-])?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/

const encodeNumeric = (value: unknown): Uint8Array => {
  const text = requireString(value, "numeric")
  if (text === "NaN") return numericSpecial(NUMERIC_NAN)
  if (text === "Infinity") return numericSpecial(NUMERIC_PINF)
  if (text === "-Infinity") return numericSpecial(NUMERIC_NINF)

  const match = numericRegex.exec(text)
  if (match === null || (match[2] ?? "") + (match[3] ?? "") === "") {
    return fail(`Expected a decimal numeric string, received "${text}"`)
  }
  const exponent = match[4] === undefined ? 0 : Number(match[4])
  let digits = (match[2] ?? "") + (match[3] ?? "")
  let scale = (match[3] ?? "").length - exponent
  if (scale < 0) {
    digits += "0".repeat(-scale)
    scale = 0
  }
  if (scale > 0x3fff) {
    return fail(`numeric scale ${scale} exceeds the PostgreSQL maximum`)
  }

  const rightPad = (4 - (scale % 4)) % 4
  digits += "0".repeat(rightPad)
  const fractionLength = scale + rightPad
  const leftPad = (4 - ((digits.length - fractionLength) % 4)) % 4
  digits = "0".repeat(leftPad) + digits

  // Groups are read out of `digits` on demand rather than collected, so
  // trimming the leading and trailing zero groups is two moving indices
  // instead of an array and a `shift` per leading zero.
  const groupAt = (index: number): number => {
    const at = index * 4
    return (digits.charCodeAt(at) - 48) * 1000 + (digits.charCodeAt(at + 1) - 48) * 100 +
      (digits.charCodeAt(at + 2) - 48) * 10 + (digits.charCodeAt(at + 3) - 48)
  }
  const groupCount = digits.length / 4
  let first = 0
  while (first < groupCount && groupAt(first) === 0) first++
  let last = groupCount
  while (last > first && groupAt(last - 1) === 0) last--
  const count = last - first
  const weight = count === 0 ? 0 : (digits.length - fractionLength) / 4 - 1 - first

  const sign = count > 0 && match[1] === "-" ? NUMERIC_NEG : NUMERIC_POS
  const bytes = new Uint8Array(8 + count * 2)
  writeInt16(bytes, 0, count)
  writeInt16(bytes, 2, weight)
  writeInt16(bytes, 4, sign)
  writeInt16(bytes, 6, scale)
  for (let i = 0; i < count; i++) {
    writeInt16(bytes, 8 + i * 2, groupAt(first + i))
  }
  return bytes
}

const numericSpecial = (sign: number): Uint8Array => {
  const bytes = new Uint8Array(8)
  writeInt16(bytes, 4, sign)
  return bytes
}

const decodeNumeric = (bytes: Uint8Array, offset: number, size: number): string => {
  if (size < 8) return fail("Truncated numeric value")
  const count = readInt16(bytes, offset)
  const weight = readInt16(bytes, offset + 2)
  const sign = readUint16(bytes, offset + 4)
  const scale = readInt16(bytes, offset + 6)
  if (sign === NUMERIC_NAN) return "NaN"
  if (sign === NUMERIC_PINF) return "Infinity"
  if (sign === NUMERIC_NINF) return "-Infinity"
  if (sign !== NUMERIC_POS && sign !== NUMERIC_NEG) {
    return fail(`Invalid numeric sign: ${sign}`)
  }
  requireSize(size, 8 + count * 2, "numeric")

  const digits = offset + 8
  // Groups outside 0-9999 have no four-digit text, and reading past the ones
  // the value carries is how the fractional part is padded out.
  const digitAt = (index: number): number => {
    if (index < 0 || index >= count) return 0
    const digit = readInt16(bytes, digits + index * 2)
    return digit >= 0 && digit <= 9999 ? digit : fail(`Invalid numeric digit: ${digit}`)
  }

  let result = sign === NUMERIC_NEG ? "-" : ""
  if (weight < 0) {
    result += "0"
  } else {
    for (let i = 0; i <= weight; i++) {
      const digit = digitAt(i)
      if (i === 0) {
        result += String(digit)
      } else {
        result += twoDigits[(digit / 100) | 0]
        result += twoDigits[digit % 100]
      }
    }
  }
  if (scale > 0) {
    let fraction = ""
    for (let i = weight + 1; fraction.length < scale; i++) {
      const digit = digitAt(i)
      fraction += twoDigits[(digit / 100) | 0]
      fraction += twoDigits[digit % 100]
    }
    result += `.${fraction.slice(0, scale)}`
  }
  return result
}

// -----------------------------------------------------------------------------
// network addresses
// -----------------------------------------------------------------------------

const PGSQL_AF_INET = 2
const PGSQL_AF_INET6 = 3

const parseIPv4 = (text: string): Uint8Array | undefined => {
  const parts = text.split(".")
  if (parts.length !== 4) return undefined
  const bytes = new Uint8Array(4)
  for (let i = 0; i < 4; i++) {
    if (!/^\d{1,3}$/.test(parts[i])) return undefined
    const value = Number(parts[i])
    if (value > 255) return undefined
    bytes[i] = value
  }
  return bytes
}

const parseIPv6 = (text: string): Uint8Array | undefined => {
  const halves = text.split("::")
  if (halves.length > 2) return undefined
  const toGroups = (part: string): Array<string> => part === "" ? [] : part.split(":")
  const head = toGroups(halves[0])
  const tail = halves.length === 2 ? toGroups(halves[1]) : []
  const bytes = new Uint8Array(16)

  const trailing = tail.length > 0 ? tail[tail.length - 1] : head.length > 0 ? head[head.length - 1] : ""
  const embedded = trailing.includes(".") ? parseIPv4(trailing) : undefined
  if (trailing.includes(".") && embedded === undefined) return undefined
  if (embedded !== undefined) {
    if (tail.length > 0) tail.pop()
    else head.pop()
  }
  const groupCount = embedded === undefined ? 8 : 6
  if (head.length + tail.length > groupCount) return undefined
  if (halves.length === 1 && head.length !== groupCount) return undefined

  const writeGroup = (group: string, offset: number): boolean => {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return false
    const value = Number.parseInt(group, 16)
    bytes[offset] = value >> 8
    bytes[offset + 1] = value & 0xff
    return true
  }
  for (let i = 0; i < head.length; i++) {
    if (!writeGroup(head[i], i * 2)) return undefined
  }
  for (let i = 0; i < tail.length; i++) {
    if (!writeGroup(tail[i], (groupCount - tail.length + i) * 2)) return undefined
  }
  if (embedded !== undefined) bytes.set(embedded, 12)
  return bytes
}

const formatIPv4 = (bytes: Uint8Array, offset: number): string =>
  `${bytes[offset]}.${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}`

const formatIPv6 = (bytes: Uint8Array, offset: number): string => {
  let isV4Mapped = bytes[offset + 10] === 0xff && bytes[offset + 11] === 0xff
  for (let i = 0; isV4Mapped && i < 10; i++) isV4Mapped = bytes[offset + i] === 0
  if (isV4Mapped) return `::ffff:${formatIPv4(bytes, offset + 12)}`

  const groups: Array<number> = []
  for (let i = 0; i < 8; i++) groups.push(readUint16(bytes, offset + i * 2))

  let bestStart = -1
  let bestLength = 0
  let start = -1
  for (let i = 0; i <= 8; i++) {
    if (i < 8 && groups[i] === 0) {
      if (start === -1) start = i
    } else if (start !== -1) {
      if (i - start > bestLength) {
        bestStart = start
        bestLength = i - start
      }
      start = -1
    }
  }
  if (bestLength < 2) {
    return groups.map((group) => group.toString(16)).join(":")
  }
  const head = groups.slice(0, bestStart).map((group) => group.toString(16)).join(":")
  const tail = groups.slice(bestStart + bestLength).map((group) => group.toString(16)).join(":")
  return `${head}::${tail}`
}

const hasHostBits = (bytes: Uint8Array, offset: number, length: number, bits: number): boolean => {
  const wholeBytes = Math.floor(bits / 8)
  const partialBits = bits % 8
  if (partialBits !== 0 && (bytes[offset + wholeBytes] & ((1 << (8 - partialBits)) - 1)) !== 0) {
    return true
  }
  for (let index = wholeBytes + (partialBits === 0 ? 0 : 1); index < length; index++) {
    if (bytes[offset + index] !== 0) return true
  }
  return false
}

const encodeInet = (value: unknown, isCidr: boolean): Uint8Array => {
  const text = requireString(value, isCidr ? "cidr" : "inet")
  const slash = text.lastIndexOf("/")
  const address = slash === -1 ? text : text.slice(0, slash)
  const v4 = parseIPv4(address)
  const bytes = v4 ?? parseIPv6(address)
  if (bytes === undefined) {
    return fail(`Expected an IP address, received "${text}"`)
  }
  const fullBits = bytes.length * 8
  const bits = slash === -1 ? fullBits : Number(text.slice(slash + 1))
  if (!Number.isInteger(bits) || bits < 0 || bits > fullBits) {
    return fail(`Invalid netmask length in "${text}"`)
  }
  if (isCidr && hasHostBits(bytes, 0, bytes.length, bits)) {
    return fail(`CIDR address has host bits set in "${text}"`)
  }
  const result = new Uint8Array(4 + bytes.length)
  result[0] = v4 === undefined ? PGSQL_AF_INET6 : PGSQL_AF_INET
  result[1] = bits
  result[2] = isCidr ? 1 : 0
  result[3] = bytes.length
  result.set(bytes, 4)
  return result
}

const decodeInet = (bytes: Uint8Array, offset: number, size: number): string => {
  if (size < 4) return fail("Truncated inet value")
  const family = bytes[offset]
  const bits = bytes[offset + 1]
  const cidrFlag = bytes[offset + 2]
  if (cidrFlag > 1) return fail(`Invalid inet CIDR flag: ${cidrFlag}`)
  const isCidr = cidrFlag === 1
  const addressSize = bytes[offset + 3]
  const expected = family === PGSQL_AF_INET ? 4 : family === PGSQL_AF_INET6 ? 16 : -1
  if (expected === -1 || addressSize !== expected) {
    return fail(`Invalid inet address family ${family} with ${addressSize} byte(s)`)
  }
  requireSize(size, 4 + addressSize, "inet")
  if (bits > addressSize * 8) return fail(`Invalid inet netmask length: ${bits}`)
  if (isCidr && hasHostBits(bytes, offset + 4, addressSize, bits)) {
    return fail("CIDR address has host bits set")
  }
  const text = family === PGSQL_AF_INET ? formatIPv4(bytes, offset + 4) : formatIPv6(bytes, offset + 4)
  return isCidr || bits !== addressSize * 8 ? `${text}/${bits}` : text
}

// -----------------------------------------------------------------------------
// uuid
// -----------------------------------------------------------------------------

const hexDigits = "0123456789abcdef"

/** Byte value of each hex character code, `-1` for everything else. */
const hexValues = new Int8Array(128).fill(-1)
for (let i = 0; i < 16; i++) {
  hexValues[hexDigits.charCodeAt(i)] = i
  hexValues["0123456789ABCDEF".charCodeAt(i)] = i
}

/** Character codes of each byte value's two hex digits. */
const hexHigh = /* @__PURE__ */ (() => {
  const codes = new Uint8Array(256)
  for (let i = 0; i < 256; i++) codes[i] = hexDigits.charCodeAt(i >> 4)
  return codes
})()
const hexLow = /* @__PURE__ */ (() => {
  const codes = new Uint8Array(256)
  for (let i = 0; i < 256; i++) codes[i] = hexDigits.charCodeAt(i & 0xf)
  return codes
})()

/** Offsets of the 16 uuid bytes within the 36-character hyphenated text. */
const uuidOffsets = [0, 2, 4, 6, 9, 11, 14, 16, 19, 21, 24, 26, 28, 30, 32, 34]

/** The hex digit at `at`, or `-1` when that character is not one. */
const hexAt = (text: string, at: number): number => {
  const code = text.charCodeAt(at)
  return code < 128 ? hexValues[code] : -1
}

/**
 * The hyphen positions do the validating that a regular expression used to:
 * anything else in the 36 characters has to be a hex digit for the pairs to
 * come out, and `hexAt` reports the ones that are not.
 */
/** The four int32 words of the uuid `uuidWords` last parsed. */
const uuidWord = new Int32Array(4)

/**
 * Parses the hyphenated text into `uuidWord`. Both encoding paths read the
 * words from there rather than from a returned array, so neither allocates.
 */
const uuidWords = (value: unknown): void => {
  const text = requireString(value, "uuid")
  if (
    text.length !== 36 || text.charCodeAt(8) !== 45 || text.charCodeAt(13) !== 45 ||
    text.charCodeAt(18) !== 45 || text.charCodeAt(23) !== 45
  ) {
    return fail(`Expected a UUID, received "${text}"`)
  }
  for (let word = 0; word < 4; word++) {
    let bits = 0
    let valid = 0
    for (let i = word * 4; i < word * 4 + 4; i++) {
      const at = uuidOffsets[i]
      const high = hexAt(text, at)
      const low = hexAt(text, at + 1)
      valid |= high | low
      bits = (bits << 8) | (high << 4) | low
    }
    if (valid < 0) {
      return fail(`Expected a UUID, received "${text}"`)
    }
    uuidWord[word] = bits
  }
}

const encodeUuid = (value: unknown): Uint8Array => {
  uuidWords(value)
  const bytes = new Uint8Array(16)
  writeInt32(bytes, 0, uuidWord[0])
  writeInt32(bytes, 4, uuidWord[1])
  writeInt32(bytes, 8, uuidWord[2])
  writeInt32(bytes, 12, uuidWord[3])
  return bytes
}

// Four int32s are the sixteen bytes, so a uuid parameter needs no array of
// its own on the way into a frame.
const writeUuid = (sink: ValueSink, value: unknown): void => {
  uuidWords(value)
  sink.int32(uuidWord[0])
  sink.int32(uuidWord[1])
  sink.int32(uuidWord[2])
  sink.int32(uuidWord[3])
}

// One `String.fromCharCode` call, so the result is a flat string rather than
// a rope of pair concatenations that its first reader has to flatten. 45 is
// the hyphen.
const decodeUuid = (bytes: Uint8Array, offset: number, size: number): string => {
  requireSize(size, 16, "uuid")
  const b0 = bytes[offset]
  const b1 = bytes[offset + 1]
  const b2 = bytes[offset + 2]
  const b3 = bytes[offset + 3]
  const b4 = bytes[offset + 4]
  const b5 = bytes[offset + 5]
  const b6 = bytes[offset + 6]
  const b7 = bytes[offset + 7]
  const b8 = bytes[offset + 8]
  const b9 = bytes[offset + 9]
  const b10 = bytes[offset + 10]
  const b11 = bytes[offset + 11]
  const b12 = bytes[offset + 12]
  const b13 = bytes[offset + 13]
  const b14 = bytes[offset + 14]
  const b15 = bytes[offset + 15]
  return String.fromCharCode(
    hexHigh[b0],
    hexLow[b0],
    hexHigh[b1],
    hexLow[b1],
    hexHigh[b2],
    hexLow[b2],
    hexHigh[b3],
    hexLow[b3],
    45,
    hexHigh[b4],
    hexLow[b4],
    hexHigh[b5],
    hexLow[b5],
    45,
    hexHigh[b6],
    hexLow[b6],
    hexHigh[b7],
    hexLow[b7],
    45,
    hexHigh[b8],
    hexLow[b8],
    hexHigh[b9],
    hexLow[b9],
    45,
    hexHigh[b10],
    hexLow[b10],
    hexHigh[b11],
    hexLow[b11],
    hexHigh[b12],
    hexLow[b12],
    hexHigh[b13],
    hexLow[b13],
    hexHigh[b14],
    hexLow[b14],
    hexHigh[b15],
    hexLow[b15]
  )
}

// -----------------------------------------------------------------------------
// codecs
// -----------------------------------------------------------------------------

/**
 * A binary codec for a single OID.
 *
 * @category models
 * @since 4.0.0
 */
export interface Codec<A> {
  readonly encode: (value: A) => Result.Result<Uint8Array, CodecError>
  readonly decode: (bytes: Uint8Array) => Result.Result<A, CodecError>
  /**
   * Writes the value straight into a `Bind` frame, with no array of its own.
   * Optional: a codec without one falls back to `encode` and a copy.
   */
  readonly write?: (sink: ValueSink, value: A) => Result.Result<void, CodecError>
  /**
   * Reads the value out of the `size` bytes at `offset`, with no view of its
   * own. Optional: a codec without one is handed a view. Array elements are
   * read through this, so it is what keeps decoding an array from allocating
   * a view per element.
   */
  readonly read?: (bytes: Uint8Array, offset: number, size: number) => Result.Result<A, CodecError>
}

interface UnsafeCodec<A> {
  readonly encode: (value: A) => Uint8Array
  readonly decode: (bytes: Uint8Array) => A
  readonly write?: (sink: ValueSink, value: A) => void
  readonly read?: (bytes: Uint8Array, offset: number, size: number) => A
}

/** A codec whose `decode` is its `read` over the whole of its bytes. */
const codecOf = <A>(
  read: (bytes: Uint8Array, offset: number, size: number) => A,
  encode: (value: A) => Uint8Array,
  write?: (sink: ValueSink, value: A) => void
): UnsafeCodec<A> => {
  const decode = (bytes: Uint8Array): A => read(bytes, 0, bytes.length)
  return write === undefined ? { encode, decode, read } : { encode, decode, read, write }
}

/** A fresh copy of the first four staged bytes; `set` costs more than the stores. */
const takeScratch4 = (): Uint8Array => {
  const bytes = new Uint8Array(4)
  bytes[0] = scratchBytes4[0]
  bytes[1] = scratchBytes4[1]
  bytes[2] = scratchBytes4[2]
  bytes[3] = scratchBytes4[3]
  return bytes
}

const takeScratch8 = (): Uint8Array => {
  const bytes = new Uint8Array(8)
  bytes[0] = scratchBytes8[0]
  bytes[1] = scratchBytes8[1]
  bytes[2] = scratchBytes8[2]
  bytes[3] = scratchBytes8[3]
  bytes[4] = scratchBytes8[4]
  bytes[5] = scratchBytes8[5]
  bytes[6] = scratchBytes8[6]
  bytes[7] = scratchBytes8[7]
  return bytes
}

const utf8Codec: UnsafeCodec<any> = codecOf(
  decodeUtf8,
  (value) => encodeUtf8(requireString(value, "text")),
  (sink, value) => sink.utf8(requireString(value, "text"))
)

const int8Value = (value: unknown): bigint => {
  const big = requireBigInt(value, "int8")
  if (big < INT64_MIN || big > INT64_MAX) fail(`int8 out of range: ${big}`)
  return big
}

const MAX_TIME_MICROS = BigInt(MAX_TIME_MICROS_NUMBER)

const timeValue = (value: unknown): bigint => {
  const micros = requireBigInt(value, "time")
  if (micros < ZERO || micros > MAX_TIME_MICROS) fail(`time out of range: ${micros}`)
  return micros
}

/**
 * Microseconds since midnight, which always fit a `Number` exactly. Formatting
 * one assumes that, so a value the type cannot hold is an error rather than a
 * nonsense time.
 */
const readTimeMicros = (bytes: Uint8Array, offset: number): number => {
  const high = readInt32(bytes, offset)
  const micros = high * 4294967296 + readUint32(bytes, offset + 4)
  if (high < 0 || micros > MAX_TIME_MICROS_NUMBER) {
    return fail(`timetz out of range: ${micros}`)
  }
  return micros
}

/** The two halves of the int64 `timestampInt64` last produced. */
let timestampHigh = 0
let timestampLow = 0

/**
 * Converts epoch milliseconds to the halves of the wire int64. Both encoding
 * paths read them from here rather than from a returned pair, so neither
 * allocates.
 */
const timestampInt64 = (value: unknown): void => {
  const ms = requireNumber(value, "timestamp")
  if (Number.isNaN(ms)) {
    fail("timestamp cannot be NaN")
  } else if (ms === Number.POSITIVE_INFINITY) {
    timestampHigh = INT32_MAX
    timestampLow = -1
  } else if (ms === Number.NEGATIVE_INFINITY) {
    timestampHigh = INT32_MIN
    timestampLow = 0
  } else {
    const unixMicros = Math.trunc(ms * 1000)
    if (!Number.isFinite(unixMicros)) {
      fail(`timestamp out of range: ${ms}`)
    }
    const micros = unixMicros - PG_EPOCH_MICROS
    if (micros > -MAX_EXACT && micros < MAX_EXACT) {
      timestampHigh = Math.floor(micros / 4294967296)
      timestampLow = micros - timestampHigh * 4294967296
    } else {
      const exact = BigInt(unixMicros) - BigInt(PG_EPOCH_MICROS)
      if (exact < INT64_MIN || exact > INT64_MAX) {
        fail(`timestamp out of range: ${ms}`)
      }
      scratchView8.setBigInt64(0, exact)
      timestampHigh = scratchView8.getInt32(0)
      timestampLow = scratchView8.getInt32(4)
    }
  }
}

const timestampCodec: UnsafeCodec<any> = codecOf(
  (bytes, offset, size) => {
    requireSize(size, 8, "timestamp")
    const high = readInt32(bytes, offset)
    if (high >= -MAX_EXACT_HIGH && high < MAX_EXACT_HIGH) {
      // Inside these bounds the whole conversion is float arithmetic, so it
      // allocates no BigInt. Everything outside them, the sentinels included,
      // needs the exact 64-bit value.
      const micros = high * 4294967296 + readUint32(bytes, offset + 4)
      return (micros - micros % 1000) / 1000 + PG_EPOCH_MS
    }
    stage8(bytes, offset)
    const micros = scratchView8.getBigInt64(0)
    if (micros === INT64_MAX) return Number.POSITIVE_INFINITY
    if (micros === INT64_MIN) return Number.NEGATIVE_INFINITY
    return Number(micros / THOUSAND) + PG_EPOCH_MS
  },
  (value) => {
    timestampInt64(value)
    const bytes = new Uint8Array(8)
    writeInt32(bytes, 0, timestampHigh)
    writeInt32(bytes, 4, timestampLow)
    return bytes
  },
  // Two int32s are the int64, so the sink needs nothing of its own for it.
  (sink, value) => {
    timestampInt64(value)
    sink.int32(timestampHigh)
    sink.int32(timestampLow)
  }
)

/** Days since the PostgreSQL epoch, or an infinity sentinel. */
const dateDays = (value: unknown): number => {
  const text = requireString(value, "date")
  if (text === "infinity") return INT32_MAX
  if (text === "-infinity") return INT32_MIN
  const days = parseDate(text) - PG_EPOCH_DAYS
  if (days <= INT32_MIN || days >= INT32_MAX) {
    return fail(`date out of range: "${text}"`)
  }
  return days
}

const dateCodec: UnsafeCodec<any> = codecOf(
  (bytes, offset, size) => {
    requireSize(size, 4, "date")
    const days = readInt32(bytes, offset)
    if (days === INT32_MAX) return "infinity"
    if (days === INT32_MIN) return "-infinity"
    return formatDate(days + PG_EPOCH_DAYS)
  },
  (value) => {
    const bytes = new Uint8Array(4)
    writeInt32(bytes, 0, dateDays(value))
    return bytes
  },
  (sink, value) => sink.int32(dateDays(value))
)

const timetzCodec: UnsafeCodec<any> = codecOf(
  (bytes, offset, size) => {
    requireSize(size, 12, "timetz")
    const zone = readInt32(bytes, offset + 8)
    if (zone <= -TZDISP_LIMIT_SECONDS || zone >= TZDISP_LIMIT_SECONDS) {
      return fail(`timetz time zone displacement out of range: ${zone}`)
    }
    return formatTimeOfDay(readTimeMicros(bytes, offset)) + formatZone(-zone)
  },
  (value) => {
    const text = requireString(value, "timetz")
    const split = Math.max(text.lastIndexOf("+"), text.lastIndexOf("-"), text.lastIndexOf("Z"))
    if (split <= 0) {
      return fail(`Expected a timetz with a zone offset, received "${text}"`)
    }
    const bytes = new Uint8Array(12)
    writeInt64(bytes, 0, parseTimeOfDay(text.slice(0, split)))
    writeInt32(bytes, 8, -parseZone(text.slice(split)))
    return bytes
  }
)

const jsonCodec: UnsafeCodec<any> = codecOf(
  (bytes, offset, size) => JSON.parse(decodeUtf8(bytes, offset, size)),
  (value) => {
    const text = JSON.stringify(value)
    if (text === undefined) return fail("Value cannot be serialised as JSON")
    return encodeUtf8(text)
  },
  (sink, value) => {
    const text = JSON.stringify(value)
    if (text === undefined) return fail("Value cannot be serialised as JSON")
    sink.utf8(text)
  }
)

const jsonbCodec: UnsafeCodec<any> = codecOf(
  (bytes, offset, size) => {
    if (size === 0 || bytes[offset] !== 1) {
      return fail("Unsupported jsonb version byte")
    }
    return JSON.parse(decodeUtf8(bytes, offset + 1, size - 1))
  },
  (value) => {
    const text = JSON.stringify(value)
    if (text === undefined) return fail("Value cannot be serialised as JSON")
    const bytes = encodeUtf8Prefixed(text, 1)
    bytes[0] = 1
    return bytes
  },
  (sink, value) => {
    const text = JSON.stringify(value)
    if (text === undefined) return fail("Value cannot be serialised as JSON")
    sink.uint8(1)
    sink.utf8(text)
  }
)

const builtins = new Map<number, UnsafeCodec<any>>([
  [
    OID.bool,
    codecOf(
      (bytes, offset, size) => {
        requireSize(size, 1, "bool")
        return bytes[offset] !== 0
      },
      (value) => {
        if (typeof value !== "boolean") fail("Expected a boolean for bool")
        const bytes = new Uint8Array(1)
        bytes[0] = value ? 1 : 0
        return bytes
      },
      (sink, value) => {
        if (typeof value !== "boolean") fail("Expected a boolean for bool")
        sink.uint8(value ? 1 : 0)
      }
    )
  ],
  [
    OID.bytea,
    codecOf(
      region,
      (value) => value instanceof Uint8Array ? value.slice() : fail("Expected a Uint8Array for bytea"),
      (sink, value) => value instanceof Uint8Array ? sink.raw(value) : fail("Expected a Uint8Array for bytea")
    )
  ],
  [
    OID.int2,
    codecOf(
      (bytes, offset, size) => {
        requireSize(size, 2, "int2")
        return ((bytes[offset] << 8) | bytes[offset + 1]) << 16 >> 16
      },
      (value) => {
        const num = requireInteger(value, "int2", -32768, 32767)
        const bytes = new Uint8Array(2)
        bytes[0] = num >>> 8
        bytes[1] = num
        return bytes
      },
      (sink, value) => sink.int16(requireInteger(value, "int2", -32768, 32767))
    )
  ],
  [
    OID.int4,
    codecOf(
      (bytes, offset, size) => {
        requireSize(size, 4, "int4")
        return readInt32(bytes, offset)
      },
      (value) => {
        const num = requireInteger(value, "int4", INT32_MIN, INT32_MAX)
        const bytes = new Uint8Array(4)
        bytes[0] = num >>> 24
        bytes[1] = num >>> 16
        bytes[2] = num >>> 8
        bytes[3] = num
        return bytes
      },
      (sink, value) => sink.int32(requireInteger(value, "int4", INT32_MIN, INT32_MAX))
    )
  ],
  [
    OID.oid,
    codecOf(
      (bytes, offset, size) => {
        requireSize(size, 4, "oid")
        return readUint32(bytes, offset)
      },
      (value) => {
        const num = requireInteger(value, "oid", 0, 4294967295)
        const bytes = new Uint8Array(4)
        bytes[0] = num >>> 24
        bytes[1] = num >>> 16
        bytes[2] = num >>> 8
        bytes[3] = num
        return bytes
      },
      (sink, value) => sink.int32(requireInteger(value, "oid", 0, 4294967295))
    )
  ],
  [
    OID.int8,
    codecOf(
      (bytes, offset, size) => {
        requireSize(size, 8, "int8")
        stage8(bytes, offset)
        return scratchView8.getBigInt64(0)
      },
      (value) => {
        scratchView8.setBigInt64(0, int8Value(value))
        return takeScratch8()
      },
      (sink, value) => sink.bigInt64(int8Value(value))
    )
  ],
  [
    OID.float4,
    codecOf(
      (bytes, offset, size) => {
        requireSize(size, 4, "float4")
        scratchView4.setInt32(0, readInt32(bytes, offset))
        return scratchView4.getFloat32(0)
      },
      (value) => {
        scratchView4.setFloat32(0, requireNumber(value, "float4"))
        return takeScratch4()
      },
      (sink, value) => sink.float32(requireNumber(value, "float4"))
    )
  ],
  [
    OID.float8,
    codecOf(
      (bytes, offset, size) => {
        requireSize(size, 8, "float8")
        stage8(bytes, offset)
        return scratchView8.getFloat64(0)
      },
      (value) => {
        scratchView8.setFloat64(0, requireNumber(value, "float8"))
        return takeScratch8()
      },
      (sink, value) => sink.float64(requireNumber(value, "float8"))
    )
  ],
  [
    OID.time,
    codecOf(
      (bytes, offset, size) => {
        requireSize(size, 8, "time")
        stage8(bytes, offset)
        return scratchView8.getBigInt64(0)
      },
      (value) => {
        scratchView8.setBigInt64(0, timeValue(value))
        return takeScratch8()
      },
      (sink, value) => sink.bigInt64(timeValue(value))
    )
  ],
  [OID.numeric, codecOf(decodeNumeric, encodeNumeric)],
  [OID.text, utf8Codec],
  [OID.varchar, utf8Codec],
  [OID.bpchar, utf8Codec],
  [OID.name, utf8Codec],
  [OID.json, jsonCodec],
  [OID.jsonb, jsonbCodec],
  [OID.uuid, codecOf(decodeUuid, encodeUuid, writeUuid)],
  [OID.inet, codecOf(decodeInet, (value) => encodeInet(value, false))],
  [OID.cidr, codecOf(decodeInet, (value) => encodeInet(value, true))],
  [OID.date, dateCodec],
  [OID.timetz, timetzCodec],
  [OID.timestamp, timestampCodec],
  [OID.timestamptz, timestampCodec]
])

for (const [arrayOid, elementOid] of arrayToElement) {
  builtins.set(
    arrayOid,
    codecOf(
      (bytes, offset, size) => decodeArray(bytes, offset, size, elementOid),
      (value) => encodeArray(value, elementOid),
      (sink, value) => writeArray(sink, value, elementOid)
    )
  )
}

/**
 * Built-ins with registered codecs layered over them, so `encode` and `decode`
 * resolve an OID with a single lookup.
 */
const codecs = new Map<number, UnsafeCodec<any>>(builtins)

/**
 * Every built-in OID is below this, and PostgreSQL hands user-defined types
 * OIDs from 16384 up, so a direct table covers the common case and the map
 * covers registered ones.
 */
const tableSize = 4096

const table = new Array<UnsafeCodec<any> | undefined>(tableSize)
for (const [oid, codec] of codecs) table[oid] = codec

const lookup = (oid: number): UnsafeCodec<any> | undefined => oid >= 0 && oid < tableSize ? table[oid] : codecs.get(oid)

/**
 * Registers a binary codec for an OID the built-in catalogue does not cover,
 * or overrides a built-in one. Registered codecs take precedence.
 *
 * @category registry
 * @since 4.0.0
 */
export const register = <A>(oid: number, codec: Codec<A>): void => {
  const unsafe: UnsafeCodec<A> = {
    encode(value) {
      const encoded = codec.encode(value)
      if (Result.isFailure(encoded)) throw encoded.failure
      return encoded.success
    },
    decode(bytes) {
      const decoded = codec.decode(bytes)
      if (Result.isFailure(decoded)) throw decoded.failure
      return decoded.success
    },
    ...(codec.write === undefined ? undefined : {
      write(sink: ValueSink, value: A) {
        const written = codec.write!(sink, value)
        if (Result.isFailure(written)) throw written.failure
      }
    }),
    ...(codec.read === undefined ? undefined : {
      read(bytes: Uint8Array, offset: number, size: number) {
        const decoded = codec.read!(bytes, offset, size)
        if (Result.isFailure(decoded)) throw decoded.failure
        return decoded.success
      }
    })
  }
  codecs.set(oid, unsafe)
  if (oid >= 0 && oid < tableSize) table[oid] = unsafe
}

/**
 * Removes a previously registered codec.
 *
 * @category registry
 * @since 4.0.0
 */
export const unregister = (oid: number): void => {
  const builtin = builtins.get(oid)
  if (builtin === undefined) codecs.delete(oid)
  else codecs.set(oid, builtin)
  if (oid >= 0 && oid < tableSize) table[oid] = builtin
}

// -----------------------------------------------------------------------------
// arrays
// -----------------------------------------------------------------------------

const encodeArray = (value: unknown, elementOid: number): Uint8Array => {
  if (!Array.isArray(value)) {
    return fail("Expected an array")
  }
  const codec = lookup(elementOid)
  if (codec === undefined) return fail(`No codec registered for OID ${elementOid}`)
  const count = value.length
  const elements: Array<Uint8Array | null> = new Array(count)
  let hasNull = false
  let payloadSize = 0
  for (let i = 0; i < count; i++) {
    const element = value[i]
    if (element === null) {
      elements[i] = null
      hasNull = true
      payloadSize += 4
    } else {
      const encoded = codec.encode(element)
      elements[i] = encoded
      payloadSize += 4 + encoded.length
    }
  }
  const dimensions = count === 0 ? 0 : 1
  const bytes = new Uint8Array(12 + dimensions * 8 + payloadSize)
  writeInt32(bytes, 0, dimensions)
  writeInt32(bytes, 4, hasNull ? 1 : 0)
  writeInt32(bytes, 8, elementOid)
  let offset = 12
  if (dimensions === 1) {
    writeInt32(bytes, offset, count)
    writeInt32(bytes, offset + 4, 1)
    offset += 8
  }
  for (let i = 0; i < count; i++) {
    const element = elements[i]
    if (element === null) {
      writeInt32(bytes, offset, -1)
      offset += 4
    } else {
      writeInt32(bytes, offset, element.length)
      bytes.set(element, offset + 4)
      offset += 4 + element.length
    }
  }
  return bytes
}

/**
 * As `encodeArray`, but into a sink: each element is framed with `beginLength`
 * and written in place, so neither the elements nor the array itself needs an
 * array of bytes of its own.
 */
const writeArray = (sink: ValueSink, value: unknown, elementOid: number): void => {
  if (!Array.isArray(value)) {
    return fail("Expected an array")
  }
  const count = value.length
  // The null flag sits ahead of the elements, so it is the one thing that has
  // to be known before any of them are written.
  let hasNull = false
  for (let i = 0; i < count; i++) {
    if (value[i] === null) {
      hasNull = true
      break
    }
  }
  const dimensions = count === 0 ? 0 : 1
  sink.int32(dimensions)
  sink.int32(hasNull ? 1 : 0)
  sink.int32(elementOid)
  if (dimensions === 1) {
    sink.int32(count)
    sink.int32(1)
  }
  // One lookup for the whole array. A codec with no writer of its own is left
  // to `writeValue`, which allocates for the element anyway.
  const write = lookup(elementOid)?.write
  for (let i = 0; i < count; i++) {
    const element = value[i]
    if (element === null) {
      sink.int32(-1)
    } else {
      const token = sink.beginLength()
      if (write === undefined) writeValue(sink, element, elementOid)
      else write(sink, element)
      sink.endLength(token)
    }
  }
}

/**
 * The element codec is resolved once for the whole array, and read in place
 * where it can be, so a thousand elements cost a thousand reads rather than a
 * thousand lookups and a thousand views.
 */
const decodeArray = (
  bytes: Uint8Array,
  start: number,
  size: number,
  elementOid: number
): ReadonlyArray<unknown> => {
  if (size < 12) return fail("Truncated array value")
  const dimensions = readInt32(bytes, start)
  const wireElementOid = readUint32(bytes, start + 8)
  if (wireElementOid !== elementOid) {
    return fail(`Array element OID ${wireElementOid} does not match expected OID ${elementOid}`)
  }
  if (dimensions === 0) {
    if (size !== 12) return fail("Zero-dimensional array has trailing bytes")
    return []
  }
  if (dimensions !== 1) {
    return fail(`Only 1-dimensional arrays are supported, received ${dimensions} dimensions`)
  }
  if (size < 20) return fail("Truncated array value")
  const length = readInt32(bytes, start + 12)
  if (length < 0) return fail(`Invalid array length: ${length}`)
  const lowerBound = readInt32(bytes, start + 16)
  if (lowerBound !== 1) return fail(`Only arrays with a lower bound of 1 are supported, received ${lowerBound}`)
  const codec = lookup(elementOid)
  const read = codec?.read
  const values: Array<unknown> = new Array(length)
  const limit = start + size
  let offset = start + 20
  for (let i = 0; i < length; i++) {
    if (offset + 4 > limit) return fail("Truncated array element")
    const elementSize = readInt32(bytes, offset)
    offset += 4
    if (elementSize < -1) return fail(`Invalid array element length: ${elementSize}`)
    if (elementSize === -1) {
      values[i] = null
    } else {
      if (offset + elementSize > limit) return fail("Truncated array element")
      values[i] = read !== undefined
        ? read(bytes, offset, elementSize)
        : codec === undefined
        ? region(bytes, offset, elementSize)
        : codec.decode(region(bytes, offset, elementSize))
      offset += elementSize
    }
  }
  if (offset !== limit) return fail("Array value has trailing bytes")
  return values
}

// -----------------------------------------------------------------------------
// entry points
// -----------------------------------------------------------------------------

/**
 * A result column, as `RowDescription` describes one.
 *
 * @category models
 * @since 4.0.0
 */
export interface Column {
  readonly dataTypeOid: number
  readonly format: number
}

/**
 * Builds a field reader for `PgProtocol.makeParser`, so a result's rows decode
 * as they are parsed rather than through a view per column.
 *
 * Every column is resolved once here rather than once per row, and a codec that
 * can read in place does; the rest are handed a view. SQL NULL reads as `null`,
 * and a column whose OID has no codec reads as a copy of its bytes.
 *
 * Only the binary format is supported, and a text column returns a
 * `CodecError` failure here rather than once per row. A successful result
 * contains the parser's internal throwing fast path; its failures are terminal
 * for that parser. The standalone `encode` and `decode` APIs remain typed
 * `Result` values.
 *
 * ```ts
 * import { PgProtocol, PgTypes } from "@effect/sql-pg"
 *
 * const parser = PgProtocol.makeParser({ readField: Result.getOrThrow(PgTypes.makeFieldReader([])) })
 * // on each RowDescription
 * declare const description: PgProtocol.RowDescription
 * parser.readField = Result.getOrThrow(PgTypes.makeFieldReader(description.fields))
 * ```
 *
 * @category decoding
 * @since 4.0.0
 */
export const makeFieldReader = (
  columns: ReadonlyArray<Column>
): Result.Result<PgProtocol.FieldReader<unknown>, CodecError> =>
  result(() => {
    const codecs = columns.map((column, index) => {
      if (column.format !== 1) {
        return fail(`Only the binary format is supported, column ${index} has format ${column.format}`)
      }
      return lookup(column.dataTypeOid)
    })
    return (bytes: Uint8Array, offset: number, size: number, column: number): unknown => {
      if (size < 0) return null
      const codec = codecs[column]
      if (codec === undefined) return bytes.slice(offset, offset + size)
      const read = codec.read
      return read === undefined ? codec.decode(bytes.subarray(offset, offset + size)) : read(bytes, offset, size)
    }
  })

/**
 * Encodes a JavaScript value as the binary representation of the given OID.
 *
 * Returns a `CodecError` failure when the value has the wrong JavaScript type,
 * or when the OID is neither built in nor registered.
 *
 * @category encoding
 * @since 4.0.0
 */
export const encode = (value: unknown, oid: number): Result.Result<Uint8Array, CodecError> =>
  result(() => {
    const codec = lookup(oid)
    if (codec === undefined) return fail(`No codec registered for OID ${oid}`)
    return codec.encode(value)
  })

/**
 * Decodes the binary representation of the given OID.
 *
 * `format` must be `1`; the text format is not implemented. An OID that is
 * neither built in nor registered decodes to the raw bytes.
 *
 * @category decoding
 * @since 4.0.0
 */
export const decode = (
  bytes: Uint8Array,
  oid: number,
  format: number
): Result.Result<unknown, CodecError> =>
  result(() => {
    if (format !== 1) {
      return fail(`Only the binary format is supported, received format ${format}`)
    }
    const codec = lookup(oid)
    return codec === undefined ? bytes : codec.decode(bytes)
  })

// -----------------------------------------------------------------------------
// parameter constructors
// -----------------------------------------------------------------------------

/**
 * A value paired with the OID it should be encoded as.
 *
 * @category models
 * @since 4.0.0
 */
export interface Parameter {
  readonly oid: number
  readonly value: unknown
}

/**
 * Encodes a parameter for a `Bind` message. SQL NULL stays `null`.
 *
 * @category encoding
 * @since 4.0.0
 */
export const encodeParameter = (parameter: Parameter): Result.Result<Uint8Array | null, CodecError> =>
  parameter.value === null ? Result.succeed(null) : encode(parameter.value, parameter.oid)

const writeValue = (sink: ValueSink, value: unknown, oid: number): void => {
  const codec = lookup(oid)
  if (codec === undefined) return fail(`No codec registered for OID ${oid}`)
  if (codec.write === undefined) sink.raw(codec.encode(value))
  else codec.write(sink, value)
}

/**
 * Writes a parameter into a `Bind` frame, for `PgProtocol.makeBindEncoder`.
 * Codecs that can write their bytes in place do; the rest fall back to
 * `encode` and a copy.
 *
 * @category encoding
 * @since 4.0.0
 */
const writeParameterUnsafe = (sink: ValueSink, parameter: Parameter): void =>
  parameter.value === null ? sink.sqlNull() : writeValue(sink, parameter.value, parameter.oid)

export const writeParameter = (
  sink: ValueSink,
  parameter: Parameter
): Result.Result<void, CodecError> => {
  try {
    writeParameterUnsafe(sink, parameter)
    return Result.void
  } catch (error) {
    if (error instanceof CodecError) return Result.fail(error)
    throw error
  }
}

const valueWriterUnsafe = Symbol.for("@effect/sql-pg/PgProtocol/ValueWriter/unsafe")
Object.defineProperty(writeParameter, valueWriterUnsafe, { value: writeParameterUnsafe })

const parameter = (oid: number) => (value: unknown): Parameter => ({ oid, value })

/**
 * A `bool` parameter.
 *
 * @category constructors
 * @since 4.0.0
 */
export const bool: (value: boolean | null) => Parameter = parameter(OID.bool)

/**
 * An `int2` parameter.
 *
 * @category constructors
 * @since 4.0.0
 */
export const int2: (value: number | null) => Parameter = parameter(OID.int2)

/**
 * An `int4` parameter.
 *
 * @category constructors
 * @since 4.0.0
 */
export const int4: (value: number | null) => Parameter = parameter(OID.int4)

/**
 * An `int8` parameter.
 *
 * @category constructors
 * @since 4.0.0
 */
export const int8: (value: bigint | null) => Parameter = parameter(OID.int8)

/**
 * An `oid` parameter.
 *
 * @category constructors
 * @since 4.0.0
 */
export const oid: (value: number | null) => Parameter = parameter(OID.oid)

/**
 * A `float4` parameter.
 *
 * @category constructors
 * @since 4.0.0
 */
export const float4: (value: number | null) => Parameter = parameter(OID.float4)

/**
 * A `float8` parameter.
 *
 * @category constructors
 * @since 4.0.0
 */
export const float8: (value: number | null) => Parameter = parameter(OID.float8)

/**
 * A `numeric` parameter, given as a decimal string or `"NaN"`.
 *
 * @category constructors
 * @since 4.0.0
 */
export const numeric: (value: string | null) => Parameter = parameter(OID.numeric)

/**
 * A `text` parameter.
 *
 * @category constructors
 * @since 4.0.0
 */
export const text: (value: string | null) => Parameter = parameter(OID.text)

/**
 * A `varchar` parameter.
 *
 * @category constructors
 * @since 4.0.0
 */
export const varchar: (value: string | null) => Parameter = parameter(OID.varchar)

/**
 * A `bpchar` parameter.
 *
 * @category constructors
 * @since 4.0.0
 */
export const bpchar: (value: string | null) => Parameter = parameter(OID.bpchar)

/**
 * A `name` parameter.
 *
 * @category constructors
 * @since 4.0.0
 */
export const name: (value: string | null) => Parameter = parameter(OID.name)

/**
 * A `bytea` parameter.
 *
 * @category constructors
 * @since 4.0.0
 */
export const bytea: (value: Uint8Array | null) => Parameter = parameter(OID.bytea)

/**
 * A `json` parameter.
 *
 * @category constructors
 * @since 4.0.0
 */
export const json: (value: unknown) => Parameter = parameter(OID.json)

/**
 * A `jsonb` parameter.
 *
 * @category constructors
 * @since 4.0.0
 */
export const jsonb: (value: unknown) => Parameter = parameter(OID.jsonb)

/**
 * A `uuid` parameter.
 *
 * @category constructors
 * @since 4.0.0
 */
export const uuid: (value: string | null) => Parameter = parameter(OID.uuid)

/**
 * An `inet` parameter, such as `"10.0.0.1"` or `"10.0.0.0/8"`.
 *
 * @category constructors
 * @since 4.0.0
 */
export const inet: (value: string | null) => Parameter = parameter(OID.inet)

/**
 * A `cidr` parameter.
 *
 * @category constructors
 * @since 4.0.0
 */
export const cidr: (value: string | null) => Parameter = parameter(OID.cidr)

/**
 * A `date` parameter, given as `YYYY-MM-DD`, `"infinity"`, or `"-infinity"`.
 *
 * @category constructors
 * @since 4.0.0
 */
export const date: (value: string | null) => Parameter = parameter(OID.date)

/**
 * A `time` parameter, given as microseconds since midnight.
 *
 * @category constructors
 * @since 4.0.0
 */
export const time: (value: bigint | null) => Parameter = parameter(OID.time)

/**
 * A `timetz` parameter, such as `"12:34:56+02:00"`.
 *
 * @category constructors
 * @since 4.0.0
 */
export const timetz: (value: string | null) => Parameter = parameter(OID.timetz)

/**
 * A `timestamp` parameter, given as Unix epoch milliseconds and interpreted
 * as UTC.
 *
 * @category constructors
 * @since 4.0.0
 */
export const timestamp: (value: number | null) => Parameter = parameter(OID.timestamp)

/**
 * A `timestamptz` parameter, given as Unix epoch milliseconds.
 *
 * @category constructors
 * @since 4.0.0
 */
export const timestamptz: (value: number | null) => Parameter = parameter(OID.timestamptz)

/**
 * A one-dimensional array parameter whose elements have the given OID.
 *
 * @category constructors
 * @since 4.0.0
 */
export const array = (
  values: ReadonlyArray<unknown> | null,
  elementOid: number
): Result.Result<Parameter, CodecError> =>
  result(() => {
    const arrayOid = elementToArray.get(elementOid)
    if (arrayOid === undefined) {
      return fail(`No array type known for element OID ${elementOid}`)
    }
    return { oid: arrayOid, value: values }
  })
