import { describe, expect, it } from "vitest";

import {
  DesktopRemoteConnectionConfigError,
  redactTokenInWsUrl,
  resolveDesktopConnectionSettingsFromEnv,
  resolveDesktopRemoteConnection,
  resolveDesktopRemoteConnectionFromEnv,
} from "./remoteConnection";

describe("resolveDesktopRemoteConnectionFromEnv", () => {
  it("returns null when remote mode is not configured", () => {
    expect(resolveDesktopRemoteConnectionFromEnv({})).toBeNull();
  });

  it("maps https remote URLs to wss with auth token", () => {
    const result = resolveDesktopRemoteConnectionFromEnv({
      T3CODE_DESKTOP_REMOTE_URL: "https://chat.example.com/t3",
      T3CODE_DESKTOP_REMOTE_AUTH_TOKEN: "secret-token",
    });

    expect(result).toEqual({
      mode: "remote",
      wsUrl: "wss://chat.example.com/t3?token=secret-token",
      httpOrigin: "https://chat.example.com",
      disableLocalBackend: true,
    });
  });

  it("preserves existing query parameters while overriding token", () => {
    const result = resolveDesktopRemoteConnectionFromEnv({
      T3CODE_DESKTOP_REMOTE_URL: "https://chat.example.com/socket?foo=1&token=old",
      T3CODE_DESKTOP_REMOTE_AUTH_TOKEN: "new-token",
    });

    expect(result).toEqual({
      mode: "remote",
      wsUrl: "wss://chat.example.com/socket?foo=1&token=new-token",
      httpOrigin: "https://chat.example.com",
      disableLocalBackend: true,
    });
  });

  it("accepts URLs that already include a token", () => {
    const result = resolveDesktopRemoteConnectionFromEnv({
      T3CODE_DESKTOP_REMOTE_URL: "wss://chat.example.com/socket?token=embedded",
    });

    expect(result).toEqual({
      mode: "remote",
      wsUrl: "wss://chat.example.com/socket?token=embedded",
      httpOrigin: "https://chat.example.com",
      disableLocalBackend: true,
    });
  });

  it("throws for missing token", () => {
    expect(() =>
      resolveDesktopRemoteConnectionFromEnv({
        T3CODE_DESKTOP_REMOTE_URL: "https://chat.example.com/socket",
      }),
    ).toThrowError(DesktopRemoteConnectionConfigError);
  });

  it("throws for invalid URLs", () => {
    expect(() =>
      resolveDesktopRemoteConnectionFromEnv({
        T3CODE_DESKTOP_REMOTE_URL: "not a url",
        T3CODE_DESKTOP_REMOTE_AUTH_TOKEN: "abc",
      }),
    ).toThrowError(DesktopRemoteConnectionConfigError);
  });

  it("throws for unsupported protocols", () => {
    expect(() =>
      resolveDesktopRemoteConnectionFromEnv({
        T3CODE_DESKTOP_REMOTE_URL: "ftp://chat.example.com/socket",
        T3CODE_DESKTOP_REMOTE_AUTH_TOKEN: "abc",
      }),
    ).toThrowError(DesktopRemoteConnectionConfigError);
  });
});

describe("redactTokenInWsUrl", () => {
  it("redacts token query params", () => {
    expect(redactTokenInWsUrl("wss://example.com/?token=abc&x=1")).toBe(
      "wss://example.com/?token=%5Bredacted%5D&x=1",
    );
  });

  it("leaves invalid URLs untouched", () => {
    expect(redactTokenInWsUrl("not-a-url")).toBe("not-a-url");
  });
});

describe("resolveDesktopConnectionSettingsFromEnv", () => {
  it("returns null when the remote URL is unset", () => {
    expect(resolveDesktopConnectionSettingsFromEnv({})).toBeNull();
  });

  it("returns normalized remote settings when configured", () => {
    expect(
      resolveDesktopConnectionSettingsFromEnv({
        T3CODE_DESKTOP_REMOTE_URL: " https://chat.example.com ",
        T3CODE_DESKTOP_REMOTE_AUTH_TOKEN: " secret-token ",
      }),
    ).toEqual({
      mode: "remote",
      remoteUrl: "https://chat.example.com",
      authToken: "secret-token",
    });
  });
});

describe("resolveDesktopRemoteConnection", () => {
  it("returns null for local mode", () => {
    expect(
      resolveDesktopRemoteConnection({
        mode: "local",
        remoteUrl: "https://chat.example.com",
        authToken: "secret-token",
      }),
    ).toBeNull();
  });
});
