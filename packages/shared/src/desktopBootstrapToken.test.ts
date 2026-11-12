// @effect-diagnostics-next-line nodeBuiltinImport:off -- Older desktops derive the token with Node's HMAC.
import * as NodeCrypto from "node:crypto";

import * as PlatformNodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  DESKTOP_BOOTSTRAP_TOKEN_WINDOW_MS,
  currentDesktopBootstrapToken,
  isValidDesktopBootstrapToken,
} from "./desktopBootstrapToken.ts";

const SECRET = "desktop-secret";
const WINDOW = DESKTOP_BOOTSTRAP_TOKEN_WINDOW_MS;

describe("desktop bootstrap token", () => {
  it.effect("rotates every window and stays accepted for one more", () =>
    Effect.gen(function* () {
      const issuedAt = 10 * WINDOW + 1;
      const token = yield* currentDesktopBootstrapToken(SECRET, issuedAt);

      expect(token).toBe(
        NodeCrypto.createHmac("sha256", SECRET).update("t3-desktop-bootstrap:10").digest("hex"),
      );
      expect(yield* currentDesktopBootstrapToken(SECRET, issuedAt + WINDOW)).not.toBe(token);
      expect(yield* isValidDesktopBootstrapToken(SECRET, token, issuedAt)).toBe(true);
      expect(yield* isValidDesktopBootstrapToken(SECRET, token, issuedAt + WINDOW)).toBe(true);
      expect(yield* isValidDesktopBootstrapToken(SECRET, token, issuedAt + 2 * WINDOW)).toBe(false);
    }).pipe(Effect.provide(PlatformNodeCrypto.layerMac)),
  );

  it.effect("accepts a token from a desktop clock slightly ahead of the backend", () =>
    Effect.gen(function* () {
      const desktopNow = 10 * WINDOW + 500;
      const backendNow = 10 * WINDOW - 500;
      const ahead = yield* currentDesktopBootstrapToken(SECRET, desktopNow);
      const tooFarAhead = yield* currentDesktopBootstrapToken(SECRET, desktopNow + WINDOW);

      expect(yield* isValidDesktopBootstrapToken(SECRET, ahead, backendNow)).toBe(true);
      expect(yield* isValidDesktopBootstrapToken(SECRET, tooFarAhead, backendNow)).toBe(false);
    }).pipe(Effect.provide(PlatformNodeCrypto.layerMac)),
  );

  it.effect("rejects tokens derived from another secret", () =>
    Effect.gen(function* () {
      const token = yield* currentDesktopBootstrapToken("other-secret", WINDOW);

      expect(yield* isValidDesktopBootstrapToken(SECRET, token, WINDOW)).toBe(false);
      expect(yield* isValidDesktopBootstrapToken(SECRET, "short", WINDOW)).toBe(false);
    }).pipe(Effect.provide(PlatformNodeCrypto.layerMac)),
  );
});
