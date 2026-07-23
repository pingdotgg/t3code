import {
  DEFAULT_CLIENT_SETTINGS,
  ProviderInstanceId,
  type ClientSettings,
  type DesktopBridge,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createLocalStorageStub(): Storage {
  const values = new Map<string, string>();
  return {
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

function testWindow(): Window & typeof globalThis {
  return globalThis.window ?? (globalThis as unknown as Window & typeof globalThis);
}

function installDesktopPersistenceBridge(input: {
  readonly getRendererState: DesktopBridge["getRendererState"];
  readonly setRendererState: DesktopBridge["setRendererState"];
}): void {
  testWindow().desktopBridge = input as DesktopBridge;
}

function installClientSettingsBridge(input: {
  readonly getClientSettings: DesktopBridge["getClientSettings"];
  readonly setClientSettings: DesktopBridge["setClientSettings"];
}): void {
  testWindow().desktopBridge = input as DesktopBridge;
}

describe("desktop client persistence races", () => {
  beforeEach(() => {
    vi.resetModules();
    if (globalThis.window === undefined) {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: globalThis,
      });
    }
    const localStorage = createLocalStorageStub();
    Object.defineProperty(testWindow(), "localStorage", {
      configurable: true,
      value: localStorage,
    });
    Object.defineProperty(testWindow(), "addEventListener", {
      configurable: true,
      value: vi.fn(),
    });
    vi.stubGlobal("localStorage", localStorage);
  });

  afterEach(() => {
    Reflect.deleteProperty(testWindow(), "desktopBridge");
    vi.unstubAllGlobals();
  });

  it("cancels a late UI snapshot and durably flushes the post-timeout mutation", async () => {
    const initialRead = deferred<string | null>();
    const recoveryRead = deferred<string | null>();
    const write = deferred<void>();
    const setRendererState = vi.fn<DesktopBridge["setRendererState"]>(() => write.promise);
    const getRendererState = vi
      .fn()
      .mockImplementationOnce(() => initialRead.promise)
      .mockImplementation(() => recoveryRead.promise);
    installDesktopPersistenceBridge({
      getRendererState,
      setRendererState,
    });
    const uiState = await import("./uiStateStore");
    const hydration = uiState.hydrateUiStateStore();

    uiState.continueUiStatePersistenceHydrationInBackground();
    uiState.useUiStateStore.setState({ projectOrder: ["project-new"] });
    recoveryRead.resolve('{"projectOrder":["project-old"]}');
    await vi.waitFor(() => {
      expect(setRendererState).toHaveBeenCalledOnce();
    });

    expect(setRendererState.mock.calls[0]?.[0]).toBe("ui-state");
    expect(JSON.parse(setRendererState.mock.calls[0]?.[1] ?? "{}")).toMatchObject({
      projectOrder: ["project-new"],
    });

    write.resolve();
    initialRead.resolve('{"projectOrder":["project-old"]}');
    await hydration;
    await uiState.flushUiStatePersistence();

    expect(uiState.useUiStateStore.getState().projectOrder).toEqual(["project-new"]);
  });

  it("re-enables UI persistence after a transient hydration read failure", async () => {
    const setRendererState = vi.fn().mockResolvedValue(undefined);
    const getRendererState = vi
      .fn()
      .mockRejectedValueOnce(new Error("IPC read failed"))
      .mockResolvedValue('{"projectOrder":["project-from-disk"]}');
    installDesktopPersistenceBridge({
      getRendererState,
      setRendererState,
    });
    const uiState = await import("./uiStateStore");

    await uiState.hydrateUiStateStore();
    expect(getRendererState).toHaveBeenCalledTimes(2);
    expect(uiState.useUiStateStore.getState().projectOrder).toEqual(["project-from-disk"]);
    uiState.useUiStateStore.setState({ projectOrder: ["project-after-error"] });
    await uiState.flushUiStatePersistence();

    expect(setRendererState).toHaveBeenCalledOnce();
    expect(JSON.parse(setRendererState.mock.calls[0]?.[1] ?? "{}")).toMatchObject({
      projectOrder: ["project-after-error"],
    });
  });

  it("keeps malformed durable UI state protected from later writes", async () => {
    const setRendererState = vi.fn().mockResolvedValue(undefined);
    installDesktopPersistenceBridge({
      getRendererState: vi.fn().mockResolvedValue('{"projectOrder":'),
      setRendererState,
    });
    const uiState = await import("./uiStateStore");

    await uiState.hydrateUiStateStore();
    uiState.useUiStateStore.setState({ projectOrder: ["must-not-overwrite"] });
    await uiState.flushUiStatePersistence();

    expect(setRendererState).not.toHaveBeenCalled();
  });

  it("cancels a late model snapshot and awaits the latest composer preference write", async () => {
    const initialRead = deferred<string | null>();
    const recoveryRead = deferred<string | null>();
    const write = deferred<void>();
    const setRendererState = vi.fn<DesktopBridge["setRendererState"]>(() => write.promise);
    const getRendererState = vi
      .fn()
      .mockImplementationOnce(() => initialRead.promise)
      .mockImplementation(() => recoveryRead.promise);
    installDesktopPersistenceBridge({
      getRendererState,
      setRendererState,
    });
    const composer = await import("./composerDraftStore");
    const hydration = composer.hydrateComposerPreferences();

    composer.continueComposerPreferencesHydrationInBackground();
    composer.useComposerDraftStore.setState({
      stickyActiveProvider: ProviderInstanceId.make("codex"),
    });
    recoveryRead.resolve(
      '{"version":1,"stickyModelSelectionByProvider":{},"stickyActiveProvider":"claudeAgent"}',
    );
    await vi.waitFor(() => {
      expect(setRendererState).toHaveBeenCalledOnce();
    });

    expect(setRendererState.mock.calls[0]?.[0]).toBe("composer-preferences");
    expect(JSON.parse(setRendererState.mock.calls[0]?.[1] ?? "{}")).toMatchObject({
      stickyActiveProvider: "codex",
    });

    write.resolve();
    initialRead.resolve(
      '{"version":1,"stickyModelSelectionByProvider":{},"stickyActiveProvider":"claudeAgent"}',
    );
    await hydration;
    await composer.flushComposerPreferencesPersistence();

    expect(composer.useComposerDraftStore.getState().stickyActiveProvider).toBe("codex");
  });

  it("merges a post-timeout client edit into every untouched durable sidebar preference", async () => {
    const initialRead = deferred<ClientSettings | null>();
    const recoveryRead = deferred<ClientSettings | null>();
    const setClientSettings = vi.fn<DesktopBridge["setClientSettings"]>().mockResolvedValue();
    const getClientSettings = vi
      .fn<DesktopBridge["getClientSettings"]>()
      .mockImplementationOnce(() => initialRead.promise)
      .mockImplementation(() => recoveryRead.promise);
    installClientSettingsBridge({ getClientSettings, setClientSettings });
    const settings = await import("./hooks/useSettings");
    const hydration = settings.hydrateClientSettings();
    const savedSettings = {
      ...DEFAULT_CLIENT_SETTINGS,
      sidebarProjectSortOrder: "manual",
      sidebarProjectGroupingMode: "repository",
      sidebarProjectGroupingOverrides: {
        "/repo/special": "separate",
      },
      sidebarThreadSortOrder: "created_at",
      sidebarThreadFilters: {
        groupByProject: true,
        statuses: ["unread"],
      },
    } as ClientSettings;

    settings.continueClientSettingsHydrationInBackground();
    settings.updateClientSettings({ timestampFormat: "24-hour" });
    recoveryRead.resolve(savedSettings);
    await vi.waitFor(() => {
      expect(setClientSettings).toHaveBeenCalledOnce();
    });

    expect(setClientSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        sidebarProjectSortOrder: "manual",
        sidebarProjectGroupingMode: "repository",
        sidebarProjectGroupingOverrides: {
          "/repo/special": "separate",
        },
        sidebarThreadSortOrder: "created_at",
        sidebarThreadFilters: {
          groupByProject: true,
          statuses: ["unread"],
        },
        timestampFormat: "24-hour",
      }),
    );

    const immediateWrite = deferred<void>();
    const shutdownWrite = deferred<void>();
    setClientSettings
      .mockImplementationOnce(() => immediateWrite.promise)
      .mockImplementationOnce(() => shutdownWrite.promise);
    settings.updateClientSettings({ wordWrap: false });
    const shutdownFlush = settings.flushClientSettingsPersistence();
    let shutdownFlushSettled = false;
    void shutdownFlush.then(() => {
      shutdownFlushSettled = true;
    });
    await vi.waitFor(() => {
      expect(setClientSettings).toHaveBeenCalledTimes(2);
    });
    expect(shutdownFlushSettled).toBe(false);

    immediateWrite.resolve();
    await vi.waitFor(() => {
      expect(setClientSettings).toHaveBeenCalledTimes(3);
    });
    expect(setClientSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sidebarProjectSortOrder: "manual",
        sidebarThreadFilters: {
          groupByProject: true,
          statuses: ["unread"],
        },
        timestampFormat: "24-hour",
        wordWrap: false,
      }),
    );
    expect(shutdownFlushSettled).toBe(false);

    shutdownWrite.resolve();
    await shutdownFlush;
    initialRead.resolve(savedSettings);
    await hydration;
  });
});
