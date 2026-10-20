import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "effect/reactivity";
import { AuthFilesystemReadScope, AuthOrchestrationReadScope } from "@t3tools/contracts";

import {
  canPreloadBrowsePath,
  createBrowseNavigationCoordinator,
  createFilesystemBrowseSession,
  filterFilesystemBrowseEntries,
  getFilesystemBrowsePath,
  resolveFilesystemReadAccess,
} from "./filesystem.ts";
import { executeAtomQuery } from "./runtime.ts";

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

  it("stops waiting when the loaded catalog has no matching environment", () => {
    expect(
      resolveFilesystemReadAccess({
        isCatalogReady: true,
        connection: null,
        session: null,
        sessionError: null,
      }),
    ).toEqual({
      canReadFiles: false,
      isPending: false,
      error: "This environment is not connected.",
    });
  });

  it.each(["available", "offline", "error"] as const)(
    "stops waiting for an unresolved session when the connection is %s",
    (phase) => {
      expect(
        resolveFilesystemReadAccess({
          isCatalogReady: true,
          connection: { phase, error: null },
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
          isCatalogReady: true,
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
        isCatalogReady: true,
        connection: { phase: "error", error: "The relay is unavailable." },
        session: null,
        sessionError: null,
      }),
    ).toEqual({ canReadFiles: false, isPending: false, error: "The relay is unavailable." });
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

describe("filesystem browse sessions", () => {
  const registries: AtomRegistry.AtomRegistry[] = [];
  const makeRegistry = () => {
    const registry = AtomRegistry.make();
    registries.push(registry);
    return registry;
  };
  afterEach(() => {
    for (const registry of registries.splice(0)) registry.dispose();
    vi.useRealTimers();
  });

  const cachedQuery = <A, E>(effect: Effect.Effect<A, E>) =>
    Atom.make(effect).pipe(
      Atom.swr({ staleTime: 30_000, revalidateOnMount: true }),
      Atom.setIdleTTL(5 * 60_000),
    );

  it("shows newly created folders on reopen and refreshes only once per session", async () => {
    vi.useFakeTimers();
    const registry = makeRegistry();
    let entries = ["existing"];
    const request = vi.fn(() => entries);
    const source = cachedQuery(Effect.sync(request));
    const first = createFilesystemBrowseSession(() => source)(undefined);
    const close = registry.mount(first);
    expect(registry.get(first)).toMatchObject({ value: ["existing"] });
    expect(request).toHaveBeenCalledTimes(1);
    close();
    await vi.advanceTimersByTimeAsync(2_000);

    entries = ["existing", "new-folder"];
    const reopened = createFilesystemBrowseSession(() => source)(undefined);
    const rendered = vi.fn();
    const leaveDirectory = registry.subscribe(reopened, rendered, { immediate: true });
    expect(rendered).toHaveBeenLastCalledWith(
      expect.objectContaining({ value: entries, waiting: false }),
    );
    expect(request).toHaveBeenCalledTimes(2);

    leaveDirectory();
    await vi.advanceTimersByTimeAsync(2_000);
    registry.mount(reopened);
    expect(registry.get(reopened)).toMatchObject({ value: entries, waiting: false });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("shares a cold request with another picker opened while it is pending", async () => {
    const registry = makeRegistry();
    const pending = Promise.withResolvers<string[]>();
    const request = vi.fn(() => pending.promise);
    const source = cachedQuery(Effect.promise(request));
    const first = createFilesystemBrowseSession(() => source)(undefined);
    const second = createFilesystemBrowseSession(() => source)(undefined);
    const firstResult = executeAtomQuery(registry, first);
    const secondResult = executeAtomQuery(registry, second);
    expect(request).toHaveBeenCalledTimes(1);

    pending.resolve(["folder"]);
    for (const result of await Promise.all([firstResult, secondResult])) {
      expect(result).toMatchObject({ _tag: "Success", value: ["folder"] });
    }
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("renders a completed navigation preload without requesting the directory again", async () => {
    vi.useFakeTimers();
    const registry = makeRegistry();
    const request = vi.fn((path: string) => [path]);
    const family = Atom.family((path: string) => cachedQuery(Effect.sync(() => request(path))));
    const browse = createFilesystemBrowseSession(family);
    registry.mount(browse("/"));

    expect(await executeAtomQuery(registry, browse("/next/"))).toMatchObject({
      _tag: "Success",
      value: ["/next/"],
    });
    await vi.advanceTimersByTimeAsync(2_000);
    registry.mount(browse("/next/"));
    expect(registry.get(browse("/next/"))).toMatchObject({ value: ["/next/"] });
    expect(request.mock.calls).toEqual([["/"], ["/next/"]]);
  });
});
