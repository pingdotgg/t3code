import { assert, describe, it } from "@effect/vitest";

import {
  stripDesktopOriginHeaders,
  type MainWindowRequestHeaderPolicy,
} from "./RemoteRequestHeaders.ts";

const packagedPolicy: MainWindowRequestHeaderPolicy = {
  desktopOrigin: "t3code://app",
  mainWebContentsId: 42,
  clerkFrontendApiHostname: "clerk.t3.codes",
  isDevelopment: false,
};

const devPolicy: MainWindowRequestHeaderPolicy = {
  desktopOrigin: "t3code-dev://app",
  mainWebContentsId: 42,
  clerkFrontendApiHostname: "clerk.t3.codes",
  devServerOrigin: "http://devbox.internal:5733",
  isDevelopment: true,
};

describe("RemoteRequestHeaders", () => {
  it.each([
    "https://remote.example.com/.well-known/t3/environment",
    "http://127.0.0.1:8080/api/auth/bootstrap",
    "ws://127.0.0.1:8080/ws?ticket=abc",
    "wss://remote.example.com/ws?ticket=abc",
  ])("strips Origin and Sec-Fetch-* on outbound main-window %s requests", (url) => {
    const headers = stripDesktopOriginHeaders(packagedPolicy, {
      url,
      webContentsId: 42,
      frame: { parent: null },
      requestHeaders: {
        Origin: "t3code://app",
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
        "sec-fetch-user": "?1",
        Authorization: "Bearer secret",
        DPoP: "proof-jwt",
      },
    });

    assert.deepEqual(headers, {
      Authorization: "Bearer secret",
      DPoP: "proof-jwt",
    });
  });

  it("strips lowercase origin headers and allows null frames (WebSocket upgrades and workers)", () => {
    const headers = stripDesktopOriginHeaders(packagedPolicy, {
      url: "wss://remote.example.com/ws",
      webContentsId: 42,
      frame: null,
      requestHeaders: {
        origin: "t3code://app",
        "Sec-Fetch-Site": "cross-site",
        Upgrade: "websocket",
      },
    });

    assert.deepEqual(headers, {
      Upgrade: "websocket",
    });
  });

  it("preserves headers for Clerk frontend API requests", () => {
    for (const url of ["https://clerk.t3.codes/v1/client", "https://CLERK.T3.CODES./v1/client"]) {
      const headers = stripDesktopOriginHeaders(packagedPolicy, {
        url,
        webContentsId: 42,
        frame: { parent: null },
        requestHeaders: {
          Origin: "t3code://app",
          "Sec-Fetch-Site": "cross-site",
        },
      });
      assert.isUndefined(headers);
    }
  });

  it("preserves headers for dev loopback and exact devServerOrigin, while stripping other ports and remote hosts", () => {
    for (const url of [
      "http://localhost:3773/api/health",
      "http://app.localhost:3773/api/health",
      "http://127.0.0.1:3773/api/health",
      "http://[::1]:3773/api/health",
      "ws://127.0.0.1:3773/ws",
      "http://devbox.internal:5733/api/health",
      "ws://devbox.internal:5733/ws",
    ]) {
      assert.isUndefined(
        stripDesktopOriginHeaders(devPolicy, {
          url,
          webContentsId: 42,
          frame: { parent: null },
          requestHeaders: {
            Origin: "t3code-dev://app",
            "Sec-Fetch-Site": "cross-site",
          },
        }),
      );
    }

    for (const url of [
      "http://devbox.internal:8080/api/auth/bootstrap",
      "https://remote.example.com/api/auth/bootstrap",
    ]) {
      assert.deepEqual(
        stripDesktopOriginHeaders(devPolicy, {
          url,
          webContentsId: 42,
          frame: { parent: null },
          requestHeaders: {
            Origin: "t3code-dev://app",
            "Sec-Fetch-Site": "cross-site",
            "Content-Type": "application/json",
          },
        }),
        { "Content-Type": "application/json" },
      );
    }
  });

  it("never touches sandboxed iframes (Origin: null), subframes, or other webContents", () => {
    assert.isUndefined(
      stripDesktopOriginHeaders(packagedPolicy, {
        url: "https://remote.example.com/api/test",
        webContentsId: 42,
        frame: { parent: null },
        requestHeaders: {
          Origin: "null",
          "Sec-Fetch-Site": "cross-site",
        },
      }),
    );

    assert.isUndefined(
      stripDesktopOriginHeaders(packagedPolicy, {
        url: "https://remote.example.com/api/test",
        webContentsId: 42,
        frame: { parent: {} },
        requestHeaders: {
          Origin: "t3code://app",
          "Sec-Fetch-Site": "cross-site",
        },
      }),
    );

    assert.isUndefined(
      stripDesktopOriginHeaders(packagedPolicy, {
        url: "https://remote.example.com/api/test",
        webContentsId: 99,
        frame: { parent: null },
        requestHeaders: {
          Origin: "t3code://app",
          "Sec-Fetch-Site": "cross-site",
        },
      }),
    );

    assert.isUndefined(
      stripDesktopOriginHeaders(packagedPolicy, {
        url: "https://remote.example.com/api/test",
        webContentsId: undefined,
        frame: null,
        requestHeaders: {
          Origin: "t3code://app",
          "Sec-Fetch-Site": "cross-site",
        },
      }),
    );

    assert.isUndefined(
      stripDesktopOriginHeaders(packagedPolicy, {
        url: "https://remote.example.com/api/test",
        webContentsId: 42,
        frame: { parent: null },
        requestHeaders: {
          "Sec-Fetch-Site": "cross-site",
        },
      }),
    );
  });
});
