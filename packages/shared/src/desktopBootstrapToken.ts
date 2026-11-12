import * as Mac from "effect/crypto/Mac";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";

/** Accept previous/current windows for token lifetime and the next window for WSL clock lag. */
export const DESKTOP_BOOTSTRAP_TOKEN_WINDOW_MS = 12 * 60 * 60 * 1000;

const utf8 = (value: string) => new TextEncoder().encode(value);

function windowIndex(nowMs: number): number {
  return Math.floor(nowMs / DESKTOP_BOOTSTRAP_TOKEN_WINDOW_MS);
}

// Untraced: an inner step of the named callers below, run up to three times per check.
const deriveToken = Effect.fnUntraced(function* (secret: string, window: number) {
  const mac = yield* Mac.Mac;
  const key = yield* Mac.key(Mac.hmacSha256, utf8(secret));
  return Hex.encode(yield* mac.sign(key, utf8(`t3-desktop-bootstrap:${window}`)));
}, Effect.orDie);

export const currentDesktopBootstrapToken = Effect.fn("desktopBootstrapToken.current")(
  (secret: string, nowMs: number) => deriveToken(secret, windowIndex(nowMs)),
);

export const isValidDesktopBootstrapToken = Effect.fn("desktopBootstrapToken.isValid")(function* (
  secret: string,
  token: string,
  nowMs: number,
) {
  const presented = utf8(token);
  const current = windowIndex(nowMs);
  for (const window of [current - 1, current, current + 1]) {
    if (Mac.timingSafeEqual(utf8(yield* deriveToken(secret, window)), presented)) return true;
  }
  return false;
});
