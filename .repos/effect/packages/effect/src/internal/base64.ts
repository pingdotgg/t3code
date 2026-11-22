/** @internal */
export interface NativeDecodeOptions {
  readonly alphabet: "base64url"
}

/**
 * Decodes `str` with native `Uint8Array.fromBase64`.
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
  if (typeof NativeUint8Array.fromBase64 !== "function") return undefined
  try {
    const bytes = NativeUint8Array.fromBase64(str, options)
    return bytes.length === decodedLength ? bytes : null
  } catch {
    return null
  }
}

/** @internal */
export const stripCrlf = (str: string): string =>
  str.indexOf("\n") === -1 && str.indexOf("\r") === -1 ? str : str.replace(/[\n\r]/g, "")
