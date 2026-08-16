// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";

import { decryptChromiumValue } from "./ChromiumCookies.ts";
import { stripDpapiMarker } from "./ChromiumKeys.ts";

const SALT = "saltysalt";
const CBC_IV = Buffer.alloc(16, 0x20);

const deriveCbcKey = (passphrase: string, iterations: number) =>
  NodeCrypto.pbkdf2Sync(passphrase, SALT, iterations, 16, "sha1");

/** Encrypts the way Chromium does on macOS/Linux, including the v127+ domain binding. */
function encryptCbc(prefix: string, value: string, key: Buffer, domain?: string): Buffer {
  const body = domain
    ? Buffer.concat([NodeCrypto.createHash("sha256").update(domain).digest(), Buffer.from(value)])
    : Buffer.from(value);
  const cipher = NodeCrypto.createCipheriv("aes-128-cbc", key, CBC_IV);
  return Buffer.concat([Buffer.from(prefix, "latin1"), cipher.update(body), cipher.final()]);
}

/** Encrypts the way Chromium does on Windows: v10 + 12-byte nonce + body + 16-byte tag. */
function encryptGcm(value: string, key: Buffer, domain?: string): Buffer {
  const nonce = NodeCrypto.randomBytes(12);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, nonce);
  const body = domain
    ? Buffer.concat([NodeCrypto.createHash("sha256").update(domain).digest(), Buffer.from(value)])
    : Buffer.from(value);
  const encrypted = Buffer.concat([cipher.update(body), cipher.final()]);
  return Buffer.concat([Buffer.from("v10", "latin1"), nonce, encrypted, cipher.getAuthTag()]);
}

describe("decryptChromiumValue", () => {
  it("decrypts macOS records, stripping the domain binding", () => {
    // macOS stretches the keychain secret over 1003 iterations.
    const key = deriveCbcKey("mac-keychain-secret", 1003);

    expect(
      decryptChromiumValue(
        encryptCbc("v10", "abc", key, ".github.com"),
        { cbcV10: key },
        ".github.com",
      ),
    ).toBe("abc");
    // Pre-127 records carry no domain hash.
    expect(
      decryptChromiumValue(encryptCbc("v10", "abc", key), { cbcV10: key }, ".github.com"),
    ).toBe("abc");
  });

  it("decrypts Linux v10 with the fallback passphrase and v11 with the keyring secret", () => {
    // Both schemes can appear in one database, so both keys are held and the
    // record's prefix picks between them.
    const fallback = deriveCbcKey("peanuts", 1);
    const keyring = deriveCbcKey("keyring-secret", 1);
    const keys = { cbcV10: fallback, cbcV11: keyring };

    expect(decryptChromiumValue(encryptCbc("v10", "no-keyring", fallback), keys, "a.test")).toBe(
      "no-keyring",
    );
    expect(decryptChromiumValue(encryptCbc("v11", "with-keyring", keyring), keys, "a.test")).toBe(
      "with-keyring",
    );
  });

  it("skips v11 records when no keyring secret was obtainable", () => {
    // A locked or absent Secret Service must degrade to a partial import
    // rather than failing everything.
    const fallback = deriveCbcKey("peanuts", 1);
    const keyring = deriveCbcKey("keyring-secret", 1);

    expect(
      decryptChromiumValue(encryptCbc("v11", "x", keyring), { cbcV10: fallback }, "a.test"),
    ).toBeNull();
    expect(
      decryptChromiumValue(encryptCbc("v10", "kept", fallback), { cbcV10: fallback }, "a.test"),
    ).toBe("kept");
  });

  it("decrypts Windows AES-GCM records", () => {
    const key = NodeCrypto.randomBytes(32);

    expect(
      decryptChromiumValue(
        encryptGcm("win", key, ".example.test"),
        { gcmV10: key },
        ".example.test",
      ),
    ).toBe("win");
  });

  it("skips app-bound v20 records instead of failing", () => {
    // v20 is bound to the browser binary and unreadable by design; the import
    // reports it as skipped rather than erroring out.
    const key = NodeCrypto.randomBytes(32);
    const v20 = Buffer.concat([Buffer.from("v20", "latin1"), NodeCrypto.randomBytes(48)]);

    expect(decryptChromiumValue(v20, { gcmV10: key }, "a.test")).toBeNull();
  });

  it("returns an empty value for an unencrypted empty record", () => {
    expect(decryptChromiumValue(new Uint8Array(), {}, "a.test")).toBe("");
  });

  it("returns null when a key is wrong rather than throwing", () => {
    const right = deriveCbcKey("right", 1003);
    const wrong = deriveCbcKey("wrong", 1003);

    expect(
      decryptChromiumValue(encryptCbc("v10", "v", right), { cbcV10: wrong }, "a.test"),
    ).toBeNull();
  });
});

describe("stripDpapiMarker", () => {
  it("removes the DPAPI prefix Windows writes in front of the key", () => {
    const wrapped = Buffer.concat([Buffer.from("DPAPI", "latin1"), Buffer.from([1, 2, 3])]);

    expect([...stripDpapiMarker(wrapped.toString("base64"))]).toEqual([1, 2, 3]);
  });

  it("leaves a key without the marker untouched", () => {
    expect([...stripDpapiMarker(Buffer.from([9, 8]).toString("base64"))]).toEqual([9, 8]);
  });
});

describe("decryptChromiumValue with unusable key material", () => {
  it("returns null rather than a wrong plaintext for a zero-length GCM key", () => {
    // A failed DPAPI unwrap used to produce an empty Buffer, which is truthy,
    // so the key looked present and every record silently failed to decrypt.
    // `resolveChromiumKeys` now refuses to hand one back; this pins the
    // behaviour of the decrypt path if one ever reaches it.
    const record = Buffer.concat([Buffer.from("v10", "latin1"), Buffer.alloc(40, 7)]);

    expect(decryptChromiumValue(record, { gcmV10: Buffer.alloc(0) }, "example.test")).toBeNull();
  });
});
