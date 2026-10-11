/**
 * Reads the raw `authData` bytes out of a CBOR attestation object
 * (`{ fmt, attStmt, authData }`). Returns undefined for anything malformed.
 * Only the definite-length encodings authenticators emit are understood.
 */
export const authenticatorDataFromAttestation = (bytes: Uint8Array) => {
  let offset = 0;
  const readHead = () => {
    const initial = bytes[offset++];
    if (initial === undefined) return undefined;
    const info = initial & 31;
    let length = info;
    if (info >= 24) {
      if (info > 27) return undefined;
      const size = 1 << (info - 24);
      if (offset + size > bytes.length) return undefined;
      length = 0;
      for (let index = 0; index < size; index++) length = length * 256 + (bytes[offset++] ?? 0);
    }
    return { major: initial >> 5, length };
  };
  const skipValue = (): boolean => {
    const head = readHead();
    if (!head) return false;
    switch (head.major) {
      case 2:
      case 3:
        offset += head.length;
        return offset <= bytes.length;
      case 4:
        for (let index = 0; index < head.length; index++) if (!skipValue()) return false;
        return true;
      case 5:
        for (let index = 0; index < head.length * 2; index++) if (!skipValue()) return false;
        return true;
      case 6:
        return skipValue();
      default:
        return true;
    }
  };

  const map = readHead();
  if (map?.major !== 5) return undefined;
  for (let entry = 0; entry < map.length; entry++) {
    const key = readHead();
    if (key?.major !== 3 || offset + key.length > bytes.length) return undefined;
    const name = new TextDecoder().decode(bytes.subarray(offset, offset + key.length));
    offset += key.length;
    if (name !== "authData") {
      if (!skipValue()) return undefined;
      continue;
    }
    const value = readHead();
    if (value?.major !== 2 || offset + value.length > bytes.length) return undefined;
    return bytes.slice(offset, offset + value.length);
  }
  return undefined;
};
