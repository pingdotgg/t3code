import {
  BrowserEnginePageStatus,
  type BrowserEngineCommand,
  type BrowserEngineHostStreamEvent,
  type BrowserImportSource,
  type BrowserProfile,
  type DesktopPreviewTabState,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createEngineHostEventHandler,
  executeEngineCommand,
  executeProfileCommand,
  type ProfileCommandDeps,
  forgetHostedTab,
  HANDLED_COMMANDS_LIMIT,
  isHostedEngineClaimPending,
  nextEnginePageReport,
  publishHostProfiles,
  recordHostedTabState,
  toEnginePageStatus,
  useBrowserEngineHostStore,
} from "./browserEngineHost";
import { previewRuntimeTabId } from "./previewRuntimeTabId";

const RUNTIME_TAB = "runtime-tab";

const tabState = (overrides: Partial<DesktopPreviewTabState> = {}): DesktopPreviewTabState => ({
  tabId: RUNTIME_TAB,
  webContentsId: 41,
  navStatus: { kind: "Success", url: "http://localhost:5173/", title: "Dev" },
  canGoBack: true,
  canGoForward: false,
  zoomFactor: 1,
  pictureInPicture: false,
  remoteLive: false,
  colorScheme: "system",
  audioMuted: false,
  audible: false,
  devToolsOpen: false,
  controller: "human",
  updatedAt: "2026-09-26T00:00:00.000Z",
  ...overrides,
});

const makeBridge = () => ({
  navigate: vi.fn(async (_tabId: string, _url: string) => {}),
  goBack: vi.fn(async () => {}),
  goForward: vi.fn(async () => {}),
  refresh: vi.fn(async () => {}),
  hardReload: vi.fn(async () => {}),
  setZoomFactor: vi.fn(async () => {}),
  setColorScheme: vi.fn(async () => {}),
  setAudioMuted: vi.fn(async () => {}),
  openDevTools: vi.fn(async () => {}),
  closeDevTools: vi.fn(async () => {}),
  pictureInPicture: { open: vi.fn(async () => {}), close: vi.fn(async () => {}) },
});

const run = (
  bridge: ReturnType<typeof makeBridge>,
  command: BrowserEngineCommand,
  generation = "41",
) => executeEngineCommand(bridge, RUNTIME_TAB, generation, command);

afterEach(() => forgetHostedTab(RUNTIME_TAB));

describe("executeEngineCommand", () => {
  it("refuses commands for unknown or replaced guests without touching the bridge", async () => {
    const bridge = makeBridge();
    expect(await run(bridge, { _tag: "reload" })).toEqual({
      outcome: "rejected",
      reason: "session-not-found",
    });
    recordHostedTabState(RUNTIME_TAB, tabState({ webContentsId: 42 }));
    expect(await run(bridge, { _tag: "reload" })).toEqual({
      outcome: "rejected",
      reason: "stale-generation",
    });
    expect(bridge.refresh).not.toHaveBeenCalled();
    expect(await run(bridge, { _tag: "navigate", url: "http://localhost:5173/next" })).toEqual({
      outcome: "rejected",
      reason: "stale-generation",
    });
    expect(bridge.navigate).not.toHaveBeenCalled();
  });

  it("loads a navigate on the fenced guest the way the native address bar does", async () => {
    const bridge = makeBridge();
    recordHostedTabState(RUNTIME_TAB, tabState());
    expect(await run(bridge, { _tag: "navigate", url: "http://localhost:5173/next" })).toEqual({
      outcome: "applied",
    });
    expect(bridge.navigate).toHaveBeenCalledExactlyOnceWith(
      RUNTIME_TAB,
      "http://localhost:5173/next",
    );
    bridge.navigate.mockRejectedValueOnce(new Error("guest detached"));
    expect(await run(bridge, { _tag: "navigate", url: "http://localhost:5173/" })).toEqual({
      outcome: "rejected",
      reason: "failed",
    });
  });

  it("routes page verbs to the native bridge for the fenced guest", async () => {
    const bridge = makeBridge();
    recordHostedTabState(RUNTIME_TAB, tabState());
    expect(await run(bridge, { _tag: "back" })).toEqual({ outcome: "applied" });
    expect(await run(bridge, { _tag: "hardReload" })).toEqual({ outcome: "applied" });
    expect(await run(bridge, { _tag: "setAppearance", appearance: "dark" })).toEqual({
      outcome: "applied",
    });
    expect(await run(bridge, { _tag: "setAudioMuted", muted: true })).toEqual({
      outcome: "applied",
    });
    expect(bridge.goBack).toHaveBeenCalledWith(RUNTIME_TAB);
    expect(bridge.hardReload).toHaveBeenCalledWith(RUNTIME_TAB);
    expect(bridge.refresh).not.toHaveBeenCalled();
    expect(bridge.setColorScheme).toHaveBeenCalledWith(RUNTIME_TAB, "dark");
    expect(bridge.setAudioMuted).toHaveBeenCalledWith(RUNTIME_TAB, true);
  });

  it("names history moves that have nowhere to go and bridge failures", async () => {
    const bridge = makeBridge();
    recordHostedTabState(RUNTIME_TAB, tabState({ canGoBack: false }));
    expect(await run(bridge, { _tag: "back" })).toEqual({
      outcome: "rejected",
      reason: "not-applicable",
    });
    expect(await run(bridge, { _tag: "forward" })).toEqual({
      outcome: "rejected",
      reason: "not-applicable",
    });
    bridge.refresh.mockRejectedValueOnce(new Error("guest detached"));
    expect(await run(bridge, { _tag: "reload" })).toEqual({
      outcome: "rejected",
      reason: "failed",
    });
  });

  it("sets any ladder zoom target with one native call, however far it is", async () => {
    const bridge = makeBridge();
    recordHostedTabState(RUNTIME_TAB, tabState({ zoomFactor: 1.25 }));
    expect(await run(bridge, { _tag: "zoom", zoomFactor: 3 })).toEqual({ outcome: "applied" });
    expect(await run(bridge, { _tag: "zoom", zoomFactor: 0.25 })).toEqual({ outcome: "applied" });
    expect(bridge.setZoomFactor.mock.calls).toEqual([
      [RUNTIME_TAB, 3],
      [RUNTIME_TAB, 0.25],
    ]);
    bridge.setZoomFactor.mockRejectedValueOnce(new Error("guest detached"));
    expect(await run(bridge, { _tag: "zoom", zoomFactor: 2 })).toEqual({
      outcome: "rejected",
      reason: "failed",
    });
  });
  it("opens and closes native picture-in-picture only when the guest is not already there", async () => {
    const bridge = makeBridge();
    recordHostedTabState(RUNTIME_TAB, tabState({ pictureInPicture: false }));
    expect(await run(bridge, { _tag: "setPictureInPicture", open: false })).toEqual({
      outcome: "applied",
    });
    expect(bridge.pictureInPicture.close).not.toHaveBeenCalled();
    expect(await run(bridge, { _tag: "setPictureInPicture", open: true })).toEqual({
      outcome: "applied",
    });
    expect(bridge.pictureInPicture.open).toHaveBeenCalledWith(RUNTIME_TAB);

    recordHostedTabState(RUNTIME_TAB, tabState({ pictureInPicture: true }));
    expect(await run(bridge, { _tag: "setPictureInPicture", open: false })).toEqual({
      outcome: "applied",
    });
    expect(bridge.pictureInPicture.close).toHaveBeenCalledWith(RUNTIME_TAB);
    expect(bridge.pictureInPicture.open).toHaveBeenCalledTimes(1);

    recordHostedTabState(RUNTIME_TAB, tabState({ pictureInPicture: false }));
    bridge.pictureInPicture.open.mockRejectedValueOnce(new Error("webview changed"));
    expect(await run(bridge, { _tag: "setPictureInPicture", open: true })).toEqual({
      outcome: "rejected",
      reason: "failed",
    });
  });
});

describe("setDevToolsOpen", () => {
  it("opens and closes DevTools on the fenced guest only", async () => {
    const bridge = makeBridge();
    expect(await run(bridge, { _tag: "setDevToolsOpen", open: true })).toEqual({
      outcome: "rejected",
      reason: "session-not-found",
    });
    recordHostedTabState(RUNTIME_TAB, tabState());
    expect(await run(bridge, { _tag: "setDevToolsOpen", open: true }, "40")).toEqual({
      outcome: "rejected",
      reason: "stale-generation",
    });
    expect(bridge.openDevTools).not.toHaveBeenCalled();
    expect(await run(bridge, { _tag: "setDevToolsOpen", open: true })).toEqual({
      outcome: "applied",
    });
    expect(await run(bridge, { _tag: "setDevToolsOpen", open: false })).toEqual({
      outcome: "applied",
    });
    expect(bridge.openDevTools.mock.calls).toEqual([[RUNTIME_TAB]]);
    expect(bridge.closeDevTools.mock.calls).toEqual([[RUNTIME_TAB]]);
    bridge.closeDevTools.mockRejectedValueOnce(new Error("guest detached"));
    expect(await run(bridge, { _tag: "setDevToolsOpen", open: false })).toEqual({
      outcome: "rejected",
      reason: "failed",
    });
  });

  it("answers not-applicable when the desktop shell has no DevTools IPC", async () => {
    const { closeDevTools: _closeDevTools, ...olderShell } = makeBridge();
    recordHostedTabState(RUNTIME_TAB, tabState());
    expect(
      await executeEngineCommand(olderShell as ReturnType<typeof makeBridge>, RUNTIME_TAB, "41", {
        _tag: "setDevToolsOpen",
        open: false,
      }),
    ).toEqual({ outcome: "rejected", reason: "not-applicable" });
  });

  it("reports each DevTools flip once and stays quiet on repeats", () => {
    const decode = Schema.decodeUnknownSync(BrowserEnginePageStatus);
    const first = nextEnginePageReport(null, tabState());
    expect(first).not.toBeNull();
    // A repeated desktop event with nothing projected changed sends nothing.
    expect(nextEnginePageReport(first!.statusKey, tabState())).toBeNull();
    expect(
      nextEnginePageReport(first!.statusKey, tabState({ updatedAt: "2026-09-27T00:00:00.000Z" })),
    ).toBeNull();
    // DevTools opening alone is a new report the server contract accepts.
    const opened = nextEnginePageReport(first!.statusKey, tabState({ devToolsOpen: true }));
    expect(opened).not.toBeNull();
    expect(decode(opened!.status)).toMatchObject({ devToolsOpen: true });
    expect(nextEnginePageReport(opened!.statusKey, tabState({ devToolsOpen: true }))).toBeNull();
    // Closing reports again rather than being swallowed as a repeat.
    const closed = nextEnginePageReport(opened!.statusKey, tabState());
    expect(closed?.status.devToolsOpen).toBe(false);
  });
});

describe("toEnginePageStatus", () => {
  it("does not report per-action controller or remote activity transitions", () => {
    const first = nextEnginePageReport(null, tabState());
    expect(first).not.toBeNull();
    expect(first!.status).not.toHaveProperty("controller");
    expect(first!.status).not.toHaveProperty("remoteLive");
    for (let actionIndex = 0; actionIndex < 200; actionIndex += 1) {
      for (const controller of ["agent", "none", "human", "none"] as const) {
        expect(
          nextEnginePageReport(
            first!.statusKey,
            tabState({
              controller,
              remoteLive: controller === "agent",
              updatedAt: `${actionIndex}`,
            }),
          ),
        ).toBeNull();
      }
    }
    expect(decode({ ...first!.status, controller: "agent", remoteLive: true })).toEqual(
      first!.status,
    );
  });

  const decode = Schema.decodeUnknownSync(BrowserEnginePageStatus);

  it("produces a report the server contract accepts", () => {
    const status = toEnginePageStatus(
      tabState({
        navStatus: { kind: "Loading", url: "http://localhost:5173/", title: "x".repeat(900) },
        zoomFactor: 1.2499999,
        colorScheme: "dark",
        audible: true,
        favicon: {
          dataUrl: "data:image/png;base64,AAAA",
          pageUrl: "http://localhost:5173/",
          capturedAt: 1,
        },
      }),
    );
    expect(decode(status)).toEqual(status);
    expect(status.zoomFactor).toBe(1.25);
    expect(status.pictureInPicture).toBe(false);
    expect(toEnginePageStatus(tabState({ pictureInPicture: true })).pictureInPicture).toBe(true);
    expect(status.favicon).toEqual({
      dataUrl: "data:image/png;base64,AAAA",
      pageUrl: "http://localhost:5173/",
    });
  });

  it("drops an oversized favicon rather than failing the whole report", () => {
    const status = toEnginePageStatus(
      tabState({
        favicon: {
          dataUrl: `data:image/png;base64,${"A".repeat(9000)}`,
          pageUrl: "http://localhost:5173/",
          capturedAt: 1,
        },
      }),
    );
    expect(status.favicon).toBeNull();
    expect(decode(status)).toEqual(status);
  });
});

describe("createEngineHostEventHandler", () => {
  const environmentId = EnvironmentId.make("env-host");
  const threadId = ThreadId.make("thread-host");
  const hostedTab = previewRuntimeTabId({ environmentId, threadId }, "epoch-1", "tab-1");
  const hostIdOf = () =>
    useBrowserEngineHostStore.getState().hostConnectionIdByEnvironment[environmentId];
  const command = (commandId: string): BrowserEngineHostStreamEvent => ({
    type: "command",
    commandId,
    target: { threadId, tabId: "tab-1", serverEpoch: "epoch-1" },
    engineGeneration: "41",
    command: { _tag: "reload" },
  });
  const setup = () => {
    const bridge = makeBridge();
    const sendResult = vi.fn();
    const onResult = createEngineHostEventHandler({
      environmentId,
      bridge,
      sendResult,
      profiles: async () => ({ profiles: [], defaultProfileId: "default" }),
      confirm: async () => false,
    });
    const deliver = (event: BrowserEngineHostStreamEvent) => onResult(AsyncResult.success(event));
    return { bridge, sendResult, onResult, deliver };
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  /** A desktop with one Chrome profile whose prompt the test answers by hand. */
  const importSetup = () => {
    const bridge = {
      ...makeBridge(),
      listBrowserImportSources: vi.fn(async (): Promise<ReadonlyArray<BrowserImportSource>> => [
        { id: "chrome", name: "Google Chrome", profiles: [{ directory: "Default", name: "Me" }] },
      ]),
      importBrowserCookies: vi.fn(async () => ({ imported: 3, skipped: 0, skippedDomains: [] })),
    };
    const sendResult = vi.fn();
    let answer!: (confirmed: boolean) => void;
    let promptSignal!: AbortSignal;
    const onResult = createEngineHostEventHandler({
      environmentId,
      bridge,
      sendResult,
      profiles: async () => ({
        profiles: [{ id: "work", name: "Work", kind: "persistent" }],
        defaultProfileId: "work",
      }),
      confirm: (_message, signal) => {
        promptSignal = signal;
        return new Promise<boolean>((resolve) => {
          answer = resolve;
        });
      },
    });
    const deliver = (event: BrowserEngineHostStreamEvent) => onResult(AsyncResult.success(event));
    deliver({ type: "registered", hostConnectionId: "host-1" });
    deliver({
      type: "profile-command",
      commandId: "import-1",
      command: {
        _tag: "importCookies",
        profileId: "work",
        sourceId: "chrome",
        sourceProfile: "p0",
        requester: "t3.browser",
      },
    });
    const results = () => sendResult.mock.calls.map(([input]) => input.result);
    return {
      bridge,
      deliver,
      results,
      accept: () => answer(true),
      promptSignal: () => promptSignal,
    };
  };

  afterEach(() => {
    forgetHostedTab(hostedTab);
    useBrowserEngineHostStore.getState().setHostConnectionId(environmentId, null);
  });

  it("tracks the registered host id and clears it when registration fails", () => {
    const { onResult, deliver } = setup();
    onResult(AsyncResult.initial(true));
    expect(hostIdOf()).toBeUndefined();
    deliver({ type: "registered", hostConnectionId: "host-1" });
    expect(hostIdOf()).toBe("host-1");
    onResult(AsyncResult.failure(Cause.fail("desktop-required")));
    expect(hostIdOf()).toBeNull();
    expect(isHostedEngineClaimPending(environmentId)).toBe(false);
  });

  it("runs a command on its fenced guest once and answers under the host id", async () => {
    const { bridge, sendResult, deliver } = setup();
    recordHostedTabState(hostedTab, tabState({ tabId: hostedTab }));
    // Nothing runs before the stream has registered this window.
    deliver(command("early"));
    await settle();
    expect(bridge.refresh).not.toHaveBeenCalled();

    deliver({ type: "registered", hostConnectionId: "host-1" });
    deliver(command("command-1"));
    deliver(command("command-1"));
    await settle();
    expect(bridge.refresh).toHaveBeenCalledTimes(1);
    expect(bridge.refresh).toHaveBeenCalledWith(hostedTab);
    expect(sendResult.mock.calls).toEqual([
      [{ hostConnectionId: "host-1", commandId: "command-1", result: { outcome: "applied" } }],
    ]);
  });

  it("imports only once the server lets a confirmed import proceed", async () => {
    const { bridge, deliver, results, accept } = importSetup();
    await settle();
    accept();
    await settle();
    expect(results()).toEqual([{ outcome: "confirmed" }]);
    expect(bridge.importBrowserCookies).not.toHaveBeenCalled();
    deliver({ type: "profile-command-proceed", commandId: "import-1" });
    await settle();
    expect(bridge.importBrowserCookies).toHaveBeenCalledOnce();
    expect(results()).toEqual([
      { outcome: "confirmed" },
      { outcome: "imported", imported: 3, skipped: 0 },
    ]);
  });

  it("a cancel dismisses the prompt and accepting it afterwards reads nothing", async () => {
    const { bridge, deliver, results, accept, promptSignal } = importSetup();
    await settle();
    deliver({ type: "profile-command-cancel", commandId: "import-1" });
    expect(promptSignal().aborted).toBe(true);
    // The user clicks accept on a prompt that was still on screen.
    accept();
    await settle();
    expect(bridge.importBrowserCookies).not.toHaveBeenCalled();
    expect(results()).toEqual([{ outcome: "rejected", reason: "cancelled" }]);
  });

  it("a cancel after the user confirmed still reads nothing", async () => {
    const { bridge, deliver, results, accept } = importSetup();
    await settle();
    accept();
    await settle();
    deliver({ type: "profile-command-cancel", commandId: "import-1" });
    await settle();
    expect(bridge.importBrowserCookies).not.toHaveBeenCalled();
    expect(results()).toEqual([
      { outcome: "confirmed" },
      { outcome: "rejected", reason: "cancelled" },
    ]);
  });

  it("forgets the oldest handled id once the replay window is full", async () => {
    const { bridge, deliver } = setup();
    recordHostedTabState(hostedTab, tabState({ tabId: hostedTab }));
    deliver({ type: "registered", hostConnectionId: "host-1" });
    for (let index = 0; index <= HANDLED_COMMANDS_LIMIT; index += 1) {
      deliver(command(`command-${index}`));
    }
    await settle();
    expect(bridge.refresh).toHaveBeenCalledTimes(HANDLED_COMMANDS_LIMIT + 1);
    // The newest ids are still guarded; the evicted oldest one is not.
    deliver(command(`command-${HANDLED_COMMANDS_LIMIT}`));
    deliver(command("command-0"));
    await settle();
    expect(bridge.refresh).toHaveBeenCalledTimes(HANDLED_COMMANDS_LIMIT + 2);
  });
});

describe("publishHostProfiles", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const WORK: BrowserProfile = { id: "work", name: "Work", kind: "persistent" };

  /** A settings store whose listeners the test fires, as useSettings does on any change. */
  const setup = () => {
    let settings = { profiles: [WORK], defaultProfileId: "default" };
    const listeners = new Set<() => void>();
    const send = vi.fn();
    const stop = publishHostProfiles({
      hostConnectionId: "host-1",
      profiles: async () => settings,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      send,
    });
    const change = async (next?: typeof settings) => {
      if (next) settings = next;
      for (const listener of listeners) listener();
      await settle();
    };
    return { send, stop, change, listeners };
  };

  it("publishes once registered, then only when the profile list changes", async () => {
    const { send, change } = setup();
    await settle();
    expect(send.mock.calls).toEqual([
      [
        {
          hostConnectionId: "host-1",
          profiles: [{ id: "work", name: "Work" }],
          defaultProfileId: "default",
        },
      ],
    ]);
    // Another setting (zoom, viewport…) changed: the list did not.
    await change();
    expect(send).toHaveBeenCalledTimes(1);
    await change({ profiles: [{ ...WORK, name: "Client work" }], defaultProfileId: "default" });
    await change({ profiles: [{ ...WORK, name: "Client work" }], defaultProfileId: "work" });
    await change({ profiles: [], defaultProfileId: "default" });
    expect(send.mock.calls.slice(1).map(([input]) => input)).toEqual([
      {
        hostConnectionId: "host-1",
        profiles: [{ id: "work", name: "Client work" }],
        defaultProfileId: "default",
      },
      {
        hostConnectionId: "host-1",
        profiles: [{ id: "work", name: "Client work" }],
        defaultProfileId: "work",
      },
      { hostConnectionId: "host-1", profiles: [], defaultProfileId: "default" },
    ]);
  });

  it("stops listening and publishing once stopped", async () => {
    const { send, stop, change, listeners } = setup();
    await settle();
    stop();
    expect(listeners.size).toBe(0);
    await change({ profiles: [], defaultProfileId: "default" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("follows the registration: a new host id publishes afresh, a lost one stops", () => {
    const registrations: Array<string | null> = [];
    const onResult = createEngineHostEventHandler({
      environmentId: EnvironmentId.make("env-publish"),
      bridge: null,
      sendResult: vi.fn(),
      profiles: async () => ({ profiles: [], defaultProfileId: "default" }),
      confirm: async () => false,
      onRegistration: (hostConnectionId) => registrations.push(hostConnectionId),
    });
    onResult(AsyncResult.success({ type: "registered", hostConnectionId: "host-1" }));
    onResult(AsyncResult.failure(Cause.fail("desktop-required")));
    onResult(AsyncResult.success({ type: "registered", hostConnectionId: "host-2" }));
    expect(registrations).toEqual(["host-1", null, "host-2"]);
    useBrowserEngineHostStore.getState().setHostConnectionId("env-publish", null);
  });
});

describe("executeProfileCommand", () => {
  const environmentId = EnvironmentId.make("env-profiles");
  const PROFILES = [
    { id: "default", name: "Default", kind: "persistent" as const },
    { id: "incognito", name: "Incognito", kind: "incognito" as const },
    { id: "work", name: "Work", kind: "persistent" as const },
  ];
  const SOURCES: ReadonlyArray<BrowserImportSource> = [
    {
      id: "chrome",
      name: "Google Chrome",
      profiles: [
        { directory: "Default", name: "Person 1", cookieCount: 40 },
        { directory: "Profile 3", name: "Work account" },
      ],
    },
    { id: "safari", name: "Safari", profiles: [], unavailable: "needsFullDiskAccess" },
  ];
  const makeDeps = (overrides: Partial<ProfileCommandDeps> = {}) => {
    const bridge = {
      clearCookies: vi.fn(async (_environmentId: EnvironmentId, _profileId?: string) => {}),
      clearCache: vi.fn(async (_environmentId: EnvironmentId, _profileId?: string) => {}),
      listBrowserImportSources: vi.fn(async () => SOURCES),
      importBrowserCookies: vi.fn(async () => ({
        imported: 38,
        skipped: 2,
        skippedDomains: ["expired.example"],
      })),
    };
    const confirm = vi.fn(async (_message: string, _signal: AbortSignal) => true);
    const deps: ProfileCommandDeps = {
      environmentId,
      bridge,
      profiles: async () => ({ profiles: PROFILES, defaultProfileId: "work" }),
      confirm,
      signal: new AbortController().signal,
      proceed: async () => true,
      ...overrides,
    };
    return { deps, bridge, confirm };
  };

  it("lists opaque ids and names with the default new tabs open under", async () => {
    const { deps } = makeDeps();
    expect(await executeProfileCommand(deps, { _tag: "listProfiles" })).toEqual({
      outcome: "profiles",
      profiles: [
        { id: "default", name: "Default" },
        { id: "incognito", name: "Incognito" },
        { id: "work", name: "Work" },
      ],
      defaultProfileId: "work",
    });
  });

  it("clears exactly the named profile's partition, never every partition", async () => {
    const { deps, bridge } = makeDeps();
    expect(await executeProfileCommand(deps, { _tag: "clearCookies", profileId: "work" })).toEqual({
      outcome: "applied",
    });
    expect(bridge.clearCookies).toHaveBeenCalledExactlyOnceWith(environmentId, "work");
    expect(bridge.clearCache).not.toHaveBeenCalled();
    expect(await executeProfileCommand(deps, { _tag: "clearCache", profileId: "default" })).toEqual(
      { outcome: "applied" },
    );
    expect(bridge.clearCache).toHaveBeenCalledExactlyOnceWith(environmentId, "default");
    expect(bridge.clearCookies).toHaveBeenCalledTimes(1);
  });

  it("refuses a profile the settings list does not hold without touching the bridge", async () => {
    const { deps, bridge, confirm } = makeDeps();
    for (const command of [
      { _tag: "clearCookies", profileId: "removed" },
      { _tag: "clearCache", profileId: "removed" },
      {
        _tag: "importCookies",
        profileId: "removed",
        sourceId: "chrome",
        sourceProfile: "p0",
        requester: "t3.browser",
      },
    ] as const) {
      expect(await executeProfileCommand(deps, command)).toEqual({
        outcome: "rejected",
        reason: "unknown-profile",
      });
    }
    expect(bridge.clearCookies).not.toHaveBeenCalled();
    expect(bridge.clearCache).not.toHaveBeenCalled();
    expect(bridge.importBrowserCookies).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("names a bridge that lacks the operation and a bridge that fails it", async () => {
    const { deps } = makeDeps({ bridge: {} });
    expect(await executeProfileCommand(deps, { _tag: "clearCache", profileId: "work" })).toEqual({
      outcome: "rejected",
      reason: "not-applicable",
    });
    const failing = makeDeps();
    failing.bridge.clearCookies.mockRejectedValueOnce(new Error("partition busy"));
    expect(
      await executeProfileCommand(failing.deps, { _tag: "clearCookies", profileId: "work" }),
    ).toEqual({ outcome: "rejected", reason: "failed" });
  });

  it("lists import sources with handles in place of profile directories", async () => {
    const { deps } = makeDeps();
    const answer = await executeProfileCommand(deps, { _tag: "listImportSources" });
    expect(answer).toEqual({
      outcome: "import-sources",
      sources: [
        {
          id: "chrome",
          name: "Google Chrome",
          profiles: [
            { handle: "p0", name: "Person 1", cookieCount: 40 },
            { handle: "p1", name: "Work account" },
          ],
        },
        { id: "safari", name: "Safari", unavailable: "needsFullDiskAccess", profiles: [] },
      ],
    });
    expect(JSON.stringify(answer)).not.toContain("Profile 3");
  });

  it("labels a profile named after its directory without exposing the path", async () => {
    const custom = "/Users/someone/Custom Profiles/ff-work";
    const { deps } = makeDeps({
      bridge: {
        listBrowserImportSources: async () => [
          {
            id: "firefox",
            name: "Firefox",
            profiles: [
              { directory: "Profiles/abc.default", name: "default-release" },
              { directory: custom, name: custom },
            ],
          },
        ],
      },
    });
    const answer = await executeProfileCommand(deps, { _tag: "listImportSources" });
    expect(answer).toEqual({
      outcome: "import-sources",
      sources: [
        {
          id: "firefox",
          name: "Firefox",
          profiles: [
            { handle: "p0", name: "default-release" },
            { handle: "p1", name: "Profile 2" },
          ],
        },
      ],
    });
    expect(JSON.stringify(answer)).not.toContain("/Users");
  });

  const importCommand = (sourceProfile = "p1", sourceId: "chrome" | "safari" = "chrome") =>
    ({
      _tag: "importCookies",
      profileId: "work",
      sourceId,
      sourceProfile,
      requester: "t3.browser",
    }) as const;

  it("imports only after the user confirms, resolving the handle to its directory", async () => {
    const { deps, bridge, confirm } = makeDeps();
    expect(await executeProfileCommand(deps, importCommand())).toEqual({
      outcome: "imported",
      imported: 38,
      skipped: 2,
    });
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0]![0]).toContain("t3.browser");
    expect(confirm.mock.calls[0]![0]).toContain("Google Chrome (Work account)");
    expect(confirm.mock.calls[0]![0]).toContain('"Work"');
    expect(bridge.importBrowserCookies).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      sourceId: "chrome",
      sourceProfileDirectory: "Profile 3",
      targetProfileId: "work",
    });
  });

  it("reads nothing when the server withholds proceed after the user confirmed", async () => {
    const { deps, bridge, confirm } = makeDeps({ proceed: async () => false });
    expect(await executeProfileCommand(deps, importCommand())).toEqual({
      outcome: "rejected",
      reason: "cancelled",
    });
    expect(confirm).toHaveBeenCalledOnce();
    expect(bridge.importBrowserCookies).not.toHaveBeenCalled();
  });

  it("a refused prompt reads nothing", async () => {
    const { deps, bridge } = makeDeps({ confirm: async () => false });
    expect(await executeProfileCommand(deps, importCommand())).toEqual({ outcome: "declined" });
    expect(bridge.importBrowserCookies).not.toHaveBeenCalled();
  });

  it("names unknown handles, blocked sources and bridge failures before or after the prompt", async () => {
    const { deps, bridge, confirm } = makeDeps();
    expect(await executeProfileCommand(deps, importCommand("p7"))).toEqual({
      outcome: "import-failed",
      reason: "unknownSourceProfile",
    });
    expect(await executeProfileCommand(deps, importCommand("p0", "safari"))).toEqual({
      outcome: "import-failed",
      reason: "needsFullDiskAccess",
    });
    expect(confirm).not.toHaveBeenCalled();
    bridge.importBrowserCookies.mockRejectedValueOnce(
      new Error("Importing cookies from chrome failed: needsKeychainApproval."),
    );
    expect(await executeProfileCommand(deps, importCommand())).toEqual({
      outcome: "import-failed",
      reason: "needsKeychainApproval",
    });
  });
});
