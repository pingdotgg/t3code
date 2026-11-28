// @effect-diagnostics nodeBuiltinImport:off - Generate fresh AES keys for the cipher tests.
import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "vite-plus/test";

import { isVaultCiphertext, openVaultValue, sealVaultValue } from "./VaultCipher.ts";

describe("local vault encryption", () => {
  it("round-trips bytes without storing plaintext or reusing a nonce", () => {
    const key = NodeCrypto.randomBytes(32);
    const value = Buffer.from("example-secret-value");
    const record = sealVaultValue(key, "account", value);
    expect(isVaultCiphertext(record)).toBe(true);
    expect(record.includes(value)).toBe(false);
    expect(record.equals(sealVaultValue(key, "account", value))).toBe(false);
    expect(openVaultValue(key, "account", record)).toEqual(value);
  });

  it("rejects tampered, swapped, plaintext, and wrong-key records", () => {
    const key = NodeCrypto.randomBytes(32);
    const value = Buffer.from("example");
    const record = sealVaultValue(key, "account", value);
    expect(() => openVaultValue(key, "different", record)).toThrow();
    expect(() => openVaultValue(NodeCrypto.randomBytes(32), "account", record)).toThrow();
    expect(() => openVaultValue(key, "account", value)).toThrow();
    record[record.length - 1] = record.at(-1)! ^ 1;
    expect(() => openVaultValue(key, "account", record)).toThrow();
  });
});
