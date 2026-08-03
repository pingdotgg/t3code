import { describe, expect, it } from "@effect/vitest";

import { parseProviderAuthRouteParams } from "./providerAuthRoute";

describe("parseProviderAuthRouteParams", () => {
  it("rejects a direct provider auth deep link without route params", () => {
    expect(parseProviderAuthRouteParams(undefined)).toBeNull();
    expect(parseProviderAuthRouteParams({})).toBeNull();
  });

  it("accepts complete navigation params", () => {
    const params = {
      environmentId: "local",
      instanceId: "codex",
      displayName: "Codex",
      action: "signIn",
      sessionId: "session-1",
    } as const;

    expect(parseProviderAuthRouteParams(params)).toEqual(params);
  });
});
