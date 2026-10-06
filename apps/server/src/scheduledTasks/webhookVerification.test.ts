import * as NodeCrypto from "node:crypto";

import { assert, describe, it } from "@effect/vitest";

import { verifyWebhookSignature } from "./webhookVerification.ts";

const body = new TextEncoder().encode('{"action":"opened"}');
const secret = "shared-secret";
const hmac = () => NodeCrypto.createHmac("sha256", secret).update(body);

describe("verifyWebhookSignature", () => {
  const github = { header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=" } as const;

  it("accepts a GitHub-style hex signature with prefix", () => {
    const headers = { "x-hub-signature-256": `sha256=${hmac().digest("hex")}` };
    assert.isTrue(verifyWebhookSignature({ signature: github, secret, headers, body }));
  });

  it("rejects a tampered body, a wrong secret, a missing header and a missing prefix", () => {
    const valid = `sha256=${hmac().digest("hex")}`;
    const tampered = new TextEncoder().encode('{"action":"closed"}');
    assert.isFalse(
      verifyWebhookSignature({
        signature: github,
        secret,
        headers: { "x-hub-signature-256": valid },
        body: tampered,
      }),
    );
    assert.isFalse(
      verifyWebhookSignature({
        signature: github,
        secret: "other",
        headers: { "x-hub-signature-256": valid },
        body,
      }),
    );
    assert.isFalse(verifyWebhookSignature({ signature: github, secret, headers: {}, body }));
    assert.isFalse(
      verifyWebhookSignature({
        signature: github,
        secret,
        headers: { "x-hub-signature-256": hmac().digest("hex") },
        body,
      }),
    );
  });

  it("accepts a base64 signature without prefix", () => {
    assert.isTrue(
      verifyWebhookSignature({
        signature: { header: "X-Signature", encoding: "base64", prefix: "" },
        secret,
        headers: { "x-signature": hmac().digest("base64") },
        body,
      }),
    );
  });
});
