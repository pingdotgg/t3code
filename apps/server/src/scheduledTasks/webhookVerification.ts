import type { ScheduledTaskWebhookSignature } from "@t3tools/contracts";
import * as Digest from "effect/crypto/Digest";
import * as Mac from "effect/crypto/Mac";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Hex from "effect/encoding/Hex";
import * as Result from "effect/Result";

const utf8 = (value: string) => new TextEncoder().encode(value);

/** Compares hashes so the comparison does not leak either string's length. */
export const constantTimeEquals = Effect.fn("webhookVerification.constantTimeEquals")(function* (
  a: string,
  b: string,
) {
  const digest = yield* Digest.Digest;
  const [left, right] = yield* Effect.all([
    digest.digest(Digest.sha256, utf8(a)),
    digest.digest(Digest.sha256, utf8(b)),
  ]);
  return Mac.timingSafeEqual(left, right);
});

export const verifyWebhookSignature = Effect.fn("webhookVerification.verifyWebhookSignature")(
  function* (input: {
    readonly signature: ScheduledTaskWebhookSignature;
    readonly secret: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Uint8Array;
  }) {
    const received = input.headers[input.signature.header.toLowerCase()];
    if (received === undefined) return false;
    const value = received.trim();
    const prefix = input.signature.prefix;
    if (prefix !== "" && !value.toLowerCase().startsWith(prefix.toLowerCase())) return false;
    const candidate = value.slice(prefix.length);
    const tag =
      input.signature.encoding === "hex"
        ? Hex.decode(candidate.toLowerCase())
        : Base64.decode(candidate);
    if (Result.isFailure(tag)) return false;
    const mac = yield* Mac.Mac;
    return yield* Mac.key(Mac.hmacSha256, utf8(input.secret)).pipe(
      Effect.flatMap((key) => mac.verify(key, tag.success, input.body)),
      Effect.orElseSucceed(() => false),
    );
  },
);
