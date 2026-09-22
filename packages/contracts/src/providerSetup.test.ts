import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProviderAuthResponse } from "./providerSetup.ts";

const decodeResponse = Schema.decodeUnknownSync(ProviderAuthResponse);

describe("provider credential responses", () => {
  it("accepts the advertised field limit and rejects oversized or invalid fields", () => {
    const values = Object.fromEntries(
      Array.from({ length: 16 }, (_, i) => [`field_${i}`, "value"]),
    );
    expect(decodeResponse({ type: "credentials", values })).toEqual({
      type: "credentials",
      values,
    });
    expect(() =>
      decodeResponse({ type: "credentials", values: { ...values, extra: "value" } }),
    ).toThrow();
    expect(() => decodeResponse({ type: "credentials", values: { "": "value" } })).toThrow();
    expect(() =>
      decodeResponse({ type: "credentials", values: { token: "x".repeat(16_385) } }),
    ).toThrow();
  });
});
