import { assert, describe, it } from "@effect/vitest";

import { getUrlDiagnostics } from "./urlDiagnostics.ts";

describe("getUrlDiagnostics", () => {
  it("retains only input length, protocol, and hostname for valid URLs", () => {
    const input =
      "https://user:password@example.com:8443/private/path?access_token=secret#fragment";

    assert.deepStrictEqual(getUrlDiagnostics(input), {
      inputLength: input.length,
      protocol: "https:",
      hostname: "example.com",
    });
  });

  it("returns only input length for invalid URLs", () => {
    const input = "not a URL?access_token=secret";

    assert.deepStrictEqual(getUrlDiagnostics(input), {
      inputLength: input.length,
    });
  });
});
