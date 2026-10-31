// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect Crypto does not expose streaming digests.
import * as NodeCrypto from "node:crypto";

/** Streaming digests keep model verification independent of its size in memory. */
export function createIntegrityHash(algorithm: "sha256" | "sha512") {
  return NodeCrypto.createHash(algorithm);
}
