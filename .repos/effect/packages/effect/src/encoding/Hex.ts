/**
 * Hexadecimal encoding, decoding, and random value helpers.
 *
 * @stability stable
 * @since 4.0.0
 */
import * as Result from "../Result.ts"
import { EncodingError } from "./EncodingError.ts"

/**
 * Encodes the given value into a hex `string`.
 *
 * **When to use**
 *
 * Use to encode text or bytes as lowercase hexadecimal text.
 *
 * **Details**
 *
 * String inputs are encoded as UTF-8 bytes, replacing each unpaired UTF-16
 * surrogate with U+FFFD (�).
 *
 * **Example** (Encoding hex strings and bytes)
 *
 * ```ts import.meta.vitest
 * import { Hex } from "effect/encoding"
 *
 * // Encode a string to hex
 * Hex.encode("hello") // => "68656c6c6f"
 *
 * // Encode binary data to hex
 * const bytes = new Uint8Array([72, 101, 108, 108, 111])
 * Hex.encode(bytes) // => "48656c6c6f"
 * ```
 *
 * @stability stable
 * @category encoding
 * @since 4.0.0
 */
export const encode: (input: Uint8Array | string) => string = (input) =>
  typeof input === "string" ? hexEncodeUint8Array(encoder.encode(input)) : hexEncodeUint8Array(input)

/**
 * Generates a random lowercase hexadecimal string, optimized for lengths that
 * are multiples of 8.
 *
 * **Details**
 *
 * `length` is not validated. The function generates `length >>> 3` random
 * 8-character words, so non-negative lengths below `2 ** 32` are rounded down
 * to a multiple of 8 and other values follow JavaScript's unsigned 32-bit
 * coercion rules.
 *
 * This function uses `Math.random()` and is not cryptographically secure. For
 * security-sensitive values, draw bytes with the `randomBytes` method of the
 * `SecureRandom` service from `effect/crypto/SecureRandom`, and encode them with
 * {@link encode}.
 *
 * @stability stable
 * @category encoding
 * @since 4.0.0
 */
export const random = (length: number): string => {
  switch (length) {
    case 16:
      return random16()
    case 32:
      return random32()
    default: {
      let result = ""
      for (let i = length >>> 3; i > 0; i--) {
        result += random8()
      }
      return result
    }
  }
}

const hexCharCodes = Uint8Array.from("0123456789abcdef", (c) => c.charCodeAt(0))

const randomWord = (): number => (Math.random() * 0x100000000) >>> 0

// Trace and span identifiers are the common lengths. A single
// String.fromCharCode call produces a flat string, which avoids rope
// flattening when the identifier is later serialized.
const random8 = (): string => {
  const a = randomWord()
  return String.fromCharCode(
    hexCharCodes[a >>> 28],
    hexCharCodes[(a >>> 24) & 15],
    hexCharCodes[(a >>> 20) & 15],
    hexCharCodes[(a >>> 16) & 15],
    hexCharCodes[(a >>> 12) & 15],
    hexCharCodes[(a >>> 8) & 15],
    hexCharCodes[(a >>> 4) & 15],
    hexCharCodes[a & 15]
  )
}

const random16 = (): string => {
  const a = randomWord()
  const b = randomWord()
  return String.fromCharCode(
    hexCharCodes[a >>> 28],
    hexCharCodes[(a >>> 24) & 15],
    hexCharCodes[(a >>> 20) & 15],
    hexCharCodes[(a >>> 16) & 15],
    hexCharCodes[(a >>> 12) & 15],
    hexCharCodes[(a >>> 8) & 15],
    hexCharCodes[(a >>> 4) & 15],
    hexCharCodes[a & 15],
    hexCharCodes[b >>> 28],
    hexCharCodes[(b >>> 24) & 15],
    hexCharCodes[(b >>> 20) & 15],
    hexCharCodes[(b >>> 16) & 15],
    hexCharCodes[(b >>> 12) & 15],
    hexCharCodes[(b >>> 8) & 15],
    hexCharCodes[(b >>> 4) & 15],
    hexCharCodes[b & 15]
  )
}

const random32 = (): string => {
  const a = randomWord()
  const b = randomWord()
  const c = randomWord()
  const d = randomWord()
  return String.fromCharCode(
    hexCharCodes[a >>> 28],
    hexCharCodes[(a >>> 24) & 15],
    hexCharCodes[(a >>> 20) & 15],
    hexCharCodes[(a >>> 16) & 15],
    hexCharCodes[(a >>> 12) & 15],
    hexCharCodes[(a >>> 8) & 15],
    hexCharCodes[(a >>> 4) & 15],
    hexCharCodes[a & 15],
    hexCharCodes[b >>> 28],
    hexCharCodes[(b >>> 24) & 15],
    hexCharCodes[(b >>> 20) & 15],
    hexCharCodes[(b >>> 16) & 15],
    hexCharCodes[(b >>> 12) & 15],
    hexCharCodes[(b >>> 8) & 15],
    hexCharCodes[(b >>> 4) & 15],
    hexCharCodes[b & 15],
    hexCharCodes[c >>> 28],
    hexCharCodes[(c >>> 24) & 15],
    hexCharCodes[(c >>> 20) & 15],
    hexCharCodes[(c >>> 16) & 15],
    hexCharCodes[(c >>> 12) & 15],
    hexCharCodes[(c >>> 8) & 15],
    hexCharCodes[(c >>> 4) & 15],
    hexCharCodes[c & 15],
    hexCharCodes[d >>> 28],
    hexCharCodes[(d >>> 24) & 15],
    hexCharCodes[(d >>> 20) & 15],
    hexCharCodes[(d >>> 16) & 15],
    hexCharCodes[(d >>> 12) & 15],
    hexCharCodes[(d >>> 8) & 15],
    hexCharCodes[(d >>> 4) & 15],
    hexCharCodes[d & 15]
  )
}

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
 * ```ts import.meta.vitest
 * import { Result } from "effect"
 * import { Hex } from "effect/encoding"
 *
 * Hex.decode("48656c6c6f") // => Result.succeed(new Uint8Array([72, 101, 108, 108, 111]))
 * ```
 *
 * @stability stable
 * @category decoding
 * @since 4.0.0
 */
export const decode = (str: string): Result.Result<Uint8Array, EncodingError> => {
  const length = str.length
  // Native `fromHex` accepts exactly the inputs the JS decoder does. On V8 it
  // costs about 1 µs, while the JS path stays well below that until the output
  // outgrows V8's 64-byte on-heap typed arrays.
  const NativeUint8Array = Uint8Array as { readonly fromHex?: (string: string) => Uint8Array }
  if (length > 128 && typeof NativeUint8Array.fromHex === "function") {
    try {
      return Result.succeed(NativeUint8Array.fromHex(str))
    } catch {
      return decodeFailure(str)
    }
  }
  if (length % 2 !== 0) return decodeFailure(str)
  const result = new Uint8Array(length / 2)
  // Invalid characters map to 255.
  if (length <= 1024) {
    for (let i = 0, j = 0; j < length; i++, j += 2) {
      const a = hexCode(str.charCodeAt(j))
      const b = hexCode(str.charCodeAt(j + 1))
      if ((a | b) > 15) return decodeFailure(str)
      result[i] = (a << 4) | b
    }
    return Result.succeed(result)
  }
  // For longer inputs, encoding to UTF-8 once and reading bytes beats
  // `charCodeAt` on V8. Non-ASCII characters encode to bytes above 127, which
  // also map to 255, and the first one sits at the same index as in `str`.
  const bytes = encoder.encode(str)
  for (let i = 0, j = 0; j < length; i++, j += 2) {
    const a = hexCodes[bytes[j]]
    const b = hexCodes[bytes[j + 1]]
    if ((a | b) > 15) return decodeFailure(str, bytes.length)
    result[i] = (a << 4) | b
  }
  return Result.succeed(result)
}

// The odd-length message reports the UTF-8 byte length, so non-ASCII input
// whose UTF-8 encoding has an even length reports "Invalid input" instead.
const decodeFailure = (
  str: string,
  byteLength: number = encoder.encode(str).length
): Result.Result<never, EncodingError> =>
  Result.fail(
    new EncodingError({
      module: "Hex",
      kind: "Decode",
      input: str,
      message: byteLength % 2 !== 0 ? `Length must be a multiple of 2, but is ${byteLength}` : "Invalid input"
    })
  )

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
 * ```ts import.meta.vitest
 * import { Result } from "effect"
 * import { Hex } from "effect/encoding"
 *
 * Hex.decodeString("68656c6c6f") // => Result.succeed("hello")
 * ```
 *
 * @stability stable
 * @category decoding
 * @since 4.0.0
 */
export const decodeString = (str: string) => Result.map(decode(str), (_) => decoder.decode(_))

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { ignoreBOM: true })

const byteToHex: Array<string> = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"))

const hexEncodeUint8Array = (bytes: Uint8Array): string => {
  // Looked up on the prototype at call time, so own or subclass overrides are ignored.
  const toHex = (Uint8Array.prototype as { readonly toHex?: (this: Uint8Array) => string }).toHex
  // The size guard also keeps detached buffers (length 0) away from native `toHex`, which throws on them.
  if (bytes.length >= 6 && typeof toHex === "function") return toHex.call(bytes)
  let result = ""
  for (let i = 0; i < bytes.length; i++) {
    result += byteToHex[bytes[i]]
  }
  return result
}

const hexCodes = new Uint8Array(256).fill(255)
for (let i = 0; i < 16; i++) {
  hexCodes["0123456789abcdef".charCodeAt(i)] = i
  hexCodes["0123456789ABCDEF".charCodeAt(i)] = i
}

const hexCode = (charCode: number): number => charCode < 256 ? hexCodes[charCode] : 255
