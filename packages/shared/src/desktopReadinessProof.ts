import * as Mac from "effect/crypto/Mac";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";

/** Where a backend launched without a control channel proves which launch it belongs to. */
export const DESKTOP_READINESS_PROOF_PATH = "/.well-known/t3/desktop-readiness";
export const DESKTOP_READINESS_CHALLENGE_PARAM = "challenge";
export const DESKTOP_READINESS_CHALLENGE_MAX_LENGTH = 128;

const utf8 = (value: string) => new TextEncoder().encode(value);

export const desktopReadinessProof = Effect.fn("desktopReadinessProof.derive")(function* (
  secret: string,
  challenge: string,
) {
  const mac = yield* Mac.Mac;
  const key = yield* Mac.key(Mac.hmacSha256, utf8(secret));
  return Hex.encode(yield* mac.sign(key, utf8(`t3-desktop-readiness:${challenge}`)));
}, Effect.orDie);

export const isValidDesktopReadinessProof = Effect.fn("desktopReadinessProof.isValid")(function* (
  secret: string,
  challenge: string,
  proof: string,
) {
  return Mac.timingSafeEqual(
    utf8(yield* desktopReadinessProof(secret, challenge)),
    utf8(proof.trim()),
  );
});
