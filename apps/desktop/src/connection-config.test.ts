import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { describe, expect, it } from "vitest";

import {
  DesktopConnectionConfigError,
  buildDesktopRemoteWsUrl,
  getDefaultDesktopConnectionSettings,
  readDesktopConnectionSettings,
  resolveDesktopConnectionConfigPath,
  validateDesktopConnectionSettings,
  writeDesktopConnectionSettings,
} from "./connection-config";

describe("connection-config", () => {
  it("returns local defaults when no config exists", () => {
    const configPath = Path.join(process.cwd(), "missing", "desktop-connection.json");

    expect(readDesktopConnectionSettings(configPath)).toEqual(getDefaultDesktopConnectionSettings());
  });

  it("builds a websocket url from a remote http url", () => {
    expect(
      buildDesktopRemoteWsUrl({
        mode: "remote",
        remoteUrl: "http://100.64.0.10:3773",
        remoteAuthToken: "secret token",
      }),
    ).toBe("ws://100.64.0.10:3773/?token=secret+token");
  });

  it("builds a secure websocket url from a remote https url", () => {
    expect(
      buildDesktopRemoteWsUrl({
        mode: "remote",
        remoteUrl: "https://example.com/t3",
        remoteAuthToken: "abc123",
      }),
    ).toBe("wss://example.com/?token=abc123");
  });

  it("allows remote mode without an auth token", () => {
    expect(
      validateDesktopConnectionSettings({
        mode: "remote",
        remoteUrl: "http://100.64.0.10:3773",
        remoteAuthToken: "",
      }),
    ).toEqual({
      mode: "remote",
      remoteUrl: "http://100.64.0.10:3773/",
      remoteAuthToken: "",
    });
  });

  it("omits the token query param when no remote auth token is configured", () => {
    expect(
      buildDesktopRemoteWsUrl({
        mode: "remote",
        remoteUrl: "http://100.64.0.10:3773",
        remoteAuthToken: "",
      }),
    ).toBe("ws://100.64.0.10:3773/");
  });

  it("rejects missing remote url in remote mode", () => {
    expect(() =>
      validateDesktopConnectionSettings({
        mode: "remote",
        remoteUrl: "",
        remoteAuthToken: "",
      }),
    ).toThrow(DesktopConnectionConfigError);
  });

  it("writes validated settings to disk", () => {
    const tempRoot = FS.mkdtempSync(Path.join(OS.tmpdir(), "t3code-connection-config-"));
    const configPath = resolveDesktopConnectionConfigPath(tempRoot);

    const saved = writeDesktopConnectionSettings(configPath, {
      mode: "remote",
      remoteUrl: "http://100.64.0.10:3773",
      remoteAuthToken: "abc123",
    });

    expect(saved).toEqual({
      mode: "remote",
      remoteUrl: "http://100.64.0.10:3773/",
      remoteAuthToken: "abc123",
    });
    expect(readDesktopConnectionSettings(configPath)).toEqual(saved);
  });
});
