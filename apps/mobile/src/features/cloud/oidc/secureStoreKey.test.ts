import { describe, expect, it } from "vite-plus/test";

import { secureStoreKey } from "./secureStoreKey";

describe("secureStoreKey", () => {
  it("keeps keys apart that differ only in characters SecureStore refuses", () => {
    const keys = [
      "t3-oidc-session:https://sso.example.com/a:b",
      "t3-oidc-session:https://sso.example.com/a/b",
      "t3-oidc-session:https://sso.example.com/a_b",
    ];
    const stored = keys.map(secureStoreKey);

    expect(new Set(stored).size).toBe(keys.length);
    for (const key of stored) expect(key).toMatch(/^[\w.-]+$/u);
  });
});
