import { describe, expect, it } from "vite-plus/test";
import { AuthFilesystemReadScope, AuthOrchestrationReadScope } from "@t3tools/contracts";

import {
  canPreloadBrowsePath,
  createBrowseNavigationCoordinator,
  filterFilesystemBrowseEntries,
  getFilesystemBrowsePath,
  resolveFilesystemReadAccess,
} from "./filesystem.ts";

describe("filesystem read access", () => {
  it.each(["available", "offline", "error", null] as const)(
    "stops waiting for an unresolved session when the connection is %s",
    (phase) => {
      expect(
        resolveFilesystemReadAccess({
          connection: phase === null ? null : { phase, error: null },
          session: null,
          sessionError: null,
        }),
      ).toEqual({
        canReadFiles: false,
        isPending: false,
        error: "This environment is not connected.",
      });
    },
  );

  it.each(["connected", "connecting", "reconnecting"] as const)(
    "waits for the session check while %s",
    (phase) => {
      expect(
        resolveFilesystemReadAccess({
          connection: { phase, error: null },
          session: null,
          sessionError: null,
        }),
      ).toEqual({ canReadFiles: false, isPending: true, error: null });
    },
  );

  it("reports the transport failure when the session cannot be checked", () => {
    expect(
      resolveFilesystemReadAccess({
        connection: { phase: "error", error: "The relay is unavailable." },
        session: null,
        sessionError: null,
      }),
    ).toEqual({ canReadFiles: false, isPending: false, error: "The relay is unavailable." });
  });

  it("preserves a cached file grant offline unless the session check failed", () => {
    const input = {
      connection: { phase: "offline", error: null },
      session: { authenticated: true, scopes: [AuthFilesystemReadScope] },
      sessionError: null,
    } as const;
    expect(resolveFilesystemReadAccess(input)).toEqual({
      canReadFiles: true,
      isPending: false,
      error: null,
    });
    expect(
      resolveFilesystemReadAccess({ ...input, sessionError: "The session has expired." }),
    ).toEqual({ canReadFiles: false, isPending: false, error: "The session has expired." });
  });

  it.each([
    { authenticated: true, scopes: [AuthOrchestrationReadScope] },
    { authenticated: false, scopes: [AuthFilesystemReadScope] },
  ] as const)("does not infer file access from an ungranted session", (session) => {
    expect(
      resolveFilesystemReadAccess({
        connection: { phase: "connected", error: null },
        session,
        sessionError: null,
      }),
    ).toEqual({ canReadFiles: false, isPending: false, error: null });
  });
});

describe("filesystem browse model", () => {
  it("derives the browse target and navigation state", () => {
    expect(getFilesystemBrowsePath("~/projects/t3")).toEqual({
      isBrowsing: true,
      directoryPath: "~/projects/",
      filterQuery: "t3",
      parentPath: "~/",
      canBrowseUp: true,
    });
    expect(getFilesystemBrowsePath("C:\\Users\\test", "MacIntel").isBrowsing).toBe(false);
    expect(getFilesystemBrowsePath("~/projects/", "", false).isBrowsing).toBe(false);
  });

  it("filters names, hidden directories, and exact matches consistently", () => {
    const entries = [
      { name: ".config", fullPath: "/Users/test/.config" },
      { name: "Code", fullPath: "/Users/test/Code" },
      { name: "codething", fullPath: "/Users/test/codething" },
    ];

    expect(filterFilesystemBrowseEntries(entries, "co")).toEqual({
      visibleEntries: entries.slice(1, 3),
      exactEntry: null,
    });
    expect(filterFilesystemBrowseEntries(entries, "").visibleEntries).toEqual(entries.slice(1));
    expect(filterFilesystemBrowseEntries(entries, ".").visibleEntries).toEqual(entries.slice(0, 1));
    expect(filterFilesystemBrowseEntries(entries, "Code").exactEntry).toEqual(entries[1]);
  });
});

describe("browse navigation", () => {
  it("only commits the latest valid navigation", async () => {
    const navigation = createBrowseNavigationCoordinator();
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const commits: string[] = [];
    const commit = (name: string) => () => commits.push(name);
    const firstRun = navigation.run(() => first.promise, commit("first"));
    const secondRun = navigation.run(() => second.promise, commit("second"));

    second.resolve();
    await expect(secondRun).resolves.toBe(true);
    first.resolve();
    await expect(firstRun).resolves.toBe(false);

    const invalidated = Promise.withResolvers<void>();
    const invalidatedRun = navigation.run(() => invalidated.promise, commit("stale"));
    navigation.invalidate();
    invalidated.resolve();

    await expect(invalidatedRun).resolves.toBe(false);
    expect(commits).toEqual(["second"]);
  });

  it("only preloads connected environments", () => {
    expect(canPreloadBrowsePath("connected")).toBe(true);
    expect(canPreloadBrowsePath("offline")).toBe(false);
    expect(canPreloadBrowsePath("reconnecting")).toBe(false);
    expect(canPreloadBrowsePath(null)).toBe(false);
  });
});
