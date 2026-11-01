import { describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => {
  class SdkError extends Error {}
  const sdk = {
    CursorSdkError: SdkError,
    AuthenticationError: SdkError,
    ConfigurationError: SdkError,
  };
  const sqlite = { SqliteLocalAgentStore: {} };
  const requireSdk = vi.fn((id: string) => (id === "@cursor/sdk" ? sdk : sqlite));
  return { sdk, sqlite, requireSdk };
});

vi.mock("node:module", () => ({ createRequire: () => fixture.requireSdk }));

describe("Cursor disk modules", () => {
  it("loads on demand, shares exports across callers, and leaves SQLite unloaded", async () => {
    vi.resetModules();
    fixture.requireSdk.mockClear();
    const sdk = await import("./sdk.ts");
    expect(fixture.requireSdk).not.toHaveBeenCalled();
    expect(sdk.isCursorSdkError(new Error("unloaded"), "CursorSdkError")).toBe(false);
    const modules = await Promise.all([
      Promise.resolve().then(sdk.loadCursorSdk),
      Promise.resolve().then(sdk.loadCursorSdk),
    ]);
    expect(modules).toEqual([fixture.sdk, fixture.sdk]);
    expect(modules[0]).toBe(modules[1]);
    expect(fixture.requireSdk.mock.calls).toEqual([["@cursor/sdk"]]);
    expect(
      sdk.isCursorSdkError(new fixture.sdk.CursorSdkError("same class"), "CursorSdkError"),
    ).toBe(true);
    expect(sdk.loadCursorSqlite()).toBe(fixture.sqlite);
    expect(sdk.loadCursorSqlite()).toBe(fixture.sqlite);
    expect(fixture.requireSdk.mock.calls).toEqual([["@cursor/sdk"], ["@cursor/sdk/sqlite"]]);
  });

  it("surfaces failed loads and permits a later retry without caching partial exports", async () => {
    vi.resetModules();
    fixture.requireSdk.mockClear();
    const sdk = await import("./sdk.ts");
    const failure = new Error("missing native chunk");
    fixture.requireSdk.mockImplementationOnce(() => {
      throw failure;
    });
    expect(sdk.loadCursorSdk).toThrow(failure);
    expect(sdk.isCursorSdkError(failure, "CursorSdkError")).toBe(false);
    expect(sdk.loadCursorSdk()).toBe(fixture.sdk);
    fixture.requireSdk.mockImplementationOnce(() => {
      throw failure;
    });
    expect(sdk.loadCursorSqlite).toThrow(failure);
    expect(sdk.loadCursorSqlite()).toBe(fixture.sqlite);
    expect(fixture.requireSdk).toHaveBeenCalledTimes(4);
  });
});
