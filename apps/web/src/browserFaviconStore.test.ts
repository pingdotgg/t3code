import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { readPreparedConnection } = vi.hoisted(() => ({
  readPreparedConnection: vi.fn<() => { httpBaseUrl: string } | null>(() => ({
    httpBaseUrl: "http://192.168.64.2:3773",
  })),
}));

vi.mock("~/state/session", () => ({
  readPreparedConnection,
  usePreparedConnection: () => ({ _tag: "None" }),
}));

vi.mock("~/state/entities", () => ({
  useThreadShell: () => null,
}));

import { faviconKey } from "./browserFaviconLogic";
import {
  flushPendingFaviconsForThread,
  mergeBrowserFaviconState,
  recordFaviconForProject,
  recordFaviconForThread,
  resetBrowserFaviconsForTests,
  resolveBrowserFaviconStorage,
  useBrowserFaviconStore,
} from "./browserFaviconStore";

const projectRef = scopeProjectRef(EnvironmentId.make("env-1"), ProjectId.make("project-1"));
const threadRef = {
  environmentId: projectRef.environmentId,
  threadId: ThreadId.make("thread-1"),
};
const PNG = "data:image/png;base64,AAAA";

afterEach(() => vi.unstubAllGlobals());

describe("resolveBrowserFaviconStorage", () => {
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
});

describe("recordFaviconForProject", () => {
  beforeEach(() => {
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "http://192.168.64.2:3773" });
    resetBrowserFaviconsForTests();
  });

  it("stores an icon under physical project + canonical host", () => {
    recordFaviconForProject(projectRef, "http://localhost:3000/admin", PNG, 5);
    expect(useBrowserFaviconStore.getState().byKey).toEqual({
      "env-1:project-1 http://local:3000": { dataUrl: PNG, updatedAt: 5 },
    });
  });

  it("ignores invalid urls and non-image payloads", () => {
    recordFaviconForProject(projectRef, "ftp://nope/", PNG, 2);
    recordFaviconForProject(projectRef, "http://localhost:3000/", "http://evil/i.png", 3);
    expect(useBrowserFaviconStore.getState().byKey).toEqual({});
  });

  it("does not store a non-canonical icon before the environment connection is ready", () => {
    readPreparedConnection.mockReturnValueOnce(null);
    expect(recordFaviconForProject(projectRef, "http://192.168.64.2:3000/", PNG, 1)).toBe(false);
    expect(useBrowserFaviconStore.getState().byKey).toEqual({});
  });

  it("flushes an icon captured before its thread project is registered", () => {
    expect(recordFaviconForThread(threadRef, "http://localhost:3000/", PNG, 1)).toBe(false);
    expect(useBrowserFaviconStore.getState().byKey).toEqual({});

    useBrowserFaviconStore
      .getState()
      .registerThreadProject(threadRef, scopedProjectKey(projectRef));

    expect(useBrowserFaviconStore.getState().byKey).toEqual({
      "env-1:project-1 http://local:3000": { dataUrl: PNG, updatedAt: 1 },
    });
    expect(useBrowserFaviconStore.getState().pendingByThreadKey).toEqual({});
  });

  it("flushes a pre-connection capture under the canonical environment key", () => {
    useBrowserFaviconStore
      .getState()
      .registerThreadProject(threadRef, scopedProjectKey(projectRef));
    readPreparedConnection.mockReturnValue(null);

    expect(recordFaviconForThread(threadRef, "http://192.168.64.2:3000/", PNG, 1)).toBe(false);
    expect(useBrowserFaviconStore.getState().byKey).toEqual({});
    expect(useBrowserFaviconStore.getState().pendingByThreadKey).not.toEqual({});

    readPreparedConnection.mockReturnValue({ httpBaseUrl: "http://192.168.64.2:3773" });
    expect(flushPendingFaviconsForThread(threadRef)).toBe(true);

    expect(useBrowserFaviconStore.getState().byKey).toEqual({
      "env-1:project-1 http://local:3000": { dataUrl: PNG, updatedAt: 1 },
    });
    expect(useBrowserFaviconStore.getState().pendingByThreadKey).toEqual({});
  });

  it("keeps the newest duplicate while captures wait for the connection", () => {
    useBrowserFaviconStore
      .getState()
      .registerThreadProject(threadRef, scopedProjectKey(projectRef));
    readPreparedConnection.mockReturnValue(null);

    recordFaviconForThread(threadRef, "http://192.168.64.2:3000/", PNG, 20);
    recordFaviconForThread(threadRef, "http://192.168.64.2:3000/", PNG, 10);

    readPreparedConnection.mockReturnValue({ httpBaseUrl: "http://192.168.64.2:3773" });
    flushPendingFaviconsForThread(threadRef);
    expect(useBrowserFaviconStore.getState().byKey).toEqual({
      "env-1:project-1 http://local:3000": { dataUrl: PNG, updatedAt: 20 },
    });
  });

  it("overwrites an existing icon for the same key", () => {
    recordFaviconForProject(projectRef, "http://localhost:3000/", PNG, 5);
    const next = "data:image/svg+xml;base64,BBBB";
    recordFaviconForProject(projectRef, "http://localhost:3000/other", next, 9);
    expect(useBrowserFaviconStore.getState().byKey).toEqual({
      "env-1:project-1 http://local:3000": { dataUrl: next, updatedAt: 9 },
    });
  });

  it("does not replace a newer icon with an older capture", () => {
    const current = "data:image/svg+xml;base64,Q1VSUkVOVA==";
    const stale = "data:image/svg+xml;base64,U1RBTEU=";
    const simultaneous = "data:image/svg+xml;base64,U0lNVUxUQU5FT1VT";
    recordFaviconForProject(projectRef, "http://localhost:3000/", current, 20);
    recordFaviconForProject(projectRef, "http://localhost:3000/other", stale, 10);
    recordFaviconForProject(projectRef, "http://localhost:3000/equal", simultaneous, 20);
    expect(useBrowserFaviconStore.getState().byKey).toEqual({
      "env-1:project-1 http://local:3000": { dataUrl: current, updatedAt: 20 },
    });
  });

  it("advances updatedAt on a revisit with an unchanged icon", () => {
    recordFaviconForProject(projectRef, "http://localhost:3000/", PNG, 5);
    recordFaviconForProject(projectRef, "http://localhost:3000/", PNG, 20);
    expect(useBrowserFaviconStore.getState().byKey).toEqual({
      "env-1:project-1 http://local:3000": { dataUrl: PNG, updatedAt: 20 },
    });
  });

  it("does not share localhost favicons across environments or physical projects", () => {
    const remoteProjectRef = scopeProjectRef(
      EnvironmentId.make("env-2"),
      ProjectId.make("project-1"),
    );
    const siblingProjectRef = scopeProjectRef(
      EnvironmentId.make("env-1"),
      ProjectId.make("project-2"),
    );
    recordFaviconForProject(projectRef, "http://localhost:3000/", PNG, 5);
    recordFaviconForProject(
      remoteProjectRef,
      "http://localhost:3000/",
      "data:image/png;base64,BBBB",
      6,
    );
    recordFaviconForProject(
      siblingProjectRef,
      "http://localhost:3000/",
      "data:image/png;base64,CCCC",
      7,
    );
    expect(Object.keys(useBrowserFaviconStore.getState().byKey)).toEqual([
      "env-1:project-1 http://local:3000",
      "env-2:project-1 http://local:3000",
      "env-1:project-2 http://local:3000",
    ]);
  });
});

describe("capture and lookup key agreement", () => {
  beforeEach(() => {
    resetBrowserFaviconsForTests();
  });

  it("capturing under the resolved environment host is found by the requested localhost url", () => {
    recordFaviconForProject(projectRef, "http://192.168.64.2:3773/app", PNG, 5);

    const key = faviconKey("env-1:project-1", "http://localhost:3773/app", "192.168.64.2");
    expect(key).not.toBeNull();
    expect(useBrowserFaviconStore.getState().byKey[key!]?.dataUrl).toBe(PNG);
  });
});

describe("mergeBrowserFaviconState", () => {
  it("sanitizes same-version corrupt data and preserves actions", () => {
    const merged = mergeBrowserFaviconState(
      {
        byKey: {
          bad: { dataUrl: "http://x/i.png", updatedAt: 1 },
          good: { dataUrl: PNG, updatedAt: 2 },
        },
      },
      useBrowserFaviconStore.getState(),
    );
    expect(merged.byKey).toEqual({ good: { dataUrl: PNG, updatedAt: 2 } });
    expect(typeof merged.recordFavicon).toBe("function");
  });
});
