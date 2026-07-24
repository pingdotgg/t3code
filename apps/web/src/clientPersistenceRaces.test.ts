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
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps one UI hydration read in flight and reconciles repeated local mutations", async () => {
    const initialRead = deferred<string | null>();
    const setRendererState = vi.fn<DesktopBridge["setRendererState"]>().mockResolvedValue();
    const getRendererState = vi.fn(() => initialRead.promise);
    installDesktopPersistenceBridge({
      getRendererState,
      setRendererState,
    });
    const uiState = await import("./uiStateStore");
    uiState.useUiStateStore.setState({
      threadChangedFilesExpandedById: {
        "thread-1": {
          "turn-baseline": false,
        },
      },
    });
    const hydration = uiState.hydrateUiStateStore();

    uiState.continueUiStatePersistenceHydrationInBackground();
    uiState.useUiStateStore.setState({
      projectOrder: ["project-new"],
      threadChangedFilesExpandedById: {
        "thread-1": {
          "turn-baseline": false,
          "turn-local": false,
        },
      },
    });
    uiState.continueUiStatePersistenceHydrationInBackground();

    expect(getRendererState).toHaveBeenCalledOnce();
    initialRead.resolve(
      JSON.stringify({
        projectOrder: ["project-old"],
        threadChangedFilesExpandedById: {
          "thread-1": {
            "turn-baseline": false,
            "turn-durable": false,
          },
        },
      }),
    );
    await hydration;

    expect(getRendererState).toHaveBeenCalledOnce();
    expect(uiState.useUiStateStore.getState().projectOrder).toEqual(["project-new"]);
    expect(uiState.useUiStateStore.getState().threadChangedFilesExpandedById).toEqual({
      "thread-1": {
        "turn-baseline": false,
        "turn-durable": false,
        "turn-local": false,
      },
    });
    expect(setRendererState).toHaveBeenCalledOnce();
    expect(JSON.parse(setRendererState.mock.calls[0]?.[1] ?? "{}")).toMatchObject({
      projectOrder: ["project-new"],
      threadChangedFilesExpandedById: {
        "thread-1": {
          "turn-baseline": false,
          "turn-durable": false,
          "turn-local": false,
        },
      },
    });
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

  it("keeps one composer hydration read in flight and preserves a local provider change", async () => {
    const initialRead = deferred<string | null>();
    const setRendererState = vi.fn<DesktopBridge["setRendererState"]>().mockResolvedValue();
    const getRendererState = vi.fn(() => initialRead.promise);
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
    composer.continueComposerPreferencesHydrationInBackground();
    expect(getRendererState).toHaveBeenCalledOnce();
    initialRead.resolve(
      '{"version":1,"stickyModelSelectionByProvider":{},"stickyActiveProvider":"claudeAgent"}',
    );
    await hydration;

    expect(getRendererState).toHaveBeenCalledOnce();
    expect(setRendererState).toHaveBeenCalledOnce();
    expect(setRendererState.mock.calls[0]?.[0]).toBe("composer-preferences");
    expect(JSON.parse(setRendererState.mock.calls[0]?.[1] ?? "{}")).toMatchObject({
      stickyActiveProvider: "codex",
    });
    expect(composer.useComposerDraftStore.getState().stickyActiveProvider).toBe("codex");
  });

  it("merges a post-timeout client edit into every untouched durable sidebar preference", async () => {
    const initialRead = deferred<ClientSettings | null>();
    const setClientSettings = vi.fn<DesktopBridge["setClientSettings"]>().mockResolvedValue();
    const getClientSettings = vi.fn<DesktopBridge["getClientSettings"]>(() => initialRead.promise);
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
    expect(getClientSettings).toHaveBeenCalledOnce();
    initialRead.resolve(savedSettings);
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
    await hydration;
  });

  it("waits for slow client-settings hydration before flushing a guarded edit", async () => {
    const read = deferred<ClientSettings | null>();
    const setClientSettings = vi.fn<DesktopBridge["setClientSettings"]>().mockResolvedValue();
    installClientSettingsBridge({
      getClientSettings: vi.fn(() => read.promise),
      setClientSettings,
    });
    const settings = await import("./hooks/useSettings");
    void settings.hydrateClientSettings();
    settings.updateClientSettings({ timestampFormat: "24-hour" });

    const flush = settings.flushClientSettingsPersistence();
    let flushSettled = false;
    void flush.then(() => {
      flushSettled = true;
    });
    await Promise.resolve();
    expect(flushSettled).toBe(false);
    expect(setClientSettings).not.toHaveBeenCalled();

    read.resolve(DEFAULT_CLIENT_SETTINGS);
    await flush;

    expect(setClientSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ timestampFormat: "24-hour" }),
    );
  });

  it("waits for slow UI-state hydration before flushing a guarded edit", async () => {
    const read = deferred<string | null>();
    const setRendererState = vi.fn<DesktopBridge["setRendererState"]>().mockResolvedValue();
    installDesktopPersistenceBridge({
      getRendererState: vi.fn(() => read.promise),
      setRendererState,
    });
    const uiState = await import("./uiStateStore");
    void uiState.hydrateUiStateStore();
    uiState.useUiStateStore.setState({ projectOrder: ["project-local"] });

    const flush = uiState.flushUiStatePersistence();
    let flushSettled = false;
    void flush.then(() => {
      flushSettled = true;
    });
    await Promise.resolve();
    expect(flushSettled).toBe(false);
    expect(setRendererState).not.toHaveBeenCalled();

    read.resolve('{"projectOrder":["project-durable"]}');
    await flush;

    expect(JSON.parse(setRendererState.mock.calls.at(-1)?.[1] ?? "{}")).toMatchObject({
      projectOrder: ["project-local"],
    });
  });

  it("waits for slow composer hydration before flushing a guarded edit", async () => {
    const read = deferred<string | null>();
    const setRendererState = vi.fn<DesktopBridge["setRendererState"]>().mockResolvedValue();
    installDesktopPersistenceBridge({
      getRendererState: vi.fn(() => read.promise),
      setRendererState,
    });
    const composer = await import("./composerDraftStore");
    void composer.hydrateComposerPreferences();
    composer.useComposerDraftStore.setState({
      stickyActiveProvider: ProviderInstanceId.make("codex"),
    });

    const flush = composer.flushComposerPreferencesPersistence();
    let flushSettled = false;
    void flush.then(() => {
      flushSettled = true;
    });
    await Promise.resolve();
    expect(flushSettled).toBe(false);
    expect(setRendererState).not.toHaveBeenCalled();

    read.resolve(
      '{"version":1,"stickyModelSelectionByProvider":{},"stickyActiveProvider":"claudeAgent"}',
    );
    await flush;

    expect(JSON.parse(setRendererState.mock.calls.at(-1)?.[1] ?? "{}")).toMatchObject({
      stickyActiveProvider: "codex",
    });
  });

  it("lets durable composer preferences win over sticky fields in the draft store", async () => {
    testWindow().localStorage.setItem(
      "t3code:composer-drafts:v1",
      JSON.stringify({
        version: 8,
        state: {
          stickyModelSelectionByProvider: {
            codex: { instanceId: "codex", model: "gpt-legacy" },
          },
          stickyActiveProvider: "codex",
        },
      }),
    );
    const setRendererState = vi.fn<DesktopBridge["setRendererState"]>().mockResolvedValue();
    installDesktopPersistenceBridge({
      getRendererState: vi.fn().mockResolvedValue(
        JSON.stringify({
          version: 1,
          stickyModelSelectionByProvider: {
            claudeAgent: {
              instanceId: "claudeAgent",
              model: "claude-durable",
            },
          },
          stickyActiveProvider: "claudeAgent",
        }),
      ),
      setRendererState,
    });

    const composer = await import("./composerDraftStore");
    await composer.hydrateComposerPreferences();

    expect(composer.useComposerDraftStore.getState()).toMatchObject({
      stickyModelSelectionByProvider: {
        claudeAgent: {
          instanceId: "claudeAgent",
          model: "claude-durable",
        },
      },
      stickyActiveProvider: "claudeAgent",
    });
    expect(setRendererState).not.toHaveBeenCalled();
  });

  it("migrates pre-v3 sticky composer preferences out of the legacy draft document", async () => {
    testWindow().localStorage.setItem(
      "t3code:composer-drafts:v1",
      JSON.stringify({
        version: 2,
        state: {
          stickyProvider: "codex",
          stickyModelSelection: {
            provider: "codex",
            model: "gpt-legacy",
          },
          stickyModelOptions: {
            codex: {
              reasoningEffort: "high",
              fastMode: true,
            },
          },
        },
      }),
    );
    const setRendererState = vi.fn<DesktopBridge["setRendererState"]>().mockResolvedValue();
    installDesktopPersistenceBridge({
      getRendererState: vi.fn().mockResolvedValue(null),
      setRendererState,
    });

    const composer = await import("./composerDraftStore");
    await composer.hydrateComposerPreferences();

    expect(composer.useComposerDraftStore.getState()).toMatchObject({
      stickyModelSelectionByProvider: {
        codex: {
          instanceId: "codex",
          model: "gpt-legacy",
          options: [
            { id: "reasoningEffort", value: "high" },
            { id: "fastMode", value: true },
          ],
        },
      },
      stickyActiveProvider: "codex",
    });
    expect(setRendererState).toHaveBeenCalledOnce();
    expect(setRendererState.mock.calls[0]?.[0]).toBe("composer-preferences");
    expect(JSON.parse(setRendererState.mock.calls[0]?.[1] ?? "{}")).toEqual({
      version: 1,
      stickyModelSelectionByProvider: {
        codex: {
          instanceId: "codex",
          model: "gpt-legacy",
          options: [
            { id: "reasoningEffort", value: "high" },
            { id: "fastMode", value: true },
          ],
        },
      },
      stickyActiveProvider: "codex",
    });
    expect(testWindow().localStorage.getItem("t3code:composer-drafts:v1")).not.toBeNull();
  });

  it("keeps the active provider when its model changes during hydration", async () => {
    const read = deferred<string | null>();
    const setRendererState = vi.fn<DesktopBridge["setRendererState"]>().mockResolvedValue();
    installDesktopPersistenceBridge({
      getRendererState: vi.fn(() => read.promise),
      setRendererState,
    });
    const composer = await import("./composerDraftStore");
    composer.useComposerDraftStore.setState({
      stickyModelSelectionByProvider: {
        [ProviderInstanceId.make("codex")]: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-baseline",
        },
      },
      stickyActiveProvider: ProviderInstanceId.make("codex"),
    });
    const hydration = composer.hydrateComposerPreferences();
    composer.useComposerDraftStore.setState({
      stickyModelSelectionByProvider: {
        [ProviderInstanceId.make("codex")]: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-local",
        },
      },
    });

    read.resolve(
      JSON.stringify({
        version: 1,
        stickyModelSelectionByProvider: {
          claudeAgent: { instanceId: "claudeAgent", model: "claude-durable" },
          codex: { instanceId: "codex", model: "gpt-durable" },
        },
        stickyActiveProvider: "claudeAgent",
      }),
    );
    await hydration;

    expect(composer.useComposerDraftStore.getState()).toMatchObject({
      stickyModelSelectionByProvider: {
        claudeAgent: { instanceId: "claudeAgent", model: "claude-durable" },
        codex: { instanceId: "codex", model: "gpt-local" },
      },
      stickyActiveProvider: "codex",
    });
  });

  it("retries a transient reconciled UI-state write failure", async () => {
    vi.useFakeTimers();
    const setRendererState = vi
      .fn<DesktopBridge["setRendererState"]>()
      .mockRejectedValueOnce(new Error("write failed"))
      .mockResolvedValue(undefined);
    installDesktopPersistenceBridge({
      getRendererState: vi.fn().mockResolvedValue('{"projectOrder":["project-durable"]}'),
      setRendererState,
    });
    const uiState = await import("./uiStateStore");
    const hydration = uiState.hydrateUiStateStore();
    uiState.useUiStateStore.setState({ projectOrder: ["project-local"] });
    await hydration;

    expect(setRendererState).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => {
      expect(setRendererState).toHaveBeenCalledTimes(2);
    });
    expect(JSON.parse(setRendererState.mock.calls[1]?.[1] ?? "{}")).toMatchObject({
      projectOrder: ["project-local"],
    });
  });

  it("keeps legacy UI state until a durable retry is confirmed", async () => {
    vi.useFakeTimers();
    const legacyKey = "t3code:renderer-state:v8";
    const legacyState = '{"projectOrder":["project-legacy"]}';
    testWindow().localStorage.setItem(legacyKey, legacyState);
    const setRendererState = vi
      .fn<DesktopBridge["setRendererState"]>()
      .mockRejectedValueOnce(new Error("migration write failed"))
      .mockRejectedValueOnce(new Error("retry write failed"))
      .mockResolvedValue(undefined);
    installDesktopPersistenceBridge({
      getRendererState: vi.fn().mockResolvedValue(null),
      setRendererState,
    });
    const uiState = await import("./uiStateStore");

    await uiState.hydrateUiStateStore();
    expect(testWindow().localStorage.getItem(legacyKey)).toBe(legacyState);

    await vi.advanceTimersByTimeAsync(500);
    expect(setRendererState).toHaveBeenCalledTimes(2);
    expect(testWindow().localStorage.getItem(legacyKey)).toBe(legacyState);

    uiState.useUiStateStore.setState({ projectOrder: ["project-after-retry"] });
    await vi.advanceTimersByTimeAsync(500);
    expect(setRendererState).toHaveBeenCalledTimes(3);
    expect(testWindow().localStorage.getItem(legacyKey)).toBeNull();
  });

  it("retries failed debounced composer preference writes", async () => {
    vi.useFakeTimers();
    const setRendererState = vi
      .fn<DesktopBridge["setRendererState"]>()
      .mockRejectedValueOnce(new Error("write failed"))
      .mockResolvedValue(undefined);
    installDesktopPersistenceBridge({
      getRendererState: vi.fn().mockResolvedValue(null),
      setRendererState,
    });
    const composer = await import("./composerDraftStore");
    await composer.hydrateComposerPreferences();
    composer.useComposerDraftStore.setState({
      stickyActiveProvider: ProviderInstanceId.make("codex"),
    });

    await vi.advanceTimersByTimeAsync(300);
    expect(setRendererState).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(300);
    await vi.waitFor(() => {
      expect(setRendererState).toHaveBeenCalledTimes(2);
    });
  });

  it("retries the current composer snapshot during flush after an identical write fails", async () => {
    vi.useFakeTimers();
    const firstWrite = deferred<void>();
    const setRendererState = vi
      .fn<DesktopBridge["setRendererState"]>()
      .mockImplementationOnce(() => firstWrite.promise)
      .mockResolvedValue(undefined);
    installDesktopPersistenceBridge({
      getRendererState: vi.fn().mockResolvedValue(null),
      setRendererState,
    });
    const composer = await import("./composerDraftStore");
    await composer.hydrateComposerPreferences();
    composer.useComposerDraftStore.setState({
      stickyActiveProvider: ProviderInstanceId.make("codex"),
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(setRendererState).toHaveBeenCalledOnce();

    const flush = composer.flushComposerPreferencesPersistence();
    firstWrite.reject(new Error("in-flight write failed"));
    await flush;

    expect(setRendererState).toHaveBeenCalledTimes(2);
    expect(JSON.parse(setRendererState.mock.calls[1]?.[1] ?? "{}")).toMatchObject({
      stickyActiveProvider: "codex",
    });
  });

  it("falls back to initial UI state when browser localStorage reads throw", async () => {
    Reflect.deleteProperty(testWindow(), "desktopBridge");
    const blockedStorage = {
      ...createLocalStorageStub(),
      getItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
    } as Storage;
    Object.defineProperty(testWindow(), "localStorage", {
      configurable: true,
      value: blockedStorage,
    });
    vi.stubGlobal("localStorage", blockedStorage);

    const uiState = await import("./uiStateStore");

    expect(uiState.useUiStateStore.getState().projectOrder).toEqual([]);
  });
});
