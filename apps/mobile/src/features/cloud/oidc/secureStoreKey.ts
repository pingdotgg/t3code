/**
 * SecureStore keys allow only letters, digits, ".", "-" and "_". Every other character, "_"
 * included, becomes "_" and its six-digit code point, so two keys never share an entry.
 */
export const secureStoreKey = (key: string): string =>
  key.replace(
    /[^A-Za-z0-9.-]/gu,
    (char) => `_${char.codePointAt(0)!.toString(16).padStart(6, "0")}`,
  );
