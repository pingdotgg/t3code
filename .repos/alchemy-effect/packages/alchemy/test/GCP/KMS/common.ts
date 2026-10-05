import * as Core from "@/Test/Core";

/**
 * Cloud KMS never deletes key rings, and keeps destroyed keys for at least
 * a day. Tests therefore reuse fixed ids, which the CryptoKey provider
 * reclaims after destroy. Scope them by test stage so developers (and CI)
 * sharing one project never contend for the same key.
 */
export const kmsTestId = (name: string) =>
  `alchemy-test-${name}-${Core.defaultStage()}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .slice(0, 63);

export const KEY_RING_ID = "alchemy-test-keyring";
