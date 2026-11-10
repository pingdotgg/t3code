// @effect-diagnostics nodeBuiltinImport:off -- tests craft the CLI's own AES-GCM store values with node crypto
import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";

import {
  decryptZcodeCredential,
  resolveZcodeCredentialSecret,
  zcodeAccountScope,
  zcodeFamilyFromProviderId,
} from "./zcodeRequestAuth.ts";

/** Produces store values the CLI's fallback cipher would hold, keyed the same way. */
const encryptZcodeCredential = (value: string, secret: string): string => {
  const iv = NodeCrypto.randomBytes(12);
  const cipher = NodeCrypto.createCipheriv(
    "aes-256-gcm",
    NodeCrypto.createHash("sha256").update(secret).digest(),
    iv,
  );
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `enc:v1:${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
};

describe("resolveZcodeCredentialSecret", () => {
  it("prefers ZCODE_CREDENTIAL_SECRET and trims it", () => {
    assert.equal(
      resolveZcodeCredentialSecret({ ZCODE_CREDENTIAL_SECRET: " custom-secret " }, "linux"),
      "custom-secret",
    );
    const blankOverride = resolveZcodeCredentialSecret(
      { ZCODE_CREDENTIAL_SECRET: "   ", HOME: "/home/dev" },
      "linux",
    );
    assert.match(blankOverride, /^zcode-credential-fallback:linux:\/home\/dev:/);
  });

  it("derives the CLI's machine-bound fallback with the HOME from the environment", () => {
    // Username comes from os.userInfo() where resolvable (env names never win); on runtimes
    // where it throws, the env fallback speaks. Only the stable parts are asserted here.
    const secret = resolveZcodeCredentialSecret(
      { USER: "someoneElse", HOME: "/home/dev" },
      "darwin",
    );
    assert.match(secret, /^zcode-credential-fallback:darwin:\/home\/dev:/);
    assert.match(resolveZcodeCredentialSecret({}, "linux"), /^zcode-credential-fallback:linux:/);
  });
});

describe("decryptZcodeCredential", () => {
  it("round-trips the CLI's encrypted store values", () => {
    const secret = "zcode-credential-fallback:linux:/home/dev:jame";
    for (const plaintext of ["oauth-login-token", "值-with-unicode 🔐", ""]) {
      assert.equal(
        decryptZcodeCredential(encryptZcodeCredential(plaintext, secret), secret),
        plaintext,
      );
    }
  });

  it("passes plain store values through and rejects malformed ciphertext", () => {
    assert.equal(decryptZcodeCredential("plain-token", "s"), "plain-token");
    assert.throws(() => decryptZcodeCredential("enc:v1:not-a-cipher", "s"));
    assert.throws(() => decryptZcodeCredential("enc:v1:only.two", "s"));
  });
});

describe("zcodeFamilyFromProviderId", () => {
  it("maps account plan provider ids to their auth family", () => {
    assert.equal(zcodeFamilyFromProviderId("account:zai-individual-coding-plan"), "zai");
    assert.equal(zcodeFamilyFromProviderId("account:bigmodel-individual-coding-plan"), "bigmodel");
    assert.equal(zcodeFamilyFromProviderId("account:zai"), "zai");
  });

  it("returns undefined for provider ids outside the account namespace", () => {
    assert.equal(zcodeFamilyFromProviderId(undefined), undefined);
    assert.equal(zcodeFamilyFromProviderId("account:"), undefined);
    assert.equal(zcodeFamilyFromProviderId(""), undefined);
  });
});

describe("zcodeAccountScope", () => {
  it("digests the plan identity, login token, and JWT exactly like the CLI", () => {
    assert.equal(
      zcodeAccountScope("zai", "login-token", undefined),
      NodeCrypto.createHash("sha256")
        .update(JSON.stringify(["zai", "individual-coding-plan", null, "login-token", null]))
        .digest("hex"),
    );
    assert.equal(
      zcodeAccountScope("zai", "login-token", "jwt"),
      NodeCrypto.createHash("sha256")
        .update(JSON.stringify(["zai", "individual-coding-plan", null, "login-token", "jwt"]))
        .digest("hex"),
    );
  });

  it("is deterministic and changes with any input", () => {
    assert.equal(
      zcodeAccountScope("zai", "tok", undefined),
      zcodeAccountScope("zai", "tok", undefined),
    );
    assert.notEqual(
      zcodeAccountScope("zai", "tok", undefined),
      zcodeAccountScope("bigmodel", "tok", undefined),
    );
    assert.notEqual(
      zcodeAccountScope("zai", "tok", undefined),
      zcodeAccountScope("zai", "tok2", undefined),
    );
  });
});
