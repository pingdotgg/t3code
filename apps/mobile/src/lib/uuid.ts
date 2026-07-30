import * as Crypto from "expo-crypto";

export const uuidv4 = () => Crypto.randomUUID();

/** Random lowercase hex string of `byteLength` bytes (2 chars per byte). */
export const randomHex = (byteLength: number): string =>
  Array.from(Crypto.getRandomBytes(byteLength), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
