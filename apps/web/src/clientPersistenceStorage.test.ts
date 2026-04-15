import { EnvironmentId, type PersistedSavedEnvironmentRecord } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

const testEnvironmentId = EnvironmentId.make("environment-1");

const savedRegistryRecord: PersistedSavedEnvironmentRecord = {
  environmentId: testEnvironmentId,
  label: "Remote environment",
  httpBaseUrl: "https://remote.example.com/",
  wsBaseUrl: "wss://remote.example.com/",
  createdAt: "2026-04-09T00:00:00.000Z",
  lastConnectedAt: null,
};

function createLocalStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

function getTestWindow(): Window & typeof globalThis {
  const localStorage = createLocalStorageStub();
  const testWindow = {
    localStorage,
  } as Window & typeof globalThis;
  vi.stubGlobal("window", testWindow);
  vi.stubGlobal("localStorage", localStorage);
  return testWindow;
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("clientPersistenceStorage", () => {
  it("stores browser secrets inline with the saved environment record", async () => {
    const testWindow = getTestWindow();
    const {
      SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY,
      readBrowserSavedEnvironmentRegistry,
      readBrowserSavedEnvironmentSecret,
      writeBrowserSavedEnvironmentRegistry,
      writeBrowserSavedEnvironmentSecret,
    } = await import("./clientPersistenceStorage");

    writeBrowserSavedEnvironmentRegistry([savedRegistryRecord]);
    expect(writeBrowserSavedEnvironmentSecret(testEnvironmentId, "bearer-token")).toBe(true);
    writeBrowserSavedEnvironmentRegistry([savedRegistryRecord]);

    expect(readBrowserSavedEnvironmentRegistry()).toEqual([savedRegistryRecord]);
    expect(readBrowserSavedEnvironmentSecret(testEnvironmentId)).toBe("bearer-token");
    expect(
      JSON.parse(testWindow.localStorage.getItem(SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY)!),
    ).toEqual({
      version: 1,
      records: [
        {
          ...savedRegistryRecord,
          bearerToken: "bearer-token",
        },
      ],
    });
  });

  it("reads and writes workspace documents as JSON blobs", async () => {
    const testWindow = getTestWindow();
    const {
      WORKSPACE_DOCUMENT_STORAGE_KEY,
      readBrowserWorkspaceDocument,
      writeBrowserWorkspaceDocument,
    } = await import("./clientPersistenceStorage");
    const workspaceDocument = {
      version: 1 as const,
      layoutEngine: "split" as const,
      rootNodeId: "node-1",
      nodesById: {
        "node-1": {
          id: "node-1",
          kind: "window" as const,
          windowId: "window-1",
        },
      },
      windowsById: {
        "window-1": {
          id: "window-1",
          tabIds: ["surface-1"],
          activeTabId: "surface-1",
        },
      },
      surfacesById: {
        "surface-1": {
          id: "surface-1",
          kind: "thread" as const,
          input: {
            scope: "server" as const,
            threadRef: {
              environmentId: testEnvironmentId,
              threadId: "thread-1",
            },
          },
        },
      },
      focusedWindowId: "window-1",
      mobileActiveWindowId: "window-1",
    };

    writeBrowserWorkspaceDocument(workspaceDocument);

    expect(readBrowserWorkspaceDocument<typeof workspaceDocument>()).toEqual(workspaceDocument);
    expect(JSON.parse(testWindow.localStorage.getItem(WORKSPACE_DOCUMENT_STORAGE_KEY)!)).toEqual(
      workspaceDocument,
    );
  });
});
