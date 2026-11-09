import { describe, expect, it } from "vite-plus/test";
import { AuthFilesystemReadScope, AuthOrchestrationReadScope } from "@t3tools/contracts";

import {
  createBrowseNavigationCoordinator,
  filterFilesystemBrowseEntries,
  findExactFilesystemBrowseEntry,
  getFilesystemBrowsePath,
  getFilesystemBrowseTabCompletion,
  resolveFilesystemReadAccess,
} from "./filesystem.ts";

const SPLIT_SCOPES_SERVER = { serverUpdateScope: "environment:maintain" } as const;

describe("filesystem read access", () => {
  it("waits for the initial catalog before declaring a missing environment disconnected", () => {
    expect(
      resolveFilesystemReadAccess({
        isCatalogReady: false,
        connection: null,
        session: null,
        sessionError: null,
      }),
    ).toEqual({ canReadFiles: false, isPending: true, error: null });
  });

  it.each([false, true])(
    "preserves a cached file grant offline with catalog ready=%s",
    (isCatalogReady) => {
      const input = {
        isCatalogReady,
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
    },
  );

  it.each([
    { authenticated: true, scopes: [AuthOrchestrationReadScope], auth: SPLIT_SCOPES_SERVER },
    { authenticated: false, scopes: [AuthFilesystemReadScope], auth: SPLIT_SCOPES_SERVER },
  ] as const)("does not infer file access from an ungranted session", (session) => {
    expect(
      resolveFilesystemReadAccess({
        isCatalogReady: true,
        connection: { phase: "connected", error: null },
        session,
        sessionError: null,
      }),
    ).toEqual({ canReadFiles: false, isPending: false, error: null });
  });

  it("falls back to the orchestration grant on a server that predates filesystem:read", () => {
    expect(
      resolveFilesystemReadAccess({
        isCatalogReady: true,
        connection: { phase: "connected", error: null },
        session: { authenticated: true, scopes: [AuthOrchestrationReadScope], auth: {} },
        sessionError: null,
      }),
    ).toEqual({ canReadFiles: true, isPending: false, error: null });
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
    expect(getFilesystemBrowsePath("hlw", "", true, "~/projects")).toEqual({
      isBrowsing: true,
      directoryPath: "~/projects/",
      filterQuery: "hlw",
      parentPath: "~/",
      canBrowseUp: true,
    });
    expect(getFilesystemBrowsePath("C:\\Users\\test", "MacIntel").isBrowsing).toBe(false);
    expect(getFilesystemBrowsePath("~/projects/", "", false).isBrowsing).toBe(false);
  });

  it("completes Tab like a shell", () => {
    const entry = (name: string) => ({ name, fullPath: `/Users/me/${name}` });
    expect(getFilesystemBrowseTabCompletion([entry("Creations")], "Creation")).toEqual({
      name: "Creations",
      isComplete: true,
    });
    expect(getFilesystemBrowseTabCompletion([entry("OpenSourced"), entry("OpenAI")], "op")).toEqual(
      { name: "Open", isComplete: false },
    );
    expect(getFilesystemBrowseTabCompletion([entry("Open"), entry("Opal")], "Op")).toBeNull();
    expect(getFilesystemBrowseTabCompletion([entry("openAI"), entry("OpenSource")], "o")).toEqual({
      name: "open",
      isComplete: false,
    });
    expect(getFilesystemBrowseTabCompletion([entry("😀one"), entry("😁two")], "")).toBeNull();
    expect(getFilesystemBrowseTabCompletion([entry("ΟΣα"), entry("οσβ")], "ο")).toBeNull();
    expect(getFilesystemBrowseTabCompletion([entry("İfoo"), entry("İfar")], "i\u0307")).toEqual({
      name: "İf",
      isComplete: false,
    });
    expect(getFilesystemBrowseTabCompletion([entry("😀one"), entry("😀other")], "😀")).toEqual({
      name: "😀o",
      isComplete: false,
    });
    expect(getFilesystemBrowseTabCompletion([], "x")).toBeNull();
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
});

it("fuzzy-matches and ranks folder names for every folder browser", () => {
  const entries = ["my-t3code", "t3code", "cotton", "T3Code-old", ".t3", "docs"].map((name) => ({
    name,
    fullPath: `/code/${name}`,
  }));
  expect(
    filterFilesystemBrowseEntries(entries, "tcd").visibleEntries.map((entry) => entry.name),
  ).toEqual(["t3code", "T3Code-old", "my-t3code"]);
  expect(filterFilesystemBrowseEntries(entries, "t3code").exactEntry?.name).toBe("t3code");
  expect(
    filterFilesystemBrowseEntries(entries, "t3").visibleEntries.some(
      (entry) => entry.name === ".t3",
    ),
  ).toBe(false);
});

it("resolves only a unique exact basename from recursive folder results", () => {
  const entries = [
    { name: "team/project", fullPath: "/work/team/project" },
    { name: "other/project", fullPath: "/work/other/project" },
  ];
  expect(findExactFilesystemBrowseEntry(entries.slice(0, 1), "project")).toEqual(entries[0]);
  expect(findExactFilesystemBrowseEntry(entries, "project")).toBeNull();
  expect(findExactFilesystemBrowseEntry(entries, "proj")).toBeNull();
  expect(findExactFilesystemBrowseEntry(entries, "/work/team/project")).toEqual(entries[0]);
});
