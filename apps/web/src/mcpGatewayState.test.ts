import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  getMcpGatewayGrants,
  getMcpGatewayPort,
  setMcpGatewayPort,
  MCP_GATEWAY_CONFIGURABLE_SCOPES,
  getMcpGatewayToken,
  MCP_GATEWAY_GRANTS_KEY,
  MCP_GATEWAY_TOKEN_KEY,
  setMcpGatewayGrants,
} from "./mcpGatewayState";

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

describe("MCP gateway grants", () => {
  let localStorage: Storage;
  let sessionStorage: Storage;

  beforeEach(() => {
    localStorage = storage();
    sessionStorage = storage();
    vi.stubGlobal("window", {
      localStorage,
      sessionStorage,
      desktopBridge: {
        getMcpGatewayBridgeToken: () => "desktop-token-123456",
      },
      dispatchEvent: vi.fn(),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("persists a custom loopback bridge port and rejects invalid ports", () => {
    expect(getMcpGatewayPort()).toBe(47631);
    setMcpGatewayPort(47632);
    expect(getMcpGatewayPort()).toBe(47632);
    for (const invalid of [0, 65536, 1.5, NaN]) expect(() => setMcpGatewayPort(invalid)).toThrow();
    expect(getMcpGatewayPort()).toBe(47632);
  });

  it("persists scopes under exact registry environment ids and defaults to no grants", () => {
    expect(getMcpGatewayGrants()).toEqual({});

    setMcpGatewayGrants({
      "a534b83f-a352-44d8-aedc-c4230c179390": ["read", "create", "send"],
      "2549ba75-2a91-4554-8baa-88e6ae0efa48": ["read"],
    });

    expect(JSON.parse(localStorage.getItem(MCP_GATEWAY_GRANTS_KEY) ?? "null")).toEqual({
      "a534b83f-a352-44d8-aedc-c4230c179390": ["read", "create", "send"],
      "2549ba75-2a91-4554-8baa-88e6ae0efa48": ["read"],
    });
    expect(getMcpGatewayGrants()).toEqual({
      "a534b83f-a352-44d8-aedc-c4230c179390": ["read", "create", "send"],
      "2549ba75-2a91-4554-8baa-88e6ae0efa48": ["read"],
    });
  });

  it("drops malformed persisted grant entries instead of granting access", () => {
    localStorage.setItem(
      MCP_GATEWAY_GRANTS_KEY,
      JSON.stringify({
        primary: ["read", "unknown-scope"],
        "a534b83f-a352-44d8-aedc-c4230c179390": ["read", "read", "send"],
        "2549ba75-2a91-4554-8baa-88e6ae0efa48": "read",
      }),
    );

    expect(getMcpGatewayGrants()).toEqual({
      "a534b83f-a352-44d8-aedc-c4230c179390": ["read", "send"],
    });
  });

  it("uses the desktop credential only when the session has no explicit token", () => {
    expect(getMcpGatewayToken()).toBe("desktop-token-123456");

    sessionStorage.setItem(MCP_GATEWAY_TOKEN_KEY, "session-token-123456");
    expect(getMcpGatewayToken()).toBe("session-token-123456");
  });

  it("preserves every explicit v3 scope across save and reload", () => {
    expect(MCP_GATEWAY_CONFIGURABLE_SCOPES).toEqual([
      "read",
      "create",
      "send",
      "control",
      "lifecycle",
      "approval",
      "artifact",
      "review",
      "admin",
      "delivery",
    ]);
    setMcpGatewayGrants({
      "a534b83f-a352-44d8-aedc-c4230c179390": [...MCP_GATEWAY_CONFIGURABLE_SCOPES],
    });

    expect(JSON.parse(localStorage.getItem(MCP_GATEWAY_GRANTS_KEY) ?? "null")).toEqual({
      "a534b83f-a352-44d8-aedc-c4230c179390": MCP_GATEWAY_CONFIGURABLE_SCOPES,
    });
    expect(getMcpGatewayGrants()).toEqual({
      "a534b83f-a352-44d8-aedc-c4230c179390": MCP_GATEWAY_CONFIGURABLE_SCOPES,
    });
  });
});
