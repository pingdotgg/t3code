import { describe, expect, it } from "vite-plus/test";

import {
  browserClientOs,
  browserDeviceType,
  browserFamily,
  clientPresentationMetadata,
} from "./clientMetadata";

const desktopChrome = {
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
  platform: "Win32",
  maxTouchPoints: 0,
};

describe("client telemetry metadata", () => {
  it("distinguishes hosted web from server-served web", () => {
    expect(
      clientPresentationMetadata({
        appVersion: "1.2.3",
        hosted: true,
        identity: desktopChrome,
        desktopBridge: undefined,
      }),
    ).toMatchObject({
      surface: "web",
      webDeployment: "hosted",
      deviceType: "desktop",
      os: "Windows",
      browser: "Chrome",
      appVersion: "1.2.3",
    });

    expect(
      clientPresentationMetadata({
        appVersion: "0.0.0",
        hosted: false,
        identity: desktopChrome,
        desktopBridge: undefined,
      }),
    ).toMatchObject({ surface: "web", webDeployment: "server" });
  });

  it("identifies phone and tablet browsers", () => {
    const iphone = {
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1",
      platform: "iPhone",
      maxTouchPoints: 5,
    };
    const androidTablet = {
      userAgent:
        "Mozilla/5.0 (Linux; Android 15; Pixel Tablet) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
      platform: "Linux armv8l",
      maxTouchPoints: 5,
    };
    const ipadosDesktopUa = {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15",
      platform: "MacIntel",
      maxTouchPoints: 5,
    };

    expect(browserDeviceType(iphone)).toBe("mobile");
    expect(browserClientOs(iphone)).toBe("iOS");
    expect(browserFamily(iphone.userAgent)).toBe("Safari");
    expect(browserDeviceType(androidTablet)).toBe("tablet");
    expect(browserClientOs(androidTablet)).toBe("Android");
    expect(browserDeviceType(ipadosDesktopUa)).toBe("tablet");
    expect(browserClientOs(ipadosDesktopUa)).toBe("iOS");
  });

  it("uses Electron's client platform for desktop", () => {
    expect(
      clientPresentationMetadata({
        appVersion: "1.2.3",
        hosted: false,
        identity: desktopChrome,
        desktopBridge: { getClientPlatform: () => "darwin" },
      }),
    ).toEqual({
      label: "T3 Code Desktop",
      deviceType: "desktop",
      os: "macOS",
      surface: "desktop",
      appVersion: "1.2.3",
    });
  });
});
