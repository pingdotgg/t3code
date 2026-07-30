/**
 * Encoding and decoding helpers for Base64, Base64Url, and hexadecimal text.
 * The functions convert between strings, UTF-8 text, and `Uint8Array` bytes.
 * Encode functions return strings directly, while decode functions return
 * `Result.Result` so invalid input is reported as an `EncodingError` instead of
 * being thrown.
 *
 * @since 4.0.0
 */
import * as Data from "./Data.ts"
import { hasProperty } from "./Predicate.ts"
import * as Result from "./Result.ts"

// -------------------------------------------------------------------------------------
// EncodingError
// -------------------------------------------------------------------------------------

/**
 * Type identifier stored on `EncodingError` values and used by
 * `isEncodingError`.
 *
 * **When to use**
 *
 * Use when implementing low-level `EncodingError`-compatible values that need
 * to carry the runtime marker.
 *
 * **Details**
 *
 * This marker is part of the runtime representation of `EncodingError`. Prefer
 * `isEncodingError` when narrowing unknown values.
 *
 * @see {@link isEncodingError} for the public guard that checks this marker
 *
 * @category type IDs
 * @since 4.0.0
 */
export const EncodingErrorTypeId = "~effect/encoding/EncodingError" as const

/**
 * Literal type of the `EncodingErrorTypeId` marker.
 *
 * **When to use**
 *
 * Use to type the marker carried by `EncodingError` values.
 *
 * @category type IDs
 * @since 4.0.0
 */
export type EncodingErrorTypeId = typeof EncodingErrorTypeId

/**
 * Error returned when an encoding or decoding operation cannot process its
 * input.
 *
 * **When to use**
 *
 * Use when you need to handle or inspect failures from encoding or decoding
 * operations.
 *
 * **Details**
 *
 * The error records whether the failure happened during encoding or decoding,
 * which encoding module reported it, the original input, and a human-readable
 * message.
 *
 * @see {@link isEncodingError} for checking whether a value is an EncodingError
 * @category constructors
 * @since 4.0.0
 */
export class EncodingError extends Data.TaggedError("EncodingError")<{
  kind: "Decode" | "Encode"
  module: string
  input: unknown
  message: string
}> {
  /**
   * Marks this value as an encoding or decoding error for runtime guards.
   *
   * **When to use**
   *
   * Use to identify `EncodingError` instances through `isEncodingError`.
   *
   * @since 4.0.0
   */
  readonly [EncodingErrorTypeId]: EncodingErrorTypeId = EncodingErrorTypeId
}

/**
 * Checks whether a value is an `EncodingError`.
 *
 * **When to use**
 *
 * Use to narrow an unknown value before handling it as an `EncodingError` from
 * encoding or decoding code.
 *
 * **Details**
 *
 * Returns `true` when the value carries the `EncodingErrorTypeId` marker and
 * narrows the value to `EncodingError`.
 *
 * @see {@link EncodingError} for the structured error produced by failed
 * encoding and decoding operations
 *
 * @category guards
 * @since 4.0.0
 */
export const isEncodingError = (u: unknown): u is EncodingError => hasProperty(u, EncodingErrorTypeId)

// -------------------------------------------------------------------------------------
// Base64
// -------------------------------------------------------------------------------------

/**
 * Encodes the given value into a base64 (RFC4648) `string`.
 *
 * **When to use**
 *
 * Use to encode text or bytes as a standard padded Base64 string for storage or
 * transport.
 *
 * **Details**
 *
 * String inputs are encoded as UTF-8 bytes before Base64 encoding.
 * `Uint8Array` inputs are encoded directly. The output uses the standard
 * RFC4648 alphabet with `=` padding.
 *
 * **Example** (Encoding Base64 strings and bytes)
 *
 * ```ts
 * import { Encoding } from "effect"
 *
 * // Encode a string
 * console.log(Encoding.encodeBase64("hello")) // "aGVsbG8="
 *
 * // Encode binary data
 * const bytes = new Uint8Array([72, 101, 108, 108, 111])
 * console.log(Encoding.encodeBase64(bytes)) // "SGVsbG8="
 * ```
 *
 * @see {@link decodeBase64} for decoding standard Base64 to bytes
 * @see {@link decodeBase64String} for decoding standard Base64 to UTF-8 text
 * @see {@link encodeBase64Url} for URL-safe unpadded Base64 output
 *
 * @category encoding
 * @since 2.0.0
 */
export const encodeBase64: (input: Uint8Array | string) => string = (input) =>
  typeof input === "string" ? base64EncodeUint8Array(encoder.encode(input)) : base64EncodeUint8Array(input)

/**
 * Decodes a base64 (RFC4648) string into bytes safely.
 *
 * **When to use**
 *
 * Use to decode a standard padded Base64 string into bytes without throwing on
 * invalid input.
 *
 * **Details**
 *
 * Returns `Result.succeed` with a `Uint8Array` when decoding succeeds, or
 * `Result.fail` with an `EncodingError` when the input is not valid base64.
 *
 * **Example** (Decoding Base64 bytes)
 *
 * ```ts
 * import { Encoding, Result } from "effect"
 *
 * const result = Encoding.decodeBase64("SGVsbG8=")
 * if (Result.isSuccess(result)) {
 *   console.log(Array.from(result.success)) // [72, 101, 108, 108, 111]
 * }
 * ```
 *
 * @category decoding
 * @since 2.0.0
 */
export const decodeBase64 = (str: string): Result.Result<Uint8Array, EncodingError> => {
  const stripped = stripCrlf(str)
  const length = stripped.length
  if (length % 4 !== 0) {
    return Result.fail(
      new EncodingError({
        kind: "Decode",
        module: "Base64",
        input: stripped,
        message: `Length must be a multiple of 4, but is ${length}`
      })
    )
  }

  const index = stripped.indexOf("=")
  if (index !== -1 && ((index < length - 2) || (index === length - 2 && stripped[length - 1] !== "="))) {
    return Result.fail(
      new EncodingError({
        kind: "Decode",
        module: "Base64",
        input: stripped,
        message: `Found a '=' character, but it is not at the end`
      })
    )
  }

  try {
    const missingOctets = stripped.endsWith("==") ? 2 : stripped.endsWith("=") ? 1 : 0
    const result = new Uint8Array(3 * (length / 4) - missingOctets)
    for (let i = 0, j = 0; i < length; i += 4, j += 3) {
      const buffer = getBase64Code(stripped.charCodeAt(i)) << 18 |
        getBase64Code(stripped.charCodeAt(i + 1)) << 12 |
        getBase64Code(stripped.charCodeAt(i + 2)) << 6 |
        getBase64Code(stripped.charCodeAt(i + 3))

      result[j] = buffer >> 16
      result[j + 1] = (buffer >> 8) & 0xff
      result[j + 2] = buffer & 0xff
    }

    return Result.succeed(result)
  } catch (e) {
    return Result.fail(
      new EncodingError({
        kind: "Decode",
        module: "Base64",
        input: stripped,
        message: e instanceof Error ? e.message : "Invalid input"
      })
    )
  }
}

/**
 * Decodes a base64 (RFC4648) string into a UTF-8 string safely.
 *
 * **When to use**
 *
 * Use to decode a standard padded Base64 string into UTF-8 text without
 * throwing on invalid input.
 *
 * **Details**
 *
 * Returns `Result.succeed` with the decoded text when decoding succeeds, or
 * `Result.fail` with an `EncodingError` when the input is not valid base64.
 *
 * **Example** (Decoding Base64 strings)
 *
 * ```ts
 * import { Encoding, Result } from "effect"
 *
 * const result = Encoding.decodeBase64String("aGVsbG8=")
 * if (Result.isSuccess(result)) {
 *   console.log(result.success) // "hello"
 * }
 * ```
 *
 * @category decoding
 * @since 2.0.0
 */
export const decodeBase64String = (str: string) => Result.map(decodeBase64(str), (_) => decoder.decode(_))

// -------------------------------------------------------------------------------------
// Base64Url
// -------------------------------------------------------------------------------------

/**
 * Encodes the given value into a base64 (URL) `string`.
 *
 * **When to use**
 *
 * Use to encode text or bytes as an unpadded Base64Url string for contexts that
 * require the URL-safe alphabet.
 *
 * **Details**
 *
 * String inputs are encoded as UTF-8 bytes before Base64Url encoding.
 * `Uint8Array` inputs are encoded directly. The output removes `=` padding and
 * replaces `+` with `-` and `/` with `_`.
 *
 * **Example** (Encoding URL-safe Base64)
 *
 * ```ts
 * import { Encoding } from "effect"
 *
 * // URL-safe base64 encoding (uses - and _ instead of + and /)
 * console.log(Encoding.encodeBase64Url("hello?")) // "aGVsbG8_"
 *
 * const bytes = new Uint8Array([72, 101, 108, 108, 111, 63])
 * console.log(Encoding.encodeBase64Url(bytes)) // "SGVsbG8_"
 * ```
 *
 * @see {@link decodeBase64Url} for decoding URL-safe Base64 to bytes
 * @see {@link decodeBase64UrlString} for decoding URL-safe Base64 to UTF-8 text
 * @see {@link encodeBase64} for standard padded Base64 output
 *
 * @category encoding
 * @since 2.0.0
 */
export const encodeBase64Url: (input: Uint8Array | string) => string = (input) =>
  typeof input === "string" ? base64UrlEncodeUint8Array(encoder.encode(input)) : base64UrlEncodeUint8Array(input)

/**
 * Decodes a URL-safe base64 string into bytes safely.
 *
 * **When to use**
 *
 * Use to decode padded or unpadded Base64Url text into bytes without throwing
 * on invalid input.
 *
 * **Details**
 *
 * Returns `Result.succeed` with a `Uint8Array` when decoding succeeds, or
 * `Result.fail` with an `EncodingError` when the input is not valid URL-safe
 * base64. Both padded and unpadded URL-safe base64 forms are accepted when
 * otherwise valid.
 *
 * **Example** (Decoding URL-safe Base64 bytes)
 *
 * ```ts
 * import { Encoding, Result } from "effect"
 *
 * const result = Encoding.decodeBase64Url("SGVsbG8_")
 * if (Result.isSuccess(result)) {
 *   console.log(Array.from(result.success)) // [72, 101, 108, 108, 111, 63]
 * }
 * ```
 *
 * @category decoding
 * @since 2.0.0
 */
export const decodeBase64Url = (str: string): Result.Result<Uint8Array, EncodingError> => {
  const stripped = stripCrlf(str)
  const length = stripped.length
  if (length % 4 === 1) {
    return Result.fail(
      new EncodingError({
        module: "Base64Url",
        kind: "Decode",
        input: stripped,
        message: `Length should be a multiple of 4, but is ${length}`
      })
    )
  }

  if (!/^[-_A-Z0-9]*?={0,2}$/i.test(stripped)) {
    return Result.fail(
      new EncodingError({
        module: "Base64Url",
        kind: "Decode",
        input: stripped,
        message: "Invalid input"
      })
    )
  }

  // Some variants allow or require omitting the padding '=' signs
  let sanitized = length % 4 === 2 ? `${stripped}==` : length % 4 === 3 ? `${stripped}=` : stripped
  sanitized = sanitized.replace(/-/g, "+").replace(/_/g, "/")

  return decodeBase64(sanitized)
}

/**
 * Decodes a URL-safe base64 string into a UTF-8 string safely.
 *
 * **When to use**
 *
 * Use to decode padded or unpadded Base64Url text into UTF-8 text without
 * throwing on invalid input.
 *
 * **Details**
 *
 * Returns `Result.succeed` with the decoded text when decoding succeeds, or
 * `Result.fail` with an `EncodingError` when the input is not valid URL-safe
 * base64.
 *
 * **Example** (Decoding URL-safe Base64 strings)
 *
 * ```ts
 * import { Encoding, Result } from "effect"
 *
 * const result = Encoding.decodeBase64UrlString("aGVsbG8_")
 * if (Result.isSuccess(result)) {
 *   console.log(result.success) // "hello?"
 * }
 * ```
 *
 * @category decoding
 * @since 2.0.0
 */
export const decodeBase64UrlString = (str: string) => Result.map(decodeBase64Url(str), (_) => decoder.decode(_))

// -------------------------------------------------------------------------------------
// Hex
// -------------------------------------------------------------------------------------

/**
 * Encodes the given value into a hex `string`.
 *
 * **When to use**
 *
 * Use to encode text or bytes as lowercase hexadecimal text.
 *
 * **Example** (Encoding hex strings and bytes)
 *
 * ```ts
 * import { Encoding } from "effect"
 *
 * // Encode a string to hex
 * console.log(Encoding.encodeHex("hello")) // "68656c6c6f"
 *
 * // Encode binary data to hex
 * const bytes = new Uint8Array([72, 101, 108, 108, 111])
 * console.log(Encoding.encodeHex(bytes)) // "48656c6c6f"
 * ```
 *
 * @category encoding
 * @since 2.0.0
 */
export const encodeHex: (input: Uint8Array | string) => string = (input) =>
  typeof input === "string" ? hexEncodeUint8Array(encoder.encode(input)) : hexEncodeUint8Array(input)

/**
 * Decodes a hexadecimal string into bytes safely.
 *
 * **When to use**
 *
 * Use to decode hexadecimal text into bytes without throwing on invalid input.
 *
 * **Details**
 *
 * Returns `Result.succeed` with a `Uint8Array` when decoding succeeds, or
 * `Result.fail` with an `EncodingError` when the input has an odd length or
 * contains invalid hex characters.
 *
 * **Example** (Decoding hex bytes)
 *
 * ```ts
 * import { Encoding, Result } from "effect"
 *
 * const result = Encoding.decodeHex("48656c6c6f")
 * if (Result.isSuccess(result)) {
 *   console.log(Array.from(result.success)) // [72, 101, 108, 108, 111]
 * }
 * ```
 *
 * @category decoding
 * @since 2.0.0
 */
export const decodeHex = (str: string): Result.Result<Uint8Array, EncodingError> => {
  const bytes = new TextEncoder().encode(str)
  if (bytes.length % 2 !== 0) {
    return Result.fail(
      new EncodingError({
        module: "Hex",
        kind: "Decode",
        input: str,
        message: `Length must be a multiple of 2, but is ${bytes.length}`
      })
    )
  }

  try {
    const length = bytes.length / 2
    const result = new Uint8Array(length)
    for (let i = 0; i < length; i++) {
      const a = fromHexChar(bytes[i * 2])
      const b = fromHexChar(bytes[i * 2 + 1])
      result[i] = (a << 4) | b
    }

    return Result.succeed(result)
  } catch (e) {
    return Result.fail(
      new EncodingError({
        module: "Hex",
        kind: "Decode",
        input: str,
        message: e instanceof Error ? e.message : "Invalid input"
      })
    )
  }
}

/**
 * Decodes a hexadecimal string into a UTF-8 string safely.
 *
 * **When to use**
 *
 * Use to decode hexadecimal text into UTF-8 text without throwing on invalid
 * input.
 *
 * **Details**
 *
 * Returns `Result.succeed` with the decoded text when decoding succeeds, or
 * `Result.fail` with an `EncodingError` when the input is not valid hex.
 *
 * **Example** (Decoding hex strings)
 *
 * ```ts
 * import { Encoding, Result } from "effect"
 *
 * const result = Encoding.decodeHexString("68656c6c6f")
 * if (Result.isSuccess(result)) {
 *   console.log(result.success) // "hello"
 * }
 * ```
 *
 * @category decoding
 * @since 2.0.0
 */
export const decodeHexString = (str: string) => Result.map(decodeHex(str), (_) => decoder.decode(_))

// -------------------------------------------------------------------------------------
// internals
// -------------------------------------------------------------------------------------

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const stripCrlf = (str: string) => str.replace(/[\n\r]/g, "")

// Base64 internals

const base64EncodeUint8Array = (bytes: Uint8Array) => {
  const length = bytes.length

  let result = ""
  let i: number

  for (i = 2; i < length; i += 3) {
    result += base64abc[bytes[i - 2] >> 2]
    result += base64abc[((bytes[i - 2] & 0x03) << 4) | (bytes[i - 1] >> 4)]
    result += base64abc[((bytes[i - 1] & 0x0f) << 2) | (bytes[i] >> 6)]
    result += base64abc[bytes[i] & 0x3f]
  }

  if (i === length + 1) {
    result += base64abc[bytes[i - 2] >> 2]
    result += base64abc[(bytes[i - 2] & 0x03) << 4]
    result += "=="
  }

  if (i === length) {
    result += base64abc[bytes[i - 2] >> 2]
    result += base64abc[((bytes[i - 2] & 0x03) << 4) | (bytes[i - 1] >> 4)]
    result += base64abc[(bytes[i - 1] & 0x0f) << 2]
    result += "="
  }

  return result
}

function getBase64Code(charCode: number) {
  if (charCode >= base64codes.length) {
    throw new TypeError(`Invalid character ${String.fromCharCode(charCode)}`)
  }

  const code = base64codes[charCode]
  if (code === 255) {
    throw new TypeError(`Invalid character ${String.fromCharCode(charCode)}`)
  }

  return code
}

const base64abc = [
  "A",
  "B",
  "C",
  "D",
  "E",
  "F",
  "G",
  "H",
  "I",
  "J",
  "K",
  "L",
  "M",
  "N",
  "O",
  "P",
  "Q",
  "R",
  "S",
  "T",
  "U",
  "V",
  "W",
  "X",
  "Y",
  "Z",
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
  "g",
  "h",
  "i",
  "j",
  "k",
  "l",
  "m",
  "n",
  "o",
  "p",
  "q",
  "r",
  "s",
  "t",
  "u",
  "v",
  "w",
  "x",
  "y",
  "z",
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "+",
  "/"
]

const base64codes = [
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  62,
  255,
  255,
  255,
  63,
  52,
  53,
  54,
  55,
  56,
  57,
  58,
  59,
  60,
  61,
  255,
  255,
  255,
  0,
  255,
  255,
  255,
  0,
  1,
  2,
  3,
  4,
  5,
  6,
  7,
  8,
  9,
  10,
  11,
  12,
  13,
  14,
  15,
  16,
  17,
  18,
  19,
  20,
  21,
  22,
  23,
  24,
  25,
  255,
  255,
  255,
  255,
  255,
  255,
  26,
  27,
  28,
  29,
  30,
  31,
  32,
  33,
  34,
  35,
  36,
  37,
  38,
  39,
  40,
  41,
  42,
  43,
  44,
  45,
  46,
  47,
  48,
  49,
  50,
  51
]

// Base64Url internals

const base64UrlEncodeUint8Array = (data: Uint8Array) =>
  base64EncodeUint8Array(data).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")

// Hex internals

const hexEncodeUint8Array = (bytes: Uint8Array) => {
  let result = ""
  for (let i = 0; i < bytes.length; ++i) {
    result += bytesToHex[bytes[i]]
  }

  return result
}

const fromHexChar = (byte: number) => {
  if (48 <= byte && byte <= 57) {
    return byte - 48
  }

  if (97 <= byte && byte <= 102) {
    return byte - 97 + 10
  }

  if (65 <= byte && byte <= 70) {
    return byte - 65 + 10
  }

  throw new TypeError("Invalid input")
}

const bytesToHex = [
  "00",
  "01",
  "02",
  "03",
  "04",
  "05",
  "06",
  "07",
  "08",
  "09",
  "0a",
  "0b",
  "0c",
  "0d",
  "0e",
  "0f",
  "10",
  "11",
  "12",
  "13",
  "14",
  "15",
  "16",
  "17",
  "18",
  "19",
  "1a",
  "1b",
  "1c",
  "1d",
  "1e",
  "1f",
  "20",
  "21",
  "22",
  "23",
  "24",
  "25",
  "26",
  "27",
  "28",
  "29",
  "2a",
  "2b",
  "2c",
  "2d",
  "2e",
  "2f",
  "30",
  "31",
  "32",
  "33",
  "34",
  "35",
  "36",
  "37",
  "38",
  "39",
  "3a",
  "3b",
  "3c",
  "3d",
  "3e",
  "3f",
  "40",
  "41",
  "42",
  "43",
  "44",
  "45",
  "46",
  "47",
  "48",
  "49",
  "4a",
  "4b",
  "4c",
  "4d",
  "4e",
  "4f",
  "50",
  "51",
  "52",
  "53",
  "54",
  "55",
  "56",
  "57",
  "58",
  "59",
  "5a",
  "5b",
  "5c",
  "5d",
  "5e",
  "5f",
  "60",
  "61",
  "62",
  "63",
  "64",
  "65",
  "66",
  "67",
  "68",
  "69",
  "6a",
  "6b",
  "6c",
  "6d",
  "6e",
  "6f",
  "70",
  "71",
  "72",
  "73",
  "74",
  "75",
  "76",
  "77",
  "78",
  "79",
  "7a",
  "7b",
  "7c",
  "7d",
  "7e",
  "7f",
  "80",
  "81",
  "82",
  "83",
  "84",
  "85",
  "86",
  "87",
  "88",
  "89",
  "8a",
  "8b",
  "8c",
  "8d",
  "8e",
  "8f",
  "90",
  "91",
  "92",
  "93",
  "94",
  "95",
  "96",
  "97",
  "98",
  "99",
  "9a",
  "9b",
  "9c",
  "9d",
  "9e",
  "9f",
  "a0",
  "a1",
  "a2",
  "a3",
  "a4",
  "a5",
  "a6",
  "a7",
  "a8",
  "a9",
  "aa",
  "ab",
  "ac",
  "ad",
  "ae",
  "af",
  "b0",
  "b1",
  "b2",
  "b3",
  "b4",
  "b5",
  "b6",
  "b7",
  "b8",
  "b9",
  "ba",
  "bb",
  "bc",
  "bd",
  "be",
  "bf",
  "c0",
  "c1",
  "c2",
  "c3",
  "c4",
  "c5",
  "c6",
  "c7",
  "c8",
  "c9",
  "ca",
  "cb",
  "cc",
  "cd",
  "ce",
  "cf",
  "d0",
  "d1",
  "d2",
  "d3",
  "d4",
  "d5",
  "d6",
  "d7",
  "d8",
  "d9",
  "da",
  "db",
  "dc",
  "dd",
  "de",
  "df",
  "e0",
  "e1",
  "e2",
  "e3",
  "e4",
  "e5",
  "e6",
  "e7",
  "e8",
  "e9",
  "ea",
  "eb",
  "ec",
  "ed",
  "ee",
  "ef",
  "f0",
  "f1",
  "f2",
  "f3",
  "f4",
  "f5",
  "f6",
  "f7",
  "f8",
  "f9",
  "fa",
  "fb",
  "fc",
  "fd",
  "fe",
  "ff"
]
