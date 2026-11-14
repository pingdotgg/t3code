/**
 * Base64 for byte arrays, on the native `toBase64`/`fromBase64` when the
 * runtime has them and `btoa`/`atob` otherwise.
 */
export const bytesToBase64 = (bytes: Uint8Array): string => {
  const encode = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (typeof encode === "function") return encode.call(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

export const base64ToBytes = (b64: string): Uint8Array => {
  const decode = (
    Uint8Array as Uint8ArrayConstructor & { fromBase64?: (value: string) => Uint8Array }
  ).fromBase64;
  if (typeof decode === "function") return decode.call(Uint8Array, b64);
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
};
