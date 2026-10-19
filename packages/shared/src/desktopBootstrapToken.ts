// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no createHmac or timingSafeEqual.
import * as NodeCrypto from "node:crypto";

/**
 * A backend accepts the previous, current and next window's token: the previous
 * one so a token works for between one and two windows, and the next one
 * because a WSL backend's clock can trail the Windows clock that derived the
 * token, which would otherwise reject every fresh token for a moment after each
 * boundary.
 */
export const DESKTOP_BOOTSTRAP_TOKEN_WINDOW_MS = 12 * 60 * 60 * 1000;

function windowIndex(nowMs: number): number {
  return Math.floor(nowMs / DESKTOP_BOOTSTRAP_TOKEN_WINDOW_MS);
}

function deriveToken(secret: string, window: number): string {
  return NodeCrypto.createHmac("sha256", secret)
    .update(`t3-desktop-bootstrap:${window}`)
    .digest("hex");
}

export function currentDesktopBootstrapToken(secret: string, nowMs: number): string {
  return deriveToken(secret, windowIndex(nowMs));
}

export function isValidDesktopBootstrapToken(
  secret: string,
  token: string,
  nowMs: number,
): boolean {
  const presented = Buffer.from(token);
  const current = windowIndex(nowMs);
  return [current - 1, current, current + 1].some((window) => {
    const expected = Buffer.from(deriveToken(secret, window));
    return expected.length === presented.length && NodeCrypto.timingSafeEqual(expected, presented);
  });
}
