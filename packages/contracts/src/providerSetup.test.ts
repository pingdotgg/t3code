import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProviderAuthState } from "./providerSetup.ts";

const decodeState = Schema.decodeUnknownSync(ProviderAuthState);

describe("provider auth state", () => {
  it("drops auth variants from newer servers instead of rejecting the state", () => {
    const method = { id: "browser", name: "Browser", description: null, type: "agent" };
    expect(
      decodeState({
        instanceId: "cursor",
        phase: "waiting",
        flowId: null,
        authorizationUrl: null,
        expiresAt: null,
        message: null,
        methods: [method, { ...method, id: "passkey", type: "passkey" }],
        interaction: { type: "passkey", id: "passkey" },
        credentialOwner: "keychain",
      }),
    ).toEqual({
      instanceId: "cursor",
      phase: "waiting",
      flowId: null,
      authorizationUrl: null,
      expiresAt: null,
      message: null,
      methods: [method],
    });
  });

  it("refuses sign-in URLs that are not web pages", () => {
    const state = {
      instanceId: "cursor",
      phase: "waiting",
      flowId: "flow",
      authorizationUrl: null,
      expiresAt: null,
      message: null,
    };
    const script = "javascript:alert(document.domain)";
    expect(
      decodeState({
        ...state,
        interaction: { type: "browser", id: "b", url: script, requiresConsent: true },
      }),
    ).toEqual(state);
    expect(
      decodeState({
        ...state,
        interaction: { type: "deviceCode", id: "d", url: script, userCode: "ABCD" },
      }),
    ).toEqual(state);
    expect(() => decodeState({ ...state, authorizationUrl: script })).toThrow();
    expect(
      decodeState({ ...state, authorizationUrl: "https://cursor.com/login" }).authorizationUrl,
    ).toBe("https://cursor.com/login");
  });
});
