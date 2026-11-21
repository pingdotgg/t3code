import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import {
  threadDetailErrorIsCurrent,
  threadRouteAwaitsConnection,
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

describe("threadRouteAwaitsConnection", () => {
  const missing = {
    connectionState: "available" as const,
    environmentEnabled: true,
    detailStatus: "empty" as const,
    graceExpired: false,
  };

  it("keeps a linked thread loading while its environment has not connected yet", () => {
    expect(threadRouteAwaitsConnection(missing)).toBe(true);
    expect(threadRouteAwaitsConnection({ ...missing, connectionState: "offline" })).toBe(true);
    expect(threadRouteAwaitsConnection({ ...missing, connectionState: "reconnecting" })).toBe(true);
    expect(
      threadRouteAwaitsConnection({
        ...missing,
        connectionState: "offline",
        detailStatus: "cached",
      }),
    ).toBe(true);
  });

  it("stops waiting once the grace period ends", () => {
    expect(threadRouteAwaitsConnection({ ...missing, graceExpired: true })).toBe(false);
    expect(
      threadRouteAwaitsConnection({
        ...missing,
        connectionState: "reconnecting",
        graceExpired: true,
      }),
    ).toBe(false);
  });

  it("does not wait for a thread the environment reported deleted", () => {
    expect(threadRouteAwaitsConnection({ ...missing, detailStatus: "deleted" })).toBe(false);
  });

  it("does not wait for an environment that won't connect by itself", () => {
    expect(threadRouteAwaitsConnection({ ...missing, environmentEnabled: false })).toBe(false);
    expect(threadRouteAwaitsConnection({ ...missing, connectionState: "error" })).toBe(false);
    expect(threadRouteAwaitsConnection({ ...missing, connectionState: "unsupported" })).toBe(false);
  });

  it("leaves a connecting or connected environment to the hydration check", () => {
    expect(threadRouteAwaitsConnection({ ...missing, connectionState: "connecting" })).toBe(false);
    expect(threadRouteAwaitsConnection({ ...missing, connectionState: "connected" })).toBe(false);
    expect(
      threadRouteIsHydrating({ ...settled, connectionState: "connecting", detailStatus: "empty" }),
    ).toBe(true);
    expect(threadRouteIsHydrating({ ...settled, detailStatus: "empty" })).toBe(true);
  });
});

describe("threadRouteOpensDraft", () => {
  it("never replaces a linked thread the app hasn't loaded with a draft", () => {
    expect(threadRouteOpensDraft({ detailStatus: "empty", threadWasShown: false })).toBe(false);
    expect(threadRouteOpensDraft({ detailStatus: "deleted", threadWasShown: false })).toBe(false);
  });

  it("keeps a shown thread's route unless the environment reported it deleted", () => {
    expect(threadRouteOpensDraft({ detailStatus: "empty", threadWasShown: true })).toBe(false);
    expect(threadRouteOpensDraft({ detailStatus: "cached", threadWasShown: true })).toBe(false);
  });

  it("opens a draft in place of a shown thread that was deleted", () => {
    expect(threadRouteOpensDraft({ detailStatus: "deleted", threadWasShown: true })).toBe(true);
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
