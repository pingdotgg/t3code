/** @internal */
export interface NativeDecodeOptions {
  readonly alphabet: "base64url"
}

/**
 * Decodes `str` with native `Uint8Array.fromBase64`, falling back to `Buffer`.
 *
 * Returns `undefined` when native decoding is unavailable or skipped for a
 * short input, and `null` when native decoding rejected the input. In both
 * cases the caller's JS path produces the module's own result or error.
 *
 * Native decoding also skips ASCII whitespace and accepts missing padding, so
 * callers validate the length and padding first and pass the byte length a
 * valid input decodes to. Skipped whitespace always yields fewer bytes, so a
 * result of any other length counts as rejected.
 *
 * @internal
 */
export const decodeNative = (
  str: string,
  decodedLength: number,
  options: NativeDecodeOptions | undefined
): Uint8Array | null | undefined => {
  // Native calls cost about 1 µs on V8, while the JS path stays well below that
  // until the output outgrows V8's 64-byte on-heap typed arrays.
  if (str.length < 128) return undefined
  const NativeUint8Array = Uint8Array as {
    readonly fromBase64?: (string: string, options?: NativeDecodeOptions) => Uint8Array
  }
  if (typeof NativeUint8Array.fromBase64 !== "function") {
    const Buffer = getBuffer()
    if (Buffer === undefined) return undefined
    const encoding = options?.alphabet ?? "base64"
    const bytes = new Uint8Array(decodedLength)
    const buffer = Buffer.from(bytes.buffer)
    // `Buffer` is permissive (skips invalid chars, mixes alphabets, truncates
    // code units), so accept only input that round-trips identically.
    const canonical = options !== undefined && str.endsWith("=") ? str.slice(0, str.indexOf("=")) : str
    return buffer.write(str, encoding) === decodedLength && buffer.toString(encoding) === canonical ? bytes : null
  }
  try {
    const bytes = NativeUint8Array.fromBase64(str, options)
    return bytes.length === decodedLength ? bytes : null
  } catch {
    return null
  }
}

interface BufferLike {
  write(string: string, encoding: string): number
  toString(encoding: string): string
}

interface BufferConstructorLike {
  from(buffer: ArrayBufferLike, byteOffset?: number, length?: number): BufferLike
}

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")!.get as (
  this: Uint8Array
) => ArrayBufferLike
const typedArrayByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")!.get as (
  this: Uint8Array
) => number
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")!.get as (
  this: Uint8Array
) => number

// Gate on `process.versions.node` to avoid slow browser/RN `Buffer` polyfills;
// read at call time without importing `node:buffer`.
const getBuffer = (): BufferConstructorLike | undefined => {
  const global = globalThis as {
    readonly Buffer?: BufferConstructorLike
    readonly process?: { readonly versions?: { readonly node?: unknown } }
  }
  return typeof global.process?.versions?.node === "string" && typeof global.Buffer === "function"
    ? global.Buffer
    : undefined
}

/**
 * Encodes `bytes` with `Buffer` ("base64" padded, "base64url" unpadded), or returns `undefined` if unavailable.
 *
 * @internal
 */
export const encodeBuffer = (bytes: Uint8Array, encoding: "base64" | "base64url"): string | undefined => {
  const Buffer = getBuffer()
  if (Buffer === undefined) return undefined
  const byteLength = typedArrayByteLength.call(bytes)
  if (byteLength < 32) return undefined
  return Buffer.from(typedArrayBuffer.call(bytes), typedArrayByteOffset.call(bytes), byteLength).toString(encoding)
}

/** @internal */
export const stripCrlf = (str: string): string =>
  str.indexOf("\n") === -1 && str.indexOf("\r") === -1 ? str : str.replace(/[\n\r]/g, "")
