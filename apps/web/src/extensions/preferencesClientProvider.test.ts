import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { ClientProviderCaller, ClientProviderEmitEvent } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";
import type { Json, ViewContext } from "@t3tools/extension-sdk/contracts";

const persistenceMocks = vi.hoisted(() => ({
  getClientSettings: vi.fn<() => Promise<ClientSettings | null>>(),
  setClientSettings: vi.fn<(settings: ClientSettings) => Promise<void>>(),
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({ persistence: persistenceMocks }),
}));

vi.mock("../components/ThreadTerminalDrawer", () => ({
  terminalThemeFromApp: () => ({}),
}));

import {
  __resetClientSettingsPersistenceForTests,
  getClientSettings,
  persistClientSettingsPatch,
} from "../hooks/useSettings";
import {
  getLocalStorageItem,
  removeLocalStorageItem,
  setLocalStorageItem,
} from "../hooks/useLocalStorage";
import * as Schema from "effect/Schema";
import { createPreferencesClientProvider, type ClientProviderDeps } from "./clientProviders";
import type { ClientProviderInvokeCall } from "./clientProviderTypes";
import type { InstalledPackage } from "./installedController";

const ENV = "env-a";
const INSTALL = "ext.a";
const READ = "t3.ui/preferences.read";
const WRITE = "t3.ui/preferences.write";
/** The native file preview's own key: both panels share one HTML preference. */
const RENDER_BROWSER_FILE_KEY = "t3code.renderBrowserFile";
/** The native file preview's explorer key: both panels share one explorer choice. */
const FILE_EXPLORER_KEY = "t3code.fileExplorerOpen";

const caller: ClientProviderCaller = {
  installationId: INSTALL,
  contentHash: "hash-a",
  installationGeneration: 1,
};

const context: ViewContext = {
  client: "web",
  resource: {
    namespace: "t3.extensions",
    id: INSTALL,
    environmentId: ENV,
    projectId: "project-a",
  },
};

function makeDeps(capabilities: readonly string[]): ClientProviderDeps {
  const installed = {
    id: INSTALL,
    contentHash: "hash-a",
    enabled: true,
    installationGeneration: 1,
    grants: { capabilities: [...capabilities], projectIds: [ProjectId.make("project-a")] },
  } as unknown as InstalledPackage;
  return {
    environmentId: EnvironmentId.make(ENV),
    client: "web",
    emit: vi.fn(),
    installations: () => [installed],
  };
}

const invokeCall = (method: string, input: Json): ClientProviderInvokeCall => ({
  method,
  input,
  context,
  caller,
  signal: new AbortController().signal,
});

beforeEach(() => {
  __resetClientSettingsPersistenceForTests();
  persistenceMocks.getClientSettings
    .mockReset()
    .mockResolvedValue({ ...DEFAULT_CLIENT_SETTINGS, wordWrap: false });
  persistenceMocks.setClientSettings.mockReset().mockResolvedValue(undefined);
  removeLocalStorageItem(RENDER_BROWSER_FILE_KEY);
  removeLocalStorageItem(FILE_EXPLORER_KEY);
});

describe("preferences client provider", () => {
  it("reads the persisted value, not the pre-hydration default", async () => {
    const provider = createPreferencesClientProvider(makeDeps([READ]));
    await expect(provider.invoke(invokeCall("getPreferences", {}))).resolves.toEqual({
      wordWrap: false,
    });
  });

  it("denies reads and writes without their grants", async () => {
    const provider = createPreferencesClientProvider(makeDeps([READ]));
    await expect(
      createPreferencesClientProvider(makeDeps([])).invoke(invokeCall("getPreferences", {})),
    ).rejects.toMatchObject({ code: "client-target-denied" });
    await expect(
      provider.invoke(
        invokeCall("applyPreferences", { writer: INSTALL, patch: { wordWrap: true } }),
      ),
    ).rejects.toMatchObject({ code: "client-target-denied" });
    expect(persistenceMocks.setClientSettings).not.toHaveBeenCalled();
  });

  it("rejects a writer other than the calling installation", async () => {
    const provider = createPreferencesClientProvider(makeDeps([READ, WRITE]));
    await expect(
      provider.invoke(
        invokeCall("applyPreferences", { writer: "ext.other", patch: { wordWrap: true } }),
      ),
    ).rejects.toMatchObject({ code: "client-target-denied" });
    expect(persistenceMocks.setClientSettings).not.toHaveBeenCalled();
  });

  it("persists before its receipt and keeps the rest of the settings", async () => {
    const provider = createPreferencesClientProvider(makeDeps([READ, WRITE]));
    const receipt = await provider.invoke(
      invokeCall("applyPreferences", { writer: INSTALL, patch: { wordWrap: true } }),
    );
    expect(receipt).toEqual({
      applied: true,
      preferences: { wordWrap: true },
    });
    expect(persistenceMocks.setClientSettings).toHaveBeenCalledWith({
      ...DEFAULT_CLIENT_SETTINGS,
      wordWrap: true,
    });
    expect(getClientSettings().wordWrap).toBe(true);
  });

  it("reports a failed persist without publishing the value", async () => {
    persistenceMocks.setClientSettings.mockRejectedValue(new Error("disk full"));
    const provider = createPreferencesClientProvider(makeDeps([READ, WRITE]));
    const receipt = await provider.invoke(
      invokeCall("applyPreferences", { writer: INSTALL, patch: { wordWrap: true } }),
    );
    expect(receipt).toEqual({
      applied: false,
      reason: "persist-failed",
      preferences: { wordWrap: false },
    });
    expect(getClientSettings().wordWrap).toBe(false);
  });

  it("never reports a pre-hydration default when settings cannot load", async () => {
    persistenceMocks.getClientSettings.mockRejectedValue(new Error("storage offline"));
    const provider = createPreferencesClientProvider(makeDeps([READ, WRITE]));
    await expect(
      provider.invoke(
        invokeCall("applyPreferences", { writer: INSTALL, patch: { wordWrap: true } }),
      ),
    ).rejects.toMatchObject({ code: "client-provider-unavailable" });
    expect(persistenceMocks.setClientSettings).not.toHaveBeenCalled();
  });

  it("names an empty patch instead of claiming a write", async () => {
    const provider = createPreferencesClientProvider(makeDeps([READ, WRITE]));
    await expect(
      provider.invoke(invokeCall("applyPreferences", { writer: INSTALL, patch: {} })),
    ).resolves.toEqual({
      applied: false,
      reason: "empty-patch",
      preferences: { wordWrap: false },
    });
    expect(persistenceMocks.setClientSettings).not.toHaveBeenCalled();
  });

  it("streams a hydrated snapshot, then one frame per preference change", async () => {
    const provider = createPreferencesClientProvider(makeDeps([READ]));
    const events: ClientProviderEmitEvent[] = [];
    const close = await provider.openStream!({
      name: "watchPreferences",
      input: null,
      context,
      caller,
      emit: (event) => events.push(event),
    });
    expect(events).toEqual([{ type: "snapshot", value: { wordWrap: false } }]);
    // An unrelated setting is not a preference change.
    await persistClientSettingsPatch({ fontSizeTerminal: 20 }, async () => {});
    expect(events).toHaveLength(1);
    await persistClientSettingsPatch({ wordWrap: true }, async () => {});
    expect(events).toEqual([
      { type: "snapshot", value: { wordWrap: false } },
      { type: "data", value: { wordWrap: true } },
    ]);
    close();
    await persistClientSettingsPatch({ wordWrap: false }, async () => {});
    expect(events).toHaveLength(2);
  });

  // The Files pack's explorer choice is the
  // native file preview's own stored one, in both directions.
  describe("file explorer preference", () => {
    /** A 1.2.0 server asks for the key; an older one never does. */
    const INCLUDE = { include: ["renderBrowserFile", "fileExplorerOpen"] };

    it("reads the native panel's stored choice, shown when never chosen", async () => {
      const provider = createPreferencesClientProvider(makeDeps([READ]));
      await expect(provider.invoke(invokeCall("getPreferences", INCLUDE))).resolves.toEqual({
        wordWrap: false,
        renderBrowserFile: true,
        fileExplorerOpen: true,
      });
      setLocalStorageItem(FILE_EXPLORER_KEY, false, Schema.Boolean);
      await expect(provider.invoke(invokeCall("getPreferences", INCLUDE))).resolves.toMatchObject({
        fileExplorerOpen: false,
      });
      // A 1.1.0 server is answered without it.
      await expect(
        provider.invoke(invokeCall("getPreferences", { include: ["renderBrowserFile"] })),
      ).resolves.toEqual({ wordWrap: false, renderBrowserFile: true });
    });

    it("persists a pack's choice where the native panel reads it, and shows it again", async () => {
      const writer = createPreferencesClientProvider(makeDeps([READ, WRITE]));
      const write = (fileExplorerOpen: unknown) =>
        writer.invoke(
          invokeCall("applyPreferences", {
            writer: INSTALL,
            patch: { fileExplorerOpen },
            ...INCLUDE,
          } as Json),
        );
      await expect(write(false)).resolves.toMatchObject({
        applied: true,
        preferences: { fileExplorerOpen: false },
      });
      expect(getLocalStorageItem(FILE_EXPLORER_KEY, Schema.Boolean)).toBe(false);
      await expect(write(true)).resolves.toMatchObject({
        preferences: { fileExplorerOpen: true },
      });
      expect(getLocalStorageItem(FILE_EXPLORER_KEY, Schema.Boolean)).toBe(true);
      await expect(write("no")).rejects.toMatchObject({ code: "provider-rejected" });
      expect(persistenceMocks.setClientSettings).not.toHaveBeenCalled();
    });
  });

  describe("HTML render preference", () => {
    /** A 1.1.0 server asks for the key; an older one never does. */
    const INCLUDE = { include: ["renderBrowserFile"] };

    // An older server validates the client's
    // answers against its closed 1.0.0 shapes, so the key only goes to a
    // server that asked for it — word wrap keeps working across the skew.
    it("answers a server that did not ask with the 1.0.0 shape", async () => {
      setLocalStorageItem(RENDER_BROWSER_FILE_KEY, false, Schema.Boolean);
      const provider = createPreferencesClientProvider(makeDeps([READ, WRITE]));
      await expect(provider.invoke(invokeCall("getPreferences", {}))).resolves.toEqual({
        wordWrap: false,
      });
      await expect(
        provider.invoke(
          invokeCall("applyPreferences", { writer: INSTALL, patch: { wordWrap: true } }),
        ),
      ).resolves.toEqual({ applied: true, preferences: { wordWrap: true } });
      const events: ClientProviderEmitEvent[] = [];
      const close = await provider.openStream!({
        name: "watchPreferences",
        input: null,
        context,
        caller,
        emit: (event) => events.push(event),
      });
      await persistClientSettingsPatch({ wordWrap: false }, async () => {});
      expect(events).toEqual([
        { type: "snapshot", value: { wordWrap: true } },
        { type: "data", value: { wordWrap: false } },
      ]);
      close();
    });

    it("reads the native file preview's stored choice, rendered when never chosen", async () => {
      const provider = createPreferencesClientProvider(makeDeps([READ]));
      await expect(provider.invoke(invokeCall("getPreferences", INCLUDE))).resolves.toMatchObject({
        renderBrowserFile: true,
      });
      setLocalStorageItem(RENDER_BROWSER_FILE_KEY, false, Schema.Boolean);
      await expect(provider.invoke(invokeCall("getPreferences", INCLUDE))).resolves.toEqual({
        wordWrap: false,
        renderBrowserFile: false,
      });
    });

    it("persists a pack's choice where a fresh presentation and the native panel read it", async () => {
      const writer = createPreferencesClientProvider(makeDeps([READ, WRITE]));
      await expect(
        writer.invoke(
          invokeCall("applyPreferences", {
            writer: INSTALL,
            patch: { renderBrowserFile: false },
            ...INCLUDE,
          }),
        ),
      ).resolves.toEqual({
        applied: true,
        preferences: { wordWrap: false, renderBrowserFile: false },
      });
      expect(getLocalStorageItem(RENDER_BROWSER_FILE_KEY, Schema.Boolean)).toBe(false);
      // Client settings are untouched: the key is the native panel's own.
      expect(persistenceMocks.setClientSettings).not.toHaveBeenCalled();
      // A new provider stands in for a reloaded client or another view.
      const fresh = createPreferencesClientProvider(makeDeps([READ]));
      await expect(fresh.invoke(invokeCall("getPreferences", INCLUDE))).resolves.toMatchObject({
        renderBrowserFile: false,
      });
    });

    it("rejects a non-boolean value", async () => {
      const provider = createPreferencesClientProvider(makeDeps([READ, WRITE]));
      await expect(
        provider.invoke(
          invokeCall("applyPreferences", { writer: INSTALL, patch: { renderBrowserFile: "no" } }),
        ),
      ).rejects.toMatchObject({ code: "provider-rejected" });
      expect(getLocalStorageItem(RENDER_BROWSER_FILE_KEY, Schema.Boolean)).toBeNull();
    });

    it("streams changes the native panel or another tab makes", async () => {
      const storage = new Map<string, string>();
      const target = Object.assign(new EventTarget(), {
        localStorage: {
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => void storage.set(key, value),
          removeItem: (key: string) => void storage.delete(key),
        },
      });
      vi.stubGlobal("window", target);
      try {
        const provider = createPreferencesClientProvider(makeDeps([READ]));
        const events: ClientProviderEmitEvent[] = [];
        const close = await provider.openStream!({
          name: "watchPreferences",
          input: INCLUDE,
          context,
          caller,
          emit: (event) => events.push(event),
        });
        storage.set(RENDER_BROWSER_FILE_KEY, "false");
        // Same-tab writes announce themselves the way useLocalStorage does.
        target.dispatchEvent(
          new CustomEvent("t3code:local_storage_change", {
            detail: { key: RENDER_BROWSER_FILE_KEY },
          }),
        );
        storage.set(RENDER_BROWSER_FILE_KEY, "true");
        const crossTab = Object.assign(new Event("storage"), { key: RENDER_BROWSER_FILE_KEY });
        target.dispatchEvent(crossTab);
        expect(events).toEqual([
          { type: "snapshot", value: { wordWrap: false, renderBrowserFile: true } },
          { type: "data", value: { wordWrap: false, renderBrowserFile: false } },
          { type: "data", value: { wordWrap: false, renderBrowserFile: true } },
        ]);
        close();
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });
});
