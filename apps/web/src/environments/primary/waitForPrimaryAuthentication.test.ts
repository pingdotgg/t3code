import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetServerAuthBootstrapForTests,
  submitServerAuthCredential,
  waitForPrimaryAuthentication,
} from "./auth";

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
    },
    status: 200,
    ...init,
  });
}

function unauthenticatedSessionResponse() {
  return jsonResponse({
    authenticated: false,
    auth: {
      policy: "loopback-browser",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["browser-session-cookie"],
      sessionCookieName: "t3_session",
    },
  });
}

function authenticatedSessionResponse() {
  return jsonResponse({
    authenticated: true,
    auth: {
      policy: "loopback-browser",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["browser-session-cookie"],
      sessionCookieName: "t3_session",
    },
    sessionMethod: "browser-session-cookie",
    expiresAt: "2026-04-05T00:00:00.000Z",
  });
}

function installTestWindow() {
  const testWindow = {
    location: new URL("http://localhost/"),
    history: {
      replaceState: (_data: unknown, _unused: string, url: string) => {
        testWindow.location = new URL(url, testWindow.location.href);
      },
    },
  };
  vi.stubGlobal("window", testWindow);
  vi.stubGlobal("document", { title: "T3 Code" });
}

describe("waitForPrimaryAuthentication", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    installTestWindow();
  });

  afterEach(() => {
    __resetServerAuthBootstrapForTests();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("resolves immediately when the session is already authenticated", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(authenticatedSessionResponse());
    vi.stubGlobal("fetch", fetchMock);

    await waitForPrimaryAuthentication();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("waits while pairing is required and resolves after a successful submit", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(unauthenticatedSessionResponse())
      .mockResolvedValueOnce(jsonResponse({ authenticated: true }))
      .mockResolvedValueOnce(authenticatedSessionResponse())
      .mockResolvedValueOnce(authenticatedSessionResponse());
    vi.stubGlobal("fetch", fetchMock);

    let settled = false;
    const pending = waitForPrimaryAuthentication().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await submitServerAuthCredential("fresh-token");
    await pending;
    expect(settled).toBe(true);
  });

  it("falls through when the session check itself is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ error: "boom" }, { status: 500 })),
    );

    await waitForPrimaryAuthentication();
  });

  it("re-checks after the interval when pairing completes without a submit", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(unauthenticatedSessionResponse())
      .mockResolvedValue(authenticatedSessionResponse());
    vi.stubGlobal("fetch", fetchMock);

    let settled = false;
    const pending = waitForPrimaryAuthentication().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
    expect(settled).toBe(true);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });
});
