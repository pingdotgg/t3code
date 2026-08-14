import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/state/entities", () => ({ useThreadShell: () => null }));
vi.mock("~/state/session", () => ({ usePreparedConnection: () => ({ _tag: "None" }) }));

import {
  flushPendingFaviconsForThread,
  lookupFavicon,
  mergeBrowserFaviconState,
  recordFaviconForProject,
  recordFaviconForThread,
  registerFaviconProjectForThread,
  resetBrowserFaviconsForTests,
  resolveBrowserFaviconStorage,
  useBrowserFaviconStore,
} from "./browserFaviconStore";
import {
  BROWSER_FAVICON_MAX_ENTRIES,
  migratePersistedBrowserFaviconState,
} from "./browserFaviconLogic";

const environmentId = EnvironmentId.make("env-1");
const projectRef = scopeProjectRef(environmentId, ProjectId.make("project-1"));
const threadRef = { environmentId, threadId: ThreadId.make("thread-1") };
const PNG = "data:image/png;base64,AAAA";
const favicon = (pageUrl: string, capturedAt: number, dataUrl = PNG) => ({
  pageUrl,
  capturedAt,
  dataUrl,
});

describe("browser favicon store", () => {
  beforeEach(resetBrowserFaviconsForTests);
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps the newest capture for an origin and permits an identical later revisit", () => {
    const recordFavicon = vi.spyOn(useBrowserFaviconStore.getState(), "recordFavicon");
    recordFaviconForProject(projectRef, favicon("http://localhost:3000/", 20), null);
    recordFaviconForProject(
      projectRef,
      favicon("http://localhost:3000/old", 10, "data:image/png;base64,QkJCQg=="),
      null,
    );
    recordFaviconForProject(projectRef, favicon("http://localhost:3000/new", 30), null);
    recordFaviconForProject(projectRef, favicon("http://localhost:3000/new", 30), null);
    expect(Object.values(useBrowserFaviconStore.getState().byKey)).toEqual([
      { dataUrl: PNG, capturedAt: 30 },
    ]);
    expect(recordFavicon).toHaveBeenCalledTimes(2);
  });

  it("does not share localhost icons across environments or physical projects", () => {
    const otherEnvironment = scopeProjectRef(
      EnvironmentId.make("env-2"),
      ProjectId.make("project-1"),
    );
    const otherProject = scopeProjectRef(environmentId, ProjectId.make("project-2"));
    recordFaviconForProject(projectRef, favicon("http://localhost:3000/", 1), null);
    recordFaviconForProject(otherEnvironment, favicon("http://localhost:3000/", 2), null);
    recordFaviconForProject(otherProject, favicon("http://localhost:3000/", 3), null);
    expect(Object.keys(useBrowserFaviconStore.getState().byKey)).toEqual([
      "env-1:project-1 http://localhost:3000",
      "env-2:project-1 http://localhost:3000",
      "env-1:project-2 http://localhost:3000",
    ]);
  });

  it("finds a persisted environment icon after shell hydration without a live connection", () => {
    recordFaviconForProject(projectRef, favicon("http://192.168.64.2:3000/app", 5), "192.168.64.2");
    const byKey = useBrowserFaviconStore.getState().byKey;
    expect(lookupFavicon(byKey, null, "http://localhost:3000/app", null)).toBeNull();
    expect(lookupFavicon(byKey, projectRef, "http://localhost:3000/app", null)).toBe(PNG);
    expect(lookupFavicon(byKey, projectRef, "http://192.168.64.2:3000/app", null)).toBe(PNG);
    expect(lookupFavicon(byKey, projectRef, "http://192.168.64.3:3000/app", null)).toBeNull();
    expect(lookupFavicon(byKey, projectRef, "https://192.168.64.2:3000/app", null)).toBeNull();
    expect(lookupFavicon(byKey, projectRef, "http://192.168.64.2:3001/app", null)).toBeNull();
    expect(
      lookupFavicon(
        byKey,
        scopeProjectRef(environmentId, ProjectId.make("project-2")),
        "http://192.168.64.2:3000/app",
        null,
      ),
    ).toBeNull();
  });

  it("finds a persisted IPv6 environment icon without a live connection", () => {
    recordFaviconForProject(projectRef, favicon("http://[fd00::1]:3000/app", 5), "fd00::1");
    const migrated = migratePersistedBrowserFaviconState({
      byKey: useBrowserFaviconStore.getState().byKey,
    }).byKey;
    expect(lookupFavicon(migrated, projectRef, "http://[fd00::1]:3000/app", null)).toBe(PNG);
  });

  it("keeps exact host aliases attached to the newest canonical icon", () => {
    const olderPng = "data:image/png;base64,QkJCQg==";
    const newerPng = "data:image/png;base64,Q0NDQw==";
    recordFaviconForProject(
      projectRef,
      favicon("http://192.168.64.2:3000/", 10, olderPng),
      "192.168.64.2",
    );
    recordFaviconForProject(
      projectRef,
      favicon("http://192.168.64.3:3000/", 20, newerPng),
      "192.168.64.3",
    );
    recordFaviconForProject(
      projectRef,
      favicon("http://192.168.64.4:3000/", 15, olderPng),
      "192.168.64.4",
    );
    const byKey = useBrowserFaviconStore.getState().byKey;
    for (const host of ["192.168.64.2", "192.168.64.3", "192.168.64.4"]) {
      expect(lookupFavicon(byKey, projectRef, `http://${host}:3000/`, null)).toBe(newerPng);
    }
    expect(byKey["env-1:project-1 http://localhost:3000"]?.capturedAt).toBe(20);
  });

  it("evicts an icon and its exact host aliases atomically", () => {
    recordFaviconForProject(projectRef, favicon("http://192.168.64.2:3000/", 100), "192.168.64.2");
    for (let index = 1; index < BROWSER_FAVICON_MAX_ENTRIES; index += 1) {
      recordFaviconForProject(
        projectRef,
        favicon(`https://example-${index}.com/`, 100 + index),
        null,
      );
    }
    expect(
      lookupFavicon(
        useBrowserFaviconStore.getState().byKey,
        projectRef,
        "http://192.168.64.2:3000/",
        null,
      ),
    ).toBe(PNG);

    recordFaviconForProject(projectRef, favicon("https://evicts-oldest.example/", 1_000), null);
    expect(
      lookupFavicon(
        useBrowserFaviconStore.getState().byKey,
        projectRef,
        "http://192.168.64.2:3000/",
        null,
      ),
    ).toBeNull();
  });

  it("retains multiple origins until project and connection metadata hydrate", () => {
    expect(
      recordFaviconForThread(threadRef, favicon("http://localhost:3000/", 1), null, undefined),
    ).toBe(false);
    expect(
      recordFaviconForThread(threadRef, favicon("http://localhost:5173/", 2), null, undefined),
    ).toBe(false);
    expect(
      Object.keys(Object.values(useBrowserFaviconStore.getState().pendingByThreadKey)[0] ?? {}),
    ).toHaveLength(2);

    expect(flushPendingFaviconsForThread(threadRef, projectRef, "192.168.64.2")).toBe(true);
    expect(Object.keys(useBrowserFaviconStore.getState().byKey).toSorted()).toEqual([
      "env-1:project-1 http://localhost:3000",
      "env-1:project-1 http://localhost:5173",
    ]);
    expect(useBrowserFaviconStore.getState().pendingByThreadKey).toEqual({});
  });

  it("persists unambiguous loopback captures while the environment is offline", () => {
    expect(
      recordFaviconForThread(
        threadRef,
        favicon("http://localhost:3000/", 1),
        projectRef,
        undefined,
      ),
    ).toBe(true);
    expect(useBrowserFaviconStore.getState().byKey).toEqual({
      "env-1:project-1 http://localhost:3000": { dataUrl: PNG, capturedAt: 1 },
    });

    recordFaviconForThread(
      threadRef,
      favicon("http://192.168.64.2:5173/", 2),
      projectRef,
      undefined,
    );
    expect(flushPendingFaviconsForThread(threadRef, projectRef, undefined)).toBe(false);
    expect(Object.values(useBrowserFaviconStore.getState().pendingByThreadKey)[0]).toBeDefined();
  });

  it("keeps pending captures in store-owned state independent of bridge lifetime", () => {
    recordFaviconForThread(threadRef, favicon("http://localhost:3000/", 10), null, undefined);
    const pendingAfterUnmount = useBrowserFaviconStore.getState().pendingByThreadKey;
    useBrowserFaviconStore.setState({ pendingByThreadKey: pendingAfterUnmount });
    flushPendingFaviconsForThread(threadRef, projectRef, "localhost");
    expect(useBrowserFaviconStore.getState().byKey).toEqual({
      "env-1:project-1 http://localhost:3000": { dataUrl: PNG, capturedAt: 10 },
    });
  });

  it("flushes and resolves a pending draft-thread favicon after physical project registration", () => {
    recordFaviconForThread(threadRef, favicon("http://localhost:8025/", 10), null, undefined);
    registerFaviconProjectForThread(threadRef, projectRef);
    const registered = useBrowserFaviconStore.getState().projectRefByThreadKey["env-1:thread-1"];
    expect(registered).toEqual(projectRef);
    expect(flushPendingFaviconsForThread(threadRef, registered!, undefined)).toBe(true);
    expect(
      lookupFavicon(
        useBrowserFaviconStore.getState().byKey,
        registered!,
        "http://localhost:8025/",
        null,
      ),
    ).toBe(PNG);
  });

  it("bounds pending memory by origin and thread", () => {
    for (let thread = 0; thread < 22; thread += 1) {
      for (let port = 3000; port < 3012; port += 1) {
        recordFaviconForThread(
          { environmentId, threadId: ThreadId.make(`thread-${thread}`) },
          favicon(`http://localhost:${port}/`, port),
          null,
          undefined,
        );
      }
    }
    const pending = useBrowserFaviconStore.getState().pendingByThreadKey;
    expect(Object.keys(pending)).toHaveLength(20);
    expect(Object.values(pending).every((byOrigin) => Object.keys(byOrigin).length === 10)).toBe(
      true,
    );
  });

  it("sanitizes hydrated state while preserving actions and transient pending data", () => {
    recordFaviconForThread(threadRef, favicon("http://localhost:3000/", 1), null, undefined);
    const current = useBrowserFaviconStore.getState();
    const merged = mergeBrowserFaviconState(
      {
        byKey: {
          "env-1:project-1 http://localhost:3000": { dataUrl: PNG, capturedAt: 2 },
          "env-1:project-1 http://localhost:3001": { dataUrl: "bad", capturedAt: 3 },
          "env-1:project-1 http://localhost:3002": { dataUrl: PNG, capturedAt: 1e308 },
          ["x".repeat(5_000)]: { dataUrl: PNG, capturedAt: 4 },
        },
      },
      current,
    );
    expect(merged.byKey).toEqual({
      "env-1:project-1 http://localhost:3000": { dataUrl: PNG, capturedAt: 2 },
    });
    expect(merged.pendingByThreadKey).toEqual(current.pendingByThreadKey);
    expect(typeof merged.recordFavicon).toBe("function");
  });

  it("falls back to memory when localStorage access throws", () => {
    vi.stubGlobal(
      "window",
      Object.defineProperty({}, "localStorage", {
        get: () => {
          throw new Error("storage blocked");
        },
      }),
    );
    const storage = resolveBrowserFaviconStorage();
    storage.setItem("key", "value");
    expect(storage.getItem("key")).toBe("value");
  });

  it("falls back to memory when localStorage operations throw", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: vi.fn(() => {
          throw new Error("read blocked");
        }),
        setItem: vi.fn(() => {
          throw new Error("quota exceeded");
        }),
        removeItem: vi.fn(() => {
          throw new Error("remove blocked");
        }),
      },
    });
    const storage = resolveBrowserFaviconStorage();

    storage.setItem("key", "value");
    expect(storage.getItem("key")).toBe("value");
    storage.removeItem("key");
    expect(storage.getItem("key")).toBeNull();
  });

  it("keeps the memory shadow authoritative after an asymmetric primary write failure", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: vi.fn(() => "stale"),
        setItem: vi.fn(() => {
          throw new Error("quota exceeded");
        }),
        removeItem: vi.fn(() => {
          throw new Error("remove blocked");
        }),
      },
    });
    const storage = resolveBrowserFaviconStorage();

    storage.setItem("key", "fresh");
    expect(storage.getItem("key")).toBe("fresh");
    storage.removeItem("key");
    expect(storage.getItem("key")).toBeNull();
  });
});
