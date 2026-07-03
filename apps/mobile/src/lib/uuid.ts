import * as Crypto from "expo-crypto";

export const uuidv4 = () => Crypto.randomUUID();

/** Random lowercase hex string of `byteLength` bytes (2 chars per byte). */
export const randomHex = (byteLength: number): string =>
  uuidv4().replaceAll("-", "").slice(0, byteLength * 2).toLowerCase();
