import { getRandomValues } from "expo-crypto";

// Hermes has no Web Crypto. MT Code's computer-task hosts call globalThis.crypto.getRandomValues,
// which crashed the app right after pairing without this. (The inline-page compose bridge imports
// expo-crypto directly and doesn't rely on this.)
const target = globalThis as { crypto?: { getRandomValues?: unknown } };
if (typeof target.crypto?.getRandomValues !== "function") {
  target.crypto = { ...target.crypto, getRandomValues };
}
