// @effect-diagnostics nodeBuiltinImport:off - keys never leave this host process.
import * as NodeCrypto from "node:crypto";

export const makeSigner = () => {
  const { publicKey, privateKey } = NodeCrypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const keyId = NodeCrypto.createHash("sha256").update(publicKeyPem).digest("hex");
  return {
    publicKeyPem,
    keyId,
    sign: (payload: object, now: number) => {
      const body = JSON.stringify({
        ...payload,
        version: 1,
        requestId: NodeCrypto.randomUUID(),
        issuedAt: now,
        expiresAt: now + 30_000,
      });
      return {
        body,
        signature: NodeCrypto.sign(null, Buffer.from(body), privateKey).toString("base64url"),
      };
    },
  };
};
