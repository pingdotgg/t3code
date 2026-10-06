import { describe, expect, it } from "vite-plus/test";

import {
  DESKTOP_BOOTSTRAP_TOKEN_WINDOW_MS,
  currentDesktopBootstrapToken,
  isValidDesktopBootstrapToken,
} from "./desktopBootstrapToken.ts";

const SECRET = "desktop-secret";
const WINDOW = DESKTOP_BOOTSTRAP_TOKEN_WINDOW_MS;

describe("desktop bootstrap token", () => {
  it("rotates every window and stays accepted for one more", () => {
    const issuedAt = 10 * WINDOW + 1;
    const token = currentDesktopBootstrapToken(SECRET, issuedAt);

    expect(currentDesktopBootstrapToken(SECRET, issuedAt + WINDOW)).not.toBe(token);
    expect(isValidDesktopBootstrapToken(SECRET, token, issuedAt)).toBe(true);
    expect(isValidDesktopBootstrapToken(SECRET, token, issuedAt + WINDOW)).toBe(true);
    expect(isValidDesktopBootstrapToken(SECRET, token, issuedAt + 2 * WINDOW)).toBe(false);
  });

  it("accepts a token from a desktop clock slightly ahead of the backend", () => {
    // Windows crossed the boundary, the WSL clock has not yet.
    const desktopNow = 10 * WINDOW + 500;
    const backendNow = 10 * WINDOW - 500;

    expect(
      isValidDesktopBootstrapToken(
        SECRET,
        currentDesktopBootstrapToken(SECRET, desktopNow),
        backendNow,
      ),
    ).toBe(true);
    expect(
      isValidDesktopBootstrapToken(
        SECRET,
        currentDesktopBootstrapToken(SECRET, desktopNow + WINDOW),
        backendNow,
      ),
    ).toBe(false);
  });

  it("rejects tokens derived from another secret", () => {
    const token = currentDesktopBootstrapToken("other-secret", WINDOW);

    expect(isValidDesktopBootstrapToken(SECRET, token, WINDOW)).toBe(false);
    expect(isValidDesktopBootstrapToken(SECRET, "short", WINDOW)).toBe(false);
  });
});
