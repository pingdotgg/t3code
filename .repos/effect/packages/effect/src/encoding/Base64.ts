/**
 * Base64 encoding and decoding helpers.
 *
 * @stability stable
 * @since 4.0.0
 */
import * as base64 from "../internal/base64.ts"
import * as Result from "../Result.ts"
import * as Base64Url from "./Base64Url.ts"
import { EncodingError } from "./EncodingError.ts"

/**
 * Encodes the given value into a Base64 (RFC 4648) string.
 *
 * **When to use**
 *
 * Use to encode text or bytes as a standard padded Base64 string for storage or
 * transport.
 *
 * **Details**
 *
 * String inputs are encoded as UTF-8 bytes before Base64 encoding.
 * Each unpaired UTF-16 surrogate is replaced with U+FFFD (�).
 * `Uint8Array` inputs are encoded directly. The output uses the standard
 * RFC 4648 alphabet with `=` padding.
 *
 * **Example** (Encoding Base64 strings and bytes)
 *
 * ```ts import.meta.vitest
 * import { Base64 } from "effect/encoding"
 *
 * Base64.encode("hello") // => "aGVsbG8="
 *
 * const bytes = new Uint8Array([72, 101, 108, 108, 111])
 * Base64.encode(bytes) // => "SGVsbG8="
 * ```
 *
 * @see {@link decode} for decoding standard Base64 to bytes
 * @see {@link decodeString} for decoding standard Base64 to UTF-8 text
 *
 * @stability stable
 * @category encoding
 * @since 4.0.0
 */
export const encode: (input: Uint8Array | string) => string = (input) =>
  encodeBytes(typeof input === "string" ? encoder.encode(input) : input)

/**
 * Decodes a Base64 (RFC 4648) string into bytes safely.
 *
 * **When to use**
 *
 * Use to decode a standard padded Base64 string into bytes without throwing on
 * invalid input.
 *
 * **Details**
 *
 * Returns `Result.succeed` with a `Uint8Array` when decoding succeeds, or
 * `Result.fail` with an `EncodingError` when the input is not valid Base64.
 *
 * **Example** (Decoding Base64 bytes)
 *
 * ```ts import.meta.vitest
 * import { Result } from "effect"
 * import { Base64 } from "effect/encoding"
 *
 * Base64.decode("SGVsbG8=") // => Result.succeed(new Uint8Array([72, 101, 108, 108, 111]))
 * ```
 *
 * @stability stable
 * @category decoding
 * @since 4.0.0
 */
export const decode = (str: string): Result.Result<Uint8Array, EncodingError> => {
  const stripped = base64.stripCrlf(str)
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
        message: "Found a '=' character, but it is not at the end"
      })
    )
  }

  const missingOctets = stripped.endsWith("==") ? 2 : stripped.endsWith("=") ? 1 : 0
  const decodedLength = 3 * (length / 4) - missingOctets
  const native = base64.decodeNative(stripped, decodedLength, undefined)
  if (native) return Result.succeed(native)
  if (native === null) {
    // Locating the first invalid character directly is cheaper than rerunning
    // the decoder. On JavaScriptCore the rerun also slows down sharply once the
    // native call has thrown.
    const invalid = invalidCharacter.exec(stripped)
    if (invalid !== null) {
      return Result.fail(
        new EncodingError({
          kind: "Decode",
          module: "Base64",
          input: stripped,
          message: `Invalid character ${invalid[0]}`
        })
      )
    }
  }

  try {
    const result = new Uint8Array(decodedLength)
    for (let i = 0, j = 0; i < length; i += 4, j += 3) {
      const buffer = getCode(stripped.charCodeAt(i)) << 18 |
        getCode(stripped.charCodeAt(i + 1)) << 12 |
        getCode(stripped.charCodeAt(i + 2)) << 6 |
        getCode(stripped.charCodeAt(i + 3))
      result[j] = buffer >> 16
      result[j + 1] = (buffer >> 8) & 0xff
      result[j + 2] = buffer & 0xff
    }
    return Result.succeed(result)
  } catch (cause) {
    return Result.fail(
      new EncodingError({
        kind: "Decode",
        module: "Base64",
        input: stripped,
        message: cause instanceof Error ? cause.message : "Invalid input"
      })
    )
  }
}

/**
 * Decodes a Base64 (RFC 4648) string into UTF-8 text safely.
 *
 * **When to use**
 *
 * Use to decode a standard padded Base64 string into UTF-8 text without
 * throwing on invalid input.
 *
 * **Details**
 *
 * Returns `Result.succeed` with the decoded text when decoding succeeds, or
 * `Result.fail` with an `EncodingError` when the input is not valid Base64.
 *
 * **Example** (Decoding Base64 strings)
 *
 * ```ts import.meta.vitest
 * import { Result } from "effect"
 * import { Base64 } from "effect/encoding"
 *
 * Base64.decodeString("aGVsbG8=") // => Result.succeed("hello")
 * ```
 *
 * @stability stable
 * @category decoding
 * @since 4.0.0
 */
export const decodeString = (str: string) => Result.map(decode(str), (_) => decoder.decode(_))

/**
 * Encodes the given value into a Base64 (RFC 4648) string without `=`
 * padding.
 *
 * **When to use**
 *
 * Use when a format requires standard Base64 without padding, such as the
 * `grpc-status-details-bin` value in the Connect protocol.
 *
 * **Details**
 *
 * Same as {@link encode}, but drops the trailing `=` padding.
 *
 * **Example** (Encoding unpadded Base64)
 *
 * ```ts import.meta.vitest
 * import { Base64 } from "effect/encoding"
 *
 * Base64.encodeUnpadded("hello") // => "aGVsbG8"
 * ```
 *
 * @see {@link encode} for padded output
 * @see {@link decodeLenient} for decoding unpadded Base64
 *
 * @stability stable
 * @category encoding
 * @since 4.1.5
 */
export const encodeUnpadded: (input: Uint8Array | string) => string = (input) => {
  const encoded = encode(input)
  return encoded.endsWith("==") ? encoded.slice(0, -2) : encoded.endsWith("=") ? encoded.slice(0, -1) : encoded
}

/**
 * Decodes Base64 in the standard or the URL-safe alphabet, with or without
 * padding, into bytes safely.
 *
 * **When to use**
 *
 * Use when a format accepts either Base64 alphabet, such as the protobuf JSON
 * mapping for `bytes` fields or the Connect protocol.
 *
 * **Details**
 *
 * Returns `Result.succeed` with a `Uint8Array` when decoding succeeds, or
 * `Result.fail` with an `EncodingError` holding the original input when the
 * input is not valid. Each input must use a single alphabet. CR/LF are
 * ignored, and other whitespace is rejected.
 *
 * **Example** (Decoding either Base64 alphabet)
 *
 * ```ts import.meta.vitest
 * import { Result } from "effect"
 * import { Base64 } from "effect/encoding"
 *
 * Base64.decodeLenient("+/8=") // => Result.succeed(new Uint8Array([251, 255]))
 * Base64.decodeLenient("-_8") // => Result.succeed(new Uint8Array([251, 255]))
 * ```
 *
 * @see {@link decode} for strict standard Base64
 *
 * @stability stable
 * @category decoding
 * @since 4.1.5
 */
export const decodeLenient = (str: string): Result.Result<Uint8Array, EncodingError> =>
  Result.mapError(
    str.includes("-") || str.includes("_") ? Base64Url.decode(str) : decode(addPadding(base64.stripCrlf(str))),
    (error) => new EncodingError({ kind: "Decode", module: "Base64", input: str, message: error.message })
  )

// Lengths that cannot be valid are left for `decode` to reject.
const addPadding = (stripped: string): string => {
  const remainder = stripped.length % 4
  return remainder < 2 || stripped.endsWith("=") ? stripped : stripped + (remainder === 2 ? "==" : "=")
}

const encodeBytes = (bytes: Uint8Array): string => {
  const length = bytes.length
  // Looked up on the prototype at call time, so own or subclass overrides are ignored.
  const toBase64 = (Uint8Array.prototype as { readonly toBase64?: (this: Uint8Array) => string }).toBase64
  // The size guard also keeps detached buffers (length 0) away from native `toBase64`, which throws on them.
  if (length >= 32) {
    if (typeof toBase64 === "function") return toBase64.call(bytes)
    const encoded = base64.encodeBuffer(bytes, "base64")
    if (encoded !== undefined) return encoded
  }
  // Below ~128 bytes, appending to a string beats filling a byte array and decoding it once.
  return length < 128 ? encodeShort(bytes) : encodeLong(bytes)
}

const encodeShort = (bytes: Uint8Array): string => {
  const length = bytes.length
  let result = ""
  let i: number
  for (i = 2; i < length; i += 3) {
    result += alphabet[bytes[i - 2] >> 2]
    result += alphabet[((bytes[i - 2] & 0x03) << 4) | (bytes[i - 1] >> 4)]
    result += alphabet[((bytes[i - 1] & 0x0f) << 2) | (bytes[i] >> 6)]
    result += alphabet[bytes[i] & 0x3f]
  }
  if (i === length + 1) {
    result += alphabet[bytes[i - 2] >> 2]
    result += alphabet[(bytes[i - 2] & 0x03) << 4]
    result += "=="
  }
  if (i === length) {
    result += alphabet[bytes[i - 2] >> 2]
    result += alphabet[((bytes[i - 2] & 0x03) << 4) | (bytes[i - 1] >> 4)]
    result += alphabet[(bytes[i - 1] & 0x0f) << 2]
    result += "="
  }
  return result
}

const encodeLong = (bytes: Uint8Array): string => {
  const length = bytes.length
  const result = new Uint8Array(Math.ceil(length / 3) * 4)
  let i: number
  let j = 0
  for (i = 2; i < length; i += 3, j += 4) {
    result[j] = alphabetCodes[bytes[i - 2] >> 2]
    result[j + 1] = alphabetCodes[((bytes[i - 2] & 0x03) << 4) | (bytes[i - 1] >> 4)]
    result[j + 2] = alphabetCodes[((bytes[i - 1] & 0x0f) << 2) | (bytes[i] >> 6)]
    result[j + 3] = alphabetCodes[bytes[i] & 0x3f]
  }
  if (i === length + 1) {
    result[j] = alphabetCodes[bytes[i - 2] >> 2]
    result[j + 1] = alphabetCodes[(bytes[i - 2] & 0x03) << 4]
    result[j + 2] = paddingCode
    result[j + 3] = paddingCode
  }
  if (i === length) {
    result[j] = alphabetCodes[bytes[i - 2] >> 2]
    result[j + 1] = alphabetCodes[((bytes[i - 2] & 0x03) << 4) | (bytes[i - 1] >> 4)]
    result[j + 2] = alphabetCodes[(bytes[i - 1] & 0x0f) << 2]
    result[j + 3] = paddingCode
  }
  return decoder.decode(result)
}

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { ignoreBOM: true })
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
const alphabetCodes = encoder.encode(alphabet)
const paddingCode = "=".charCodeAt(0)
const invalidCharacter = /[^A-Za-z0-9+/=]/
const codes = new Uint8Array(123).fill(255)
for (let i = 0; i < alphabet.length; i++) codes[alphabet.charCodeAt(i)] = i
codes["=".charCodeAt(0)] = 0

const getCode = (charCode: number): number => {
  if (charCode >= codes.length || codes[charCode] === 255) {
    throw new TypeError(`Invalid character ${String.fromCharCode(charCode)}`)
  }
  return codes[charCode]
}
