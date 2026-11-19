import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProviderAuthState, ProviderInstallState } from "./providerSetup.ts";

const decodeState = Schema.decodeUnknownSync(ProviderAuthState);
const decodeInstallState = Schema.decodeUnknownSync(ProviderInstallState);

it("accepts installation state from servers that predate startup diagnostics", () => {
  const state = {
    driver: "codex",
    operationId: "attempt",
    phase: "failed",
    downloadedBytes: 0,
    totalBytes: null,
    version: null,
    installedVersion: null,
    canRemove: false,
    message: "Verification failed.",
  };
  expect(decodeInstallState(state)).toEqual(state);
});

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
