import { describe, expect, it } from "vite-plus/test";

import { threadRouteIsHydrating } from "./thread-route-hydration";

const settled = {
  isLoadingConnections: false,
  connectionState: "connected" as const,
  shellStatus: "live" as const,
  shellHasError: false,
  detailStatus: "live" as const,
  detailHasError: false,
};

describe("threadRouteIsHydrating", () => {
  it("waits for shell and thread detail hydration", () => {
    expect(threadRouteIsHydrating({ ...settled, shellStatus: "synchronizing" })).toBe(true);
    expect(threadRouteIsHydrating({ ...settled, shellStatus: "empty" })).toBe(true);
    expect(threadRouteIsHydrating({ ...settled, detailStatus: "synchronizing" })).toBe(true);
    expect(threadRouteIsHydrating({ ...settled, detailStatus: "empty" })).toBe(true);
  });

  it("stops waiting once an empty detail has an actionable outcome", () => {
    expect(
      threadRouteIsHydrating({
        ...settled,
        shellStatus: "empty",
        shellHasError: true,
        detailStatus: "deleted",
      }),
    ).toBe(false);
    expect(
      threadRouteIsHydrating({
        ...settled,
        detailStatus: "empty",
        detailHasError: true,
      }),
    ).toBe(false);
    expect(
      threadRouteIsHydrating({
        ...settled,
        connectionState: "available",
        detailStatus: "empty",
      }),
    ).toBe(false);
    expect(threadRouteIsHydrating({ ...settled, detailStatus: "deleted" })).toBe(false);
  });

  it("prioritizes terminal outcomes over unrelated hydration", () => {
    expect(
      threadRouteIsHydrating({
        ...settled,
        connectionState: "reconnecting",
        shellStatus: "synchronizing",
        detailStatus: "deleted",
      }),
    ).toBe(false);
    expect(
      threadRouteIsHydrating({
        ...settled,
        connectionState: "reconnecting",
        shellStatus: "synchronizing",
        detailHasError: true,
      }),
    ).toBe(false);
    expect(
      threadRouteIsHydrating({
        ...settled,
        connectionState: "offline",
        shellStatus: "synchronizing",
        detailStatus: "synchronizing",
      }),
    ).toBe(false);
  });
});
