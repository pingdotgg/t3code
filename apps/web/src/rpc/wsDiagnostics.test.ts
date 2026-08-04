import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearWsDiagnosticsForTests,
  getWsDiagnostics,
  recordWsDiagnostic,
  sanitizeWsSocketUrl,
} from "./wsDiagnostics";

describe("wsDiagnostics", () => {
  beforeEach(() => {
    clearWsDiagnosticsForTests();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearWsDiagnosticsForTests();
  });

  it("strips query parameters and userinfo from socket URLs", () => {
    expect(
      sanitizeWsSocketUrl("wss://user:secret@example.com:8443/ws?wsToken=short-lived&x=1#frag"),
    ).toBe("wss://example.com:8443/ws");
    expect(sanitizeWsSocketUrl("not a url?wsToken=leak")).toBe("not a url");
  });

  it("keeps a readable reconnect timeline", () => {
    recordWsDiagnostic("ping-timeout");
    recordWsDiagnostic("protocol-connected");
    recordWsDiagnostic("streams-restarted", { subscriptions: 3 });

    expect(getWsDiagnostics().map((entry) => entry.event)).toEqual([
      "ping-timeout",
      "protocol-connected",
      "streams-restarted",
    ]);
    expect(getWsDiagnostics().at(-1)?.detail).toEqual({ subscriptions: 3 });
    expect(console.warn).toHaveBeenCalledWith("[ws] ping-timeout");
    expect(console.info).toHaveBeenCalledWith("[ws] streams-restarted", { subscriptions: 3 });
  });

  it("drops the oldest entries instead of growing without bound", () => {
    for (let index = 0; index < 250; index += 1) {
      recordWsDiagnostic("socket-open", { index });
    }

    const entries = getWsDiagnostics();
    expect(entries).toHaveLength(200);
    expect(entries[0]?.detail).toEqual({ index: 50 });
  });

  it("exposes the buffer on globalThis for support requests", () => {
    recordWsDiagnostic("socket-close", { code: 1006 });

    const read = (globalThis as { __t3WsDiagnostics?: () => readonly unknown[] }).__t3WsDiagnostics;
    expect(read?.()).toEqual(getWsDiagnostics());
  });
});
