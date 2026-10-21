import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/state/entities", () => ({ useQuietThreadShell: () => null }));
vi.mock("~/state/session", () => ({ usePreparedConnection: () => ({ _tag: "None" }) }));

import {
  flushPendingFaviconsForThread,
  lookupFavicon,
  recordFaviconForProject,
  recordFaviconForThread,
  resetBrowserFaviconsForTests,
  resolveBrowserFaviconStorage,
  useBrowserFaviconStore,
} from "./browserFaviconStore";

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
