// @effect-diagnostics-next-line nodeBuiltinImport:off -- Node's HMAC is an independent oracle for the Effect implementation.
import * as NodeCrypto from "node:crypto";

import * as PlatformNodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { verifyWebhookSignature } from "./webhookVerification.ts";

const body = new TextEncoder().encode('{"action":"opened"}');
const secret = "shared-secret";
const hmac = () => NodeCrypto.createHmac("sha256", secret).update(body);

describe("verifyWebhookSignature", () => {
  const github = { header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=" } as const;

  it.effect("rejects a tampered body, a wrong secret, a missing header and a missing prefix", () =>
    Effect.gen(function* () {
      const valid = `sha256=${hmac().digest("hex")}`;
      const tampered = new TextEncoder().encode('{"action":"closed"}');
      assert.isFalse(
        yield* verifyWebhookSignature({
          signature: github,
          secret,
          headers: { "x-hub-signature-256": valid },
          body: tampered,
        }),
      );
      assert.isFalse(
        yield* verifyWebhookSignature({
          signature: github,
          secret: "other",
          headers: { "x-hub-signature-256": valid },
          body,
        }),
      );
      assert.isFalse(
        yield* verifyWebhookSignature({ signature: github, secret, headers: {}, body }),
      );
      assert.isFalse(
        yield* verifyWebhookSignature({
          signature: github,
          secret,
          headers: { "x-hub-signature-256": hmac().digest("hex") },
          body,
        }),
      );
    }).pipe(Effect.provide(PlatformNodeCrypto.layerMac)),
  );

  it.effect("accepts a hex signature with its prefix and a base64 signature without one", () =>
    Effect.gen(function* () {
      assert.isTrue(
        yield* verifyWebhookSignature({
          signature: github,
          secret,
          headers: { "x-hub-signature-256": `sha256=${hmac().digest("hex").toUpperCase()}` },
          body,
        }),
      );
      assert.isTrue(
        yield* verifyWebhookSignature({
          signature: { header: "X-Signature", encoding: "base64", prefix: "" },
          secret,
          headers: { "x-signature": hmac().digest("base64") },
          body,
        }),
      );
    }).pipe(Effect.provide(PlatformNodeCrypto.layerMac)),
  );
});
