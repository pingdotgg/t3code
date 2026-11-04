// @effect-diagnostics nodeBuiltinImport:off - validates the signature with the native receiver API.
import * as NodeCrypto from "node:crypto";
import { expect, it } from "@effect/vitest";
import { makeSigner } from "./ExternalToolSigning.ts";

it("signs exact target and identity bytes with a process-local key and short-lived unique request IDs", () => {
  const signer = makeSigner();
  const request = {
    target: "sample",
    identity: { threadId: "root", subagent: false },
    arguments: { text: "data" },
  };
  const first = signer.sign(request, 1000);
  const second = signer.sign(request, 1000);
  expect(JSON.parse(first.body)).toMatchObject({
    ...request,
    version: 1,
    issuedAt: 1000,
    expiresAt: 31000,
  });
  expect(JSON.parse(first.body).requestId).not.toBe(JSON.parse(second.body).requestId);
  const signature = Buffer.from(first.signature, "base64url");
  expect(NodeCrypto.verify(null, Buffer.from(first.body), signer.publicKeyPem, signature)).toBe(
    true,
  );
  expect(
    NodeCrypto.verify(
      null,
      Buffer.from(first.body.replace('"root"', '"other"')),
      signer.publicKeyPem,
      signature,
    ),
  ).toBe(false);
  expect(
    NodeCrypto.verify(null, Buffer.from(first.body), makeSigner().publicKeyPem, signature),
  ).toBe(false);
  expect(Object.keys(signer).sort()).toEqual(["keyId", "publicKeyPem", "sign"]);
});
