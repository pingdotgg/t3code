import { describe, expect, it } from "vite-plus/test";

import {
  getHardwareBackFallback,
  hasHardwareBackTarget,
  parseActiveThreadPath,
} from "./hardwareKeyboardCommands";

describe("parseActiveThreadPath", () => {
  it("extracts the active thread from thread subroutes", () => {
    expect(parseActiveThreadPath("/threads/environment-1/thread-1/files/src/index.ts")).toEqual({
      environmentId: "environment-1",
      threadId: "thread-1",
    });
  });

  it("decodes route components", () => {
    expect(parseActiveThreadPath("/threads/local%20machine/thread%2Fone/review")).toEqual({
      environmentId: "local machine",
      threadId: "thread/one",
    });
  });

  it("ignores non-thread routes", () => {
    expect(parseActiveThreadPath("/settings")).toBeNull();
    expect(parseActiveThreadPath("/threads/environment-only")).toBeNull();
  });

  it("ignores malformed encoded route components", () => {
    expect(parseActiveThreadPath("/threads/%E0%A4%A/thread-1")).toBeNull();
  });

  it("ignores search and hash suffixes", () => {
    expect(parseActiveThreadPath("/threads/environment-1/thread-1?panel=details#turn-2")).toEqual({
      environmentId: "environment-1",
      threadId: "thread-1",
    });
  });
});

describe("hasHardwareBackTarget", () => {
  it("keeps hardware Back available for a cold-start thread", () => {
    expect(hasHardwareBackTarget("/threads/environment-1/thread-1", false)).toBe(true);
    expect(hasHardwareBackTarget("/settings", false)).toBe(false);
    expect(hasHardwareBackTarget("/settings", true)).toBe(true);
  });
});

describe("getHardwareBackFallback", () => {
  it("returns Home from a cold-start thread root", () => {
    expect(getHardwareBackFallback("/threads/environment-1/thread-1")).toEqual({ route: "Home" });
    expect(getHardwareBackFallback("/threads/environment-1/thread-1?panel=details")).toEqual({
      route: "Home",
    });
  });

  it("returns the thread from a cold-start thread subroute", () => {
    expect(getHardwareBackFallback("/threads/environment-1/thread-1/files/src/index.ts")).toEqual({
      route: "Thread",
      params: { environmentId: "environment-1", threadId: "thread-1" },
    });
    expect(
      getHardwareBackFallback("/threads/environment-1/thread-1/review?file=README.md"),
    ).toEqual({
      route: "Thread",
      params: { environmentId: "environment-1", threadId: "thread-1" },
    });
  });

  it("returns no fallback outside a thread", () => {
    expect(getHardwareBackFallback("/settings")).toBeNull();
  });
});
