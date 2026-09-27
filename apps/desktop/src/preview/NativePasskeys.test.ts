import * as NodeCrypto from "node:crypto";
import { encode } from "cborg";
import { describe, expect, it } from "vite-plus/test";
import { decodePasskeyResult } from "./NativePasskeys.ts";

describe("native passkey response conversion", () => {
  it("extracts a verifiable SPKI key even when authenticator extensions follow it", () => {
    const { publicKey } = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    const cose = new Map<number, number | Buffer>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x!, "base64url")],
      [-3, Buffer.from(jwk.y!, "base64url")],
    ]);
    const prefix = Buffer.alloc(55);
    prefix[32] = 0xc5;
    prefix.writeUInt16BE(3, 53);
    const authData = Buffer.concat([
      prefix,
      Buffer.from([1, 2, 3]),
      encode(cose),
      encode({ credProtect: 2 }),
    ]);
    const attestation = encode({ fmt: "none", authData, attStmt: {} });
    const result = decodePasskeyResult(
      JSON.stringify({
        id: "AQID",
        authenticatorAttachment: "platform",
        response: {
          clientDataJSON: "BAUG",
          attestationObject: Buffer.from(attestation).toString("base64url"),
        },
      }),
      { operation: "create", credProps: true },
    );
    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error(result.error);
    expect(result.response.authenticatorData).toBe(authData.toString("base64url"));
    expect(result.response.publicKey).toBe(
      publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
    );
    expect(result.clientExtensionResults).toEqual({ credProps: { rk: true } });
  });
  it("preserves cancellation and rejects malformed attestations", () => {
    expect(
      decodePasskeyResult('{"error":"NotAllowedError"}', { operation: "get", credProps: false }),
    ).toEqual({ error: "NotAllowedError" });
    expect(() =>
      decodePasskeyResult('{"id":"AQID","response":{"attestationObject":""}}', {
        operation: "create",
        credProps: false,
      }),
    ).toThrow();
  });
});
