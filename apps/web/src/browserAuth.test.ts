import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearBootstrapTokenFromUrl,
  consumeBootstrapTokenFromHash,
  ensureBrowserPairing,
  resolveServerHttpOrigin,
} from "./browserAuth";

describe("browserAuth", () => {
  const fetchMock = vi.fn<typeof fetch>();
  const setTestWindow = (href: string) => {
    let currentUrl = new URL(href);
    const location = {
      get hash() {
        return currentUrl.hash;
      },
      get host() {
        return currentUrl.host;
      },
      get hostname() {
        return currentUrl.hostname;
      },
      get href() {
        return currentUrl.toString();
      },
      get origin() {
        return currentUrl.origin;
      },
      get pathname() {
        return currentUrl.pathname;
      },
      get port() {
        return currentUrl.port;
      },
      get protocol() {
        return currentUrl.protocol;
      },
      get search() {
        return currentUrl.search;
      },
      toString() {
        return currentUrl.toString();
      },
    };
    const history = {
      state: {} as unknown,
      replaceState: (state: unknown, _unused: string, nextUrl?: string | URL | null) => {
        history.state = state;
        if (!nextUrl) return;
        currentUrl = new URL(String(nextUrl));
      },
    };
    vi.stubGlobal("window", {
      location,
      history,
      nativeApi: undefined,
      desktopBridge: undefined,
    });
  };

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    setTestWindow("http://localhost:3773/");
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads and clears bootstrap tokens from the url hash", () => {
    setTestWindow("http://localhost:3773/#t3_bootstrap=pair-me");

    expect(consumeBootstrapTokenFromHash()).toBe("pair-me");

    clearBootstrapTokenFromUrl();

    expect(window.location.hash).toBe("");
    expect(consumeBootstrapTokenFromHash()).toBeNull();
  });

  it("resolves the server http origin from the current location when no ws override exists", () => {
    setTestWindow("http://localhost:4123/chat");

    expect(resolveServerHttpOrigin()).toBe("http://localhost:4123");
  });

  it("exchanges a bootstrap token before checking the auth session", async () => {
    setTestWindow("http://localhost:3773/#t3_bootstrap=pair-me");
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, {
          status: 204,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ authenticated: true }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        }),
      );

    await expect(ensureBrowserPairing()).resolves.toBe(true);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://localhost:3773/api/auth/bootstrap",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://localhost:3773/api/auth/session",
      expect.objectContaining({
        credentials: "include",
      }),
    );
    expect(window.location.hash).toBe("");
  });

  it("polls auth session after a successful bootstrap until the cookie is visible", async () => {
    setTestWindow("http://localhost:3773/#t3_bootstrap=pair-me");
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, {
          status: 204,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ authenticated: false }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ authenticated: false }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ authenticated: true }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        }),
      );

    await expect(ensureBrowserPairing()).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(window.location.hash).toBe("");
  });

  it("returns false when bootstrap exchange fails", async () => {
    setTestWindow("http://localhost:3773/#t3_bootstrap=pair-me");
    fetchMock.mockResolvedValueOnce(
      new Response("nope", {
        status: 401,
      }),
    );

    await expect(ensureBrowserPairing()).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe("#t3_bootstrap=pair-me");
  });

  it("checks the existing auth session when no bootstrap token is present", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ authenticated: false }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      }),
    );

    await expect(ensureBrowserPairing()).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3773/api/auth/session",
      expect.objectContaining({
        credentials: "include",
      }),
    );
  });

  it("bypasses browser pairing when the electron desktop bridge is available", async () => {
    vi.stubGlobal("window", {
      location: {
        href: "file:///app/index.html",
        origin: "file://",
        hash: "",
      },
      history: {
        state: undefined,
        replaceState: vi.fn(),
      },
      nativeApi: undefined,
      desktopBridge: {
        getWsUrl: () => "ws://127.0.0.1:3773",
      },
    });

    await expect(ensureBrowserPairing()).resolves.toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
