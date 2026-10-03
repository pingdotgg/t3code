import { describe, expect, it } from "vitest";

import { DEV_PROXIED_PATH_PREFIXES, isDevProxiedPath } from "./devProxy.ts";

describe("development proxy routes", () => {
  it("keeps Vite and the development server on the same backend path list", () => {
    expect(DEV_PROXIED_PATH_PREFIXES).toEqual([
      "/api",
      "/oauth",
      "/.well-known",
      "/ws",
      "/attachments",
    ]);
  });

  it("matches proxied paths without matching similarly-prefixed routes", () => {
    for (const prefix of DEV_PROXIED_PATH_PREFIXES) {
      expect(isDevProxiedPath(prefix)).toBe(true);
      expect(isDevProxiedPath(`${prefix}/nested`)).toBe(true);
    }

    expect(isDevProxiedPath("/wss")).toBe(false);
    expect(isDevProxiedPath("/apiary")).toBe(false);
    expect(isDevProxiedPath("/oauthish")).toBe(false);
    expect(isDevProxiedPath("/arbitrary-page")).toBe(false);
  });
});
