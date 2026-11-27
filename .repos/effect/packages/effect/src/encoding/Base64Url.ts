/**
 * URL-safe Base64 encoding and decoding helpers.
 *
 * @stability stable
 * @since 4.0.0
 */
import * as base64 from "../internal/base64.ts"
import * as Result from "../Result.ts"
import { EncodingError } from "./EncodingError.ts"

/**
 * Encodes the given value into an unpadded URL-safe Base64 string.
 *
 * **When to use**
 *
 * Use to encode text or bytes in contexts that require the URL-safe alphabet.
 *
 * **Details**
 *
 * String inputs are encoded as UTF-8 bytes before Base64Url encoding.
 * Each unpaired UTF-16 surrogate is replaced with U+FFFD (�).
 * `Uint8Array` inputs are encoded directly. The output removes `=` padding
 * and replaces `+` with `-` and `/` with `_`.
 *
 * **Example** (Encoding URL-safe Base64)
 *
 * ```ts import.meta.vitest
 * import { Base64Url } from "effect/encoding"
 *
 * Base64Url.encode("hello?") // => "aGVsbG8_"
 *
 * const bytes = new Uint8Array([72, 101, 108, 108, 111, 63])
 * Base64Url.encode(bytes) // => "SGVsbG8_"
 * ```
 *
 * @see {@link encodePadded} for output that keeps `=` padding
 * @see {@link decode} for decoding URL-safe Base64 to bytes
 * @see {@link decodeString} for decoding URL-safe Base64 to UTF-8 text
 *
 * @stability stable
 * @category encoding
 * @since 4.0.0
 */
export const encode: (input: Uint8Array | string) => string = (input) => encodeBytes(toBytes(input), false)

/**
 * Encodes the given value into a padded URL-safe Base64 string.
 *
 * **When to use**
 *
 * Use when a consumer requires `=` padding on URL-safe Base64, such as Go's
 * `base64.URLEncoding`.
 *
 * **Details**
 *
 * Same as {@link encode}, but keeps the `=` padding. {@link decode} accepts
 * both forms.
 *
 * **Example** (Encoding padded URL-safe Base64)
 *
 * ```ts import.meta.vitest
 * import { Base64Url } from "effect/encoding"
 *
 * Base64Url.encodePadded("fo") // => "Zm8="
 * ```
 *
 * @see {@link encode} for unpadded output
 *
 * @stability stable
 * @category encoding
 * @since 4.0.6
 */
export const encodePadded: (input: Uint8Array | string) => string = (input) => encodeBytes(toBytes(input), true)

/**
 * Decodes a padded or unpadded URL-safe Base64 string into bytes safely.
 *
 * **When to use**
 *
 * Use to decode Base64Url text into bytes without throwing on invalid input.
 *
 * **Details**
 *
 * Returns `Result.succeed` with a `Uint8Array` when decoding succeeds, or
 * `Result.fail` with an `EncodingError` when the input is not valid
 * Base64Url. Both padded and unpadded forms are accepted when otherwise valid.
 *
 * **Example** (Decoding URL-safe Base64 bytes)
 *
 * ```ts import.meta.vitest
 * import { Result } from "effect"
 * import { Base64Url } from "effect/encoding"
 *
 * Base64Url.decode("SGVsbG8_") // => Result.succeed(new Uint8Array([72, 101, 108, 108, 111, 63]))
 * ```
 *
 * @stability stable
 * @category decoding
 * @since 4.0.0
 */
export const decode = (str: string): Result.Result<Uint8Array, EncodingError> => {
  const stripped = base64.stripCrlf(str)
  const length = stripped.length
  const padded = stripped.endsWith("=")
  if (padded ? length % 4 !== 0 : length % 4 === 1) {
    return Result.fail(
      new EncodingError({
        module: "Base64Url",
        kind: "Decode",
        input: stripped,
        message: padded
          ? `Padded length should be a multiple of 4, but is ${length}`
          : `Unpadded length should not be 1 more than a multiple of 4, but is ${length}`
      })
    )
  }
  const end = !padded ? length : stripped.charCodeAt(length - 2) === 61 ? length - 2 : length - 1
  // Not `(end * 3) >> 2`: engines that allow strings over 2^31 / 3 characters would overflow int32.
  const decodedLength = Math.floor(end * 3 / 4)
  const native = base64.decodeNative(stripped, decodedLength, nativeDecodeOptions)
  if (native) return Result.succeed(native)
  // Validating up front keeps failures as cheap as the scan, without allocating the output.
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
  const fullEnd = end & ~3
  const result = new Uint8Array(decodedLength)
  let j = 0
  for (let i = 0; i < fullEnd; i += 4) {
    const a = codes[stripped.charCodeAt(i)]
    const b = codes[stripped.charCodeAt(i + 1)]
    const c = codes[stripped.charCodeAt(i + 2)]
    const d = codes[stripped.charCodeAt(i + 3)]
    result[j++] = (a << 2) | (b >> 4)
    result[j++] = (b << 4) | (c >> 2)
    result[j++] = (c << 6) | d
  }
  // Non-zero trailing bits in the final character are ignored.
  if (end > fullEnd) {
    const a = codes[stripped.charCodeAt(fullEnd)]
    const b = codes[stripped.charCodeAt(fullEnd + 1)]
    result[j++] = (a << 2) | (b >> 4)
    if (end - fullEnd === 3) result[j] = (b << 4) | (codes[stripped.charCodeAt(fullEnd + 2)] >> 2)
  }
  return Result.succeed(result)
}

const encoder = new TextEncoder()
const toBytes = (input: Uint8Array | string): Uint8Array => typeof input === "string" ? encoder.encode(input) : input

interface NativeEncodeOptions {
  readonly alphabet: "base64url"
  readonly omitPadding: boolean
}

const unpaddedOptions: NativeEncodeOptions = { alphabet: "base64url", omitPadding: true }
const paddedOptions: NativeEncodeOptions = { alphabet: "base64url", omitPadding: false }

// Mirrors `Base64.encode` with the URL-safe alphabet. The tables stay
// module-level constants: passing them in as parameters made the loops about
// 10% slower on V8.
const encodeBytes = (bytes: Uint8Array, pad: boolean): string => {
  const length = bytes.length
  // Looked up on the prototype at call time, so own or subclass overrides are ignored.
  const toBase64 = (Uint8Array.prototype as {
    readonly toBase64?: (this: Uint8Array, options: NativeEncodeOptions) => string
  }).toBase64
  // The size guard also keeps detached buffers (length 0) away from native `toBase64`, which throws on them.
  if (length >= 32 && typeof toBase64 === "function") return toBase64.call(bytes, pad ? paddedOptions : unpaddedOptions)
  // Below ~128 bytes, appending to a string beats filling a byte array and decoding it once.
  return length < 128 ? encodeShort(bytes, pad) : encodeLong(bytes, pad)
}

const encodeShort = (bytes: Uint8Array, pad: boolean): string => {
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
    if (pad) result += "=="
  }
  if (i === length) {
    result += alphabet[bytes[i - 2] >> 2]
    result += alphabet[((bytes[i - 2] & 0x03) << 4) | (bytes[i - 1] >> 4)]
    result += alphabet[(bytes[i - 1] & 0x0f) << 2]
    if (pad) result += "="
  }
  return result
}

const encodeLong = (bytes: Uint8Array, pad: boolean): string => {
  const length = bytes.length
  const rest = length % 3
  const result = new Uint8Array((length - rest) / 3 * 4 + (rest === 0 ? 0 : pad ? 4 : rest + 1))
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
    if (pad) {
      result[j + 2] = paddingCode
      result[j + 3] = paddingCode
    }
  }
  if (i === length) {
    result[j] = alphabetCodes[bytes[i - 2] >> 2]
    result[j + 1] = alphabetCodes[((bytes[i - 2] & 0x03) << 4) | (bytes[i - 1] >> 4)]
    result[j + 2] = alphabetCodes[(bytes[i - 1] & 0x0f) << 2]
    if (pad) result[j + 3] = paddingCode
  }
  return decoder.decode(result)
}

const nativeDecodeOptions: base64.NativeDecodeOptions = { alphabet: "base64url" }
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
const alphabetCodes = encoder.encode(alphabet)
const paddingCode = "=".charCodeAt(0)
const codes = new Uint8Array(128)
for (let i = 0; i < alphabet.length; i++) codes[alphabet.charCodeAt(i)] = i

/**
 * Decodes a padded or unpadded URL-safe Base64 string into UTF-8 text safely.
 *
 * **When to use**
 *
 * Use to decode Base64Url text into UTF-8 text without throwing on invalid
 * input.
 *
 * **Details**
 *
 * Returns `Result.succeed` with the decoded text when decoding succeeds, or
 * `Result.fail` with an `EncodingError` when the input is not valid
 * Base64Url.
 *
 * **Example** (Decoding URL-safe Base64 strings)
 *
 * ```ts import.meta.vitest
 * import { Result } from "effect"
 * import { Base64Url } from "effect/encoding"
 *
 * Base64Url.decodeString("aGVsbG8_") // => Result.succeed("hello?")
 * ```
 *
 * @stability stable
 * @category decoding
 * @since 4.0.0
 */
export const decodeString = (str: string) => Result.map(decode(str), (_) => decoder.decode(_))

const decoder = new TextDecoder("utf-8", { ignoreBOM: true })
