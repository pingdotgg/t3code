import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import {
  threadDetailErrorIsCurrent,
  threadRouteIsHydrating,
  threadRouteOpensDraft,
} from "./thread-route-hydration";

const settled = {
  isLoadingConnections: false,
  environmentRegistered: true,
  localCacheRead: true,
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

  it("waits for the local cache before trusting an offline connection", () => {
    const offline = {
      ...settled,
      connectionState: "offline" as const,
      detailStatus: "empty" as const,
    };
    expect(threadRouteIsHydrating({ ...offline, localCacheRead: false })).toBe(true);
    expect(threadRouteIsHydrating(offline)).toBe(false);
    expect(threadRouteIsHydrating({ ...offline, connectionState: "reconnecting" })).toBe(false);
    expect(threadRouteIsHydrating({ ...offline, connectionState: "connecting" })).toBe(true);
    expect(
      threadRouteIsHydrating({ ...offline, localCacheRead: false, environmentRegistered: false }),
    ).toBe(false);
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

describe("threadRouteOpensDraft", () => {
  it("keeps the route while a reconnecting environment may still deliver the thread", () => {
    expect(threadRouteOpensDraft({ connectionState: "reconnecting", detailStatus: "empty" })).toBe(
      false,
    );
  });

  it("keeps the route while Reconnect retries a thread that failed to sync", () => {
    const failedDetail = {
      ...settled,
      connectionState: "connecting" as const,
      detailStatus: "empty" as const,
      detailHasError: true,
    };
    expect(threadRouteIsHydrating(failedDetail)).toBe(false);
    expect(threadRouteOpensDraft(failedDetail)).toBe(false);
  });

  it("opens a draft once the thread can't arrive", () => {
    expect(
      threadRouteOpensDraft({ connectionState: "reconnecting", detailStatus: "deleted" }),
    ).toBe(true);
    expect(threadRouteOpensDraft({ connectionState: "offline", detailStatus: "empty" })).toBe(true);
  });
});

describe("threadDetailErrorIsCurrent", () => {
  const oldError = Option.some("Could not synchronize the thread.");

  it("ignores the error a thread kept from before the connection came back", () => {
    const detailHasError = threadDetailErrorIsCurrent({
      connectionState: "connected",
      error: oldError,
      errorBeforeConnected: oldError,
    });
    expect(detailHasError).toBe(false);
    expect(threadRouteIsHydrating({ ...settled, detailStatus: "empty", detailHasError })).toBe(
      true,
    );
  });

  it("counts an error the live connection reported", () => {
    expect(
      threadDetailErrorIsCurrent({
        connectionState: "connected",
        error: Option.some("Could not synchronize the thread."),
        errorBeforeConnected: oldError,
      }),
    ).toBe(true);
    expect(
      threadDetailErrorIsCurrent({
        connectionState: "reconnecting",
        error: oldError,
        errorBeforeConnected: oldError,
      }),
    ).toBe(true);
  });
});
