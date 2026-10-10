// @effect-diagnostics nodeBuiltinImport:off - Builds real P-256 keys and hashes, as an authenticator would.
import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "vite-plus/test";

import {
  PASSKEY_SCRIPT,
  passkeyAnswer,
  passkeyOrigin,
  passkeyRequest,
  relyingPartyIdError,
  type PasskeyRequest,
} from "./ServerBrowserPasskeys.ts";

const base64Url = (bytes: Uint8Array | string) => Buffer.from(bytes).toString("base64url");

/** Encodes the CBOR subset attestation objects use. */
const cbor = (value: unknown): Buffer => {
  const head = (major: number, length: number) =>
    length < 24
      ? Buffer.from([(major << 5) | length])
      : length < 256
        ? Buffer.from([(major << 5) | 24, length])
        : Buffer.from([(major << 5) | 25, length >> 8, length & 255]);
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") {
    const bytes = Buffer.from(value);
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), value]);
  if (value instanceof Map) {
    return Buffer.concat([
      head(5, value.size),
      ...[...value].flatMap(([key, member]) => [cbor(key), cbor(member)]),
    ]);
  }
  throw new Error("Unsupported CBOR value");
};

const rpIdHash = (rpId: string) => NodeCrypto.createHash("sha256").update(rpId).digest();
const clientData = (type: string, challenge: string, origin = "https://example.com") =>
  base64Url(JSON.stringify({ type, challenge, origin, crossOrigin: false }));

const request = (kind: "create" | "get", options: Record<string, unknown>) => {
  const result = passkeyRequest(kind, "https://example.com", options);
  if ("error" in result) throw new Error(result.error);
  return result;
};

const creation = {
  challenge: "Y2hhbGxlbmdl",
  rp: { name: "Example" },
  user: { id: base64Url("user-1"), name: "alice", displayName: "Alice" },
  pubKeyCredParams: [
    { type: "public-key", alg: -257 },
    { type: "public-key", alg: -7 },
  ],
};

describe("passkeyOrigin", () => {
  it("allows https and loopback http only", () => {
    expect(passkeyOrigin("https://example.com/login?next=1")).toBe("https://example.com");
    expect(passkeyOrigin("http://localhost:5173/")).toBe("http://localhost:5173");
    expect(passkeyOrigin("http://127.0.0.1:3000/a")).toBe("http://127.0.0.1:3000");
    expect(passkeyOrigin("http://example.com/")).toBeNull();
    expect(passkeyOrigin("about:blank")).toBeNull();
    expect(passkeyOrigin("not a url")).toBeNull();
  });
});

describe("relyingPartyIdError", () => {
  it("accepts the host and its registrable parents", () => {
    expect(relyingPartyIdError("https://example.com", "example.com")).toBeNull();
    expect(relyingPartyIdError("https://login.example.com", "example.com")).toBeNull();
    expect(relyingPartyIdError("http://localhost:5173", "localhost")).toBeNull();
  });

  it("refuses public suffixes, other sites, and lookalikes", () => {
    expect(relyingPartyIdError("https://alice.github.io", "github.io")).toBe("SecurityError");
    expect(relyingPartyIdError("https://example.com", "com")).toBe("SecurityError");
    expect(relyingPartyIdError("https://example.com", "example.net")).toBe("SecurityError");
    expect(relyingPartyIdError("https://notexample.com", "example.com")).toBe("SecurityError");
    expect(relyingPartyIdError("https://example.com", "login.example.com")).toBe("SecurityError");
  });
});

describe("passkeyRequest", () => {
  it("fills in a sign-in's RP ID and clamps its timeout", () => {
    const signIn = request("get", {
      challenge: "Y2hhbGxlbmdl",
      timeout: 1,
      allowCredentials: [
        { type: "public-key", id: "Y3JlZA" },
        { type: "other", id: "eA" },
      ],
    });
    expect(signIn).toMatchObject({
      rpId: "example.com",
      publicKey: { rpId: "example.com" },
      timeoutMs: 10_000,
      allowCredentials: ["Y3JlZA"],
    });
  });

  it("refuses options a browser would", () => {
    expect(passkeyRequest("get", "https://example.com", { challenge: 5 })).toEqual({
      error: "TypeError",
    });
    expect(
      passkeyRequest("get", "https://example.com", { challenge: "eA", rpId: "example.net" }),
    ).toEqual({ error: "SecurityError" });
    expect(
      passkeyRequest("create", "https://example.com", {
        ...creation,
        user: { ...creation.user, id: "" },
      }),
    ).toEqual({ error: "TypeError" });
    expect(
      passkeyRequest("create", "https://example.com", {
        ...creation,
        pubKeyCredParams: [{ type: "public-key", alg: -257 }],
      }),
    ).toEqual({ error: "NotSupportedError" });
  });

  it("asks the device for a P-256 key for the page's site", () => {
    expect(request("create", creation)).toMatchObject({
      rpId: "example.com",
      publicKey: {
        rp: { id: "example.com", name: "Example" },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      },
    });
  });
});

describe("passkeyAnswer", () => {
  const signIn = request("get", { challenge: "Y2hhbGxlbmdl", allowCredentials: [] });
  const assertion = (overrides: Record<string, unknown> = {}) => ({
    success: true,
    credential: {
      id: "Y3JlZA",
      clientDataJSON: clientData("webauthn.get", "Y2hhbGxlbmdl"),
      authenticatorData: base64Url(
        Buffer.concat([rpIdHash("example.com"), Buffer.from([0x05, 0, 0, 0, 1])]),
      ),
      signature: "c2ln",
      userHandle: "dXNlcg",
      authenticatorAttachment: "platform",
      ...overrides,
    },
  });

  it("hands the page a sign-in signed for this ceremony", () => {
    expect(passkeyAnswer(signIn, assertion())).toEqual({
      credential: {
        id: "Y3JlZA",
        rawId: "Y3JlZA",
        type: "public-key",
        authenticatorAttachment: "platform",
        response: {
          clientDataJSON: clientData("webauthn.get", "Y2hhbGxlbmdl"),
          authenticatorData: assertion().credential.authenticatorData,
          signature: "c2ln",
          userHandle: "dXNlcg",
        },
        clientExtensionResults: {},
      },
    });
  });

  it("drops a credential signed for another page, ceremony, or site", () => {
    const notAllowed = { error: "NotAllowedError" };
    const wrong = [
      { clientDataJSON: clientData("webauthn.get", "Y2hhbGxlbmdl", "https://example.net") },
      { clientDataJSON: clientData("webauthn.get", "b3RoZXI") },
      { clientDataJSON: clientData("webauthn.create", "Y2hhbGxlbmdl") },
      { authenticatorData: base64Url(Buffer.concat([rpIdHash("example.net"), Buffer.alloc(5)])) },
      { signature: undefined },
    ];
    for (const overrides of wrong) {
      expect(passkeyAnswer(signIn, assertion(overrides))).toEqual(notAllowed);
    }
    const listed = request("get", {
      challenge: "Y2hhbGxlbmdl",
      allowCredentials: [{ type: "public-key", id: "b3RoZXI" }],
    });
    expect(passkeyAnswer(listed, assertion())).toEqual(notAllowed);
  });

  it("passes the device's WebAuthn errors through and hides anything else", () => {
    expect(passkeyAnswer(signIn, { success: false, error: "InvalidStateError" })).toEqual({
      error: "InvalidStateError",
    });
    expect(passkeyAnswer(signIn, { success: false, error: "ASAuthorizationError 1004" })).toEqual({
      error: "NotAllowedError",
    });
    expect(passkeyAnswer(signIn, "garbage")).toEqual({ error: "NotAllowedError" });
  });

  it("reads a new passkey's public key out of its attestation", () => {
    const signUp: PasskeyRequest = request("create", {
      ...creation,
      extensions: { credProps: true },
    });
    const keys = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = keys.publicKey.export({ format: "jwk" });
    const credentialId = Buffer.from("credential-1");
    const coseKey = new Map<number, unknown>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x!, "base64url")],
      [-3, Buffer.from(jwk.y!, "base64url")],
    ]);
    const authData = Buffer.concat([
      rpIdHash("example.com"),
      Buffer.from([0x45, 0, 0, 0, 0]),
      Buffer.alloc(16),
      Buffer.from([0, credentialId.length]),
      credentialId,
      cbor(coseKey),
    ]);
    const attestationObject = base64Url(
      cbor(
        new Map<string, unknown>([
          ["fmt", "none"],
          ["attStmt", new Map()],
          ["authData", authData],
        ]),
      ),
    );
    const registration = (id: string) => ({
      success: true,
      credential: {
        id,
        clientDataJSON: clientData("webauthn.create", "Y2hhbGxlbmdl"),
        attestationObject,
        authenticatorAttachment: "platform",
        transports: ["hybrid", "internal", 5],
      },
    });
    expect(passkeyAnswer(signUp, registration(base64Url(credentialId)))).toEqual({
      credential: {
        id: base64Url(credentialId),
        rawId: base64Url(credentialId),
        type: "public-key",
        authenticatorAttachment: "platform",
        response: {
          clientDataJSON: clientData("webauthn.create", "Y2hhbGxlbmdl"),
          attestationObject,
          authenticatorData: base64Url(authData),
          transports: ["hybrid", "internal"],
          publicKeyAlgorithm: -7,
          publicKey: base64Url(keys.publicKey.export({ format: "der", type: "spki" })),
        },
        clientExtensionResults: { credProps: { rk: true } },
      },
    });
    // The credential ID the device reports must be the one it attested.
    expect(passkeyAnswer(signUp, registration(base64Url("another")))).toEqual({
      error: "NotAllowedError",
    });
  });
});

describe("PASSKEY_SCRIPT", () => {
  it("parses, and leaves a page without WebAuthn alone", () => {
    expect(() => new Function(PASSKEY_SCRIPT)()).not.toThrow();
  });
});
