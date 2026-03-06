import { describe, expect, it } from "vitest";

import { detectServerRuntimeEnvironment } from "./runtimeEnvironment";

describe("detectServerRuntimeEnvironment", () => {
  it("detects native windows mode", () => {
    expect(
      detectServerRuntimeEnvironment({
        platform: "win32",
        env: {},
        osRelease: "10.0.26100",
      }),
    ).toEqual({
      platform: "windows",
      pathStyle: "windows",
      isWsl: false,
      windowsInteropMode: "windows-native",
      wslDistroName: null,
    });
  });

  it("detects wsl-hosted mode from environment variables", () => {
    expect(
      detectServerRuntimeEnvironment({
        platform: "linux",
        env: {
          WSL_DISTRO_NAME: "Ubuntu-24.04",
          WSL_INTEROP: "/run/WSL/123_interop",
        },
        osRelease: "6.6.87.2-microsoft-standard-WSL2",
      }),
    ).toEqual({
      platform: "linux",
      pathStyle: "posix",
      isWsl: true,
      windowsInteropMode: "wsl-hosted",
      wslDistroName: "Ubuntu-24.04",
    });
  });

  it("detects wsl-hosted mode from os release when env is unavailable", () => {
    expect(
      detectServerRuntimeEnvironment({
        platform: "linux",
        env: {},
        osRelease: "5.15.167.4-microsoft-standard-WSL2",
      }),
    ).toEqual({
      platform: "linux",
      pathStyle: "posix",
      isWsl: true,
      windowsInteropMode: "wsl-hosted",
      wslDistroName: null,
    });
  });

  it("leaves non-wsl posix hosts outside the windows interop modes", () => {
    expect(
      detectServerRuntimeEnvironment({
        platform: "darwin",
        env: {},
        osRelease: "24.3.0",
      }),
    ).toEqual({
      platform: "macos",
      pathStyle: "posix",
      isWsl: false,
      windowsInteropMode: null,
      wslDistroName: null,
    });
  });
});
