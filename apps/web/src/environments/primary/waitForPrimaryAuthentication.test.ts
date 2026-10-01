import type { DesktopBridge } from "@t3tools/contracts";
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
  const listeners = new Map<string, Array<() => void>>();
  const testWindow: {
    location: URL;
    history: { replaceState: (_data: unknown, _unused: string, url: string) => void };
    desktopBridge?: DesktopBridge;
    visibilityState: "visible" | "hidden";
    listenerCount: (type: string) => number;
    dispatchTestEvent: (type: string) => void;
  } = {
    location: new URL("http://localhost/"),
    history: {
      replaceState: (_data: unknown, _unused: string, url: string) => {
        testWindow.location = new URL(url, testWindow.location.href);
      },
    },
    visibilityState: "visible",
    listenerCount: (type: string) => listeners.get(type)?.length ?? 0,
    dispatchTestEvent: (type: string) => {
      for (const listener of [...(listeners.get(type) ?? [])]) listener();
    },
  };
  const emitter = {
    addEventListener: (type: string, listener: () => void) => {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
    removeEventListener: (type: string, listener: () => void) => {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((entry) => entry !== listener),
      );
    },
  };
  Object.assign(testWindow, emitter);
  vi.stubGlobal("window", testWindow);
  vi.stubGlobal("document", {
    title: "T3 Code",
    get visibilityState() {
      return testWindow.visibilityState;
    },
    addEventListener: emitter.addEventListener,
    removeEventListener: emitter.removeEventListener,
  });
  return testWindow;
}

describe("waitForPrimaryAuthentication", () => {
  let testWindow: ReturnType<typeof installTestWindow>;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    testWindow = installTestWindow();
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

  it("re-checks when the tab regains focus after pairing elsewhere", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(unauthenticatedSessionResponse())
      .mockResolvedValue(authenticatedSessionResponse());
    vi.stubGlobal("fetch", fetchMock);

    let settled = false;
    const pending = waitForPrimaryAuthentication().then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(testWindow.listenerCount("focus")).toBeGreaterThan(0));
    expect(settled).toBe(false);

    testWindow.dispatchTestEvent("focus");
    await pending;
    expect(settled).toBe(true);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(testWindow.listenerCount("focus")).toBe(0);
  });

  it("triggers the bootstrap exchange only once across sequential waiters", async () => {
    testWindow.desktopBridge = {
      getLocalEnvironmentBootstrap: () => ({
        label: "Local environment",
        httpBaseUrl: "http://localhost/",
        wsBaseUrl: "ws://localhost/",
        bootstrapToken: "desktop-bootstrap-token",
      }),
    } as DesktopBridge;
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const href = String(url);
      if (href.endsWith("/api/auth/session")) return unauthenticatedSessionResponse();
      if (href.endsWith("/api/auth/bootstrap")) {
        return jsonResponse({ error: "Invalid bootstrap credential." }, { status: 401 });
      }
      throw new Error(`unexpected fetch ${href}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const bootstrapPosts = () =>
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/api/auth/bootstrap"));

    const first = waitForPrimaryAuthentication();
    for (let attempt = 0; attempt < 100 && bootstrapPosts().length < 1; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(bootstrapPosts()).toHaveLength(1);
    const second = waitForPrimaryAuthentication();
    // Both waiters must be parked before the wake: a waiter created after a
    // flush would otherwise sleep until the backstop re-check.
    await vi.waitFor(() => expect(testWindow.listenerCount("focus")).toBe(2));
    expect(bootstrapPosts()).toHaveLength(1);

    // Settle both waiters through the focus wake so nothing dangles. A fresh
    // Response per call: bodies are single-use, and a shared one would fail
    // the second consumer with a transient TypeError retry storm.
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => authenticatedSessionResponse()),
    );
    testWindow.dispatchTestEvent("focus");
    expect(testWindow.listenerCount("focus")).toBe(0);
    await first;
    await second;
  });
});
