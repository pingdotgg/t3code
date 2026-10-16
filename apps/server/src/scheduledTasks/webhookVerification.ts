// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no createHmac or timingSafeEqual.
import * as NodeCrypto from "node:crypto";

import type { ScheduledTaskWebhookSignature } from "@t3tools/contracts";

/** Constant-time string comparison that does not leak length through timing. */
export function constantTimeEquals(a: string, b: string): boolean {
  const digestA = NodeCrypto.createHash("sha256").update(a).digest();
  const digestB = NodeCrypto.createHash("sha256").update(b).digest();
  return NodeCrypto.timingSafeEqual(digestA, digestB);
}

export function verifyWebhookSignature(input: {
  readonly signature: ScheduledTaskWebhookSignature;
  readonly secret: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}): boolean {
  const received = input.headers[input.signature.header.toLowerCase()];
  if (received === undefined) return false;
  const value = received.trim();
  const prefix = input.signature.prefix;
  if (prefix !== "" && !value.toLowerCase().startsWith(prefix.toLowerCase())) return false;
  const digest = NodeCrypto.createHmac("sha256", input.secret).update(input.body).digest();
  const expected =
    input.signature.encoding === "hex" ? digest.toString("hex") : digest.toString("base64");
  const candidate = value.slice(prefix.length);
  return constantTimeEquals(
    input.signature.encoding === "hex" ? candidate.toLowerCase() : candidate,
    expected,
  );
}
