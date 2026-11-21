import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type DeviceServiceState,
  type EnvironmentId,
  type PreviewSessionSnapshot,
  PrinterId,
  type PrinterServiceState,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { browserMiniPlayerSource, usePreviewMiniPlayerStore } from "../../previewMiniPlayerStore";
import {
  __testing as previewStateTesting,
  applyPreviewServerEvent,
  applyPreviewServerSnapshot,
  beginPreviewSessionClose,
  cancelPreviewSessionClose,
  reconcilePreviewServerSessions,
  resetPreviewStateForTests,
} from "../../previewStateStore";
import { useRightPanelStore } from "../../rightPanelStore";
import {
  applyDeviceSnapshot,
  applyPrinterSnapshot,
  disconnectPrinterEnvironment,
  floatDeviceSurface,
  followPreviewSessions,
  resetDeviceSessionBaselinesForTests,
  revealServerTabs,
  startAgentOpenedPreviews,
} from "./agentOpenedPreviews";

vi.mock("../../state/entities", () => ({
  readEnvironmentSupportsServerBrowser: () => true,
}));

const ref = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-1"));
const threadKey = scopedThreadKey(ref);

const device = {
  hostId: "local",
  id: "pixel",
  platform: "android",
  name: "Pixel 8",
  version: "15",
  booted: true,
  physical: false,
} as const;

const session = {
  threadId: ref.threadId,
  hostId: "local",
  deviceId: "pixel",
  platform: "android",
  openedAt: "2026-01-01T00:00:00.000Z",
} as const;

const deviceState = (input: {
  readonly sessions?: ReadonlyArray<
    Omit<typeof session, "openedAt"> & { readonly openedAt: string }
  >;
  readonly devices?: ReadonlyArray<typeof device>;
}) =>
  ({
    hosts: [],
    hostStatus: "ready",
    hostStatuses: {},
    devices: input.devices ?? [device],
    sessions: input.sessions ?? [],
    onboardingCompleted: true,
    agentAccessEnabled: true,
    hubBasePath: "/api/device-hub",
    revision: 0,
  }) as unknown as DeviceServiceState;

const floating = { sheetLayout: false, autoShowFloatingPreview: true };

function setup() {
  resetPreviewStateForTests();
  resetDeviceSessionBaselinesForTests();
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
  useRightPanelStore.setState({ byThreadKey: {} });
}

const miniPlayerSource = () => usePreviewMiniPlayerStore.getState().byThreadKey[threadKey]?.source;

describe("applyDeviceSnapshot", () => {
  it("treats the first snapshot as a baseline and floats sessions that start later", () => {
    setup();
    applyDeviceSnapshot(ref.environmentId, deviceState({ sessions: [session] }), floating);
    expect(miniPlayerSource()).toBeUndefined();

    applyDeviceSnapshot(ref.environmentId, deviceState({ sessions: [] }), floating);
    applyDeviceSnapshot(ref.environmentId, deviceState({ sessions: [session] }), floating);
    expect(miniPlayerSource()).toMatchObject({ kind: "device", deviceId: "pixel" });
  });

  it("opens a session once its device summary arrives", () => {
    setup();
    applyDeviceSnapshot(ref.environmentId, deviceState({}), floating);
    applyDeviceSnapshot(
      ref.environmentId,
      deviceState({ sessions: [session], devices: [] }),
      floating,
    );
    expect(miniPlayerSource()).toBeUndefined();

    applyDeviceSnapshot(ref.environmentId, deviceState({ sessions: [session] }), floating);
    expect(miniPlayerSource()).toMatchObject({ kind: "device", name: "Pixel 8" });
  });

  it("opens a panel tab once when floating previews are off, and nothing in sheet layouts", () => {
    setup();
    const panel = { sheetLayout: false, autoShowFloatingPreview: false };
    applyDeviceSnapshot(ref.environmentId, deviceState({}), { ...panel, sheetLayout: true });
    applyDeviceSnapshot(ref.environmentId, deviceState({ sessions: [session] }), {
      ...panel,
      sheetLayout: true,
    });
    expect(useRightPanelStore.getState().byThreadKey[threadKey]).toBeUndefined();

    applyDeviceSnapshot(ref.environmentId, deviceState({}), panel);
    applyDeviceSnapshot(ref.environmentId, deviceState({ sessions: [session] }), panel);
    applyDeviceSnapshot(ref.environmentId, deviceState({}), panel);
    applyDeviceSnapshot(ref.environmentId, deviceState({ sessions: [session] }), panel);
    const devices = useRightPanelStore
      .getState()
      .byThreadKey[threadKey]?.surfaces.filter((surface) => surface.kind === "device");
    expect(devices).toHaveLength(1);
    expect(miniPlayerSource()).toBeUndefined();
  });

  it("closes a floating device when its session ends, even before a baseline", () => {
    setup();
    usePreviewMiniPlayerStore.getState().open(ref, {
      kind: "device",
      hostId: "local",
      deviceId: "pixel",
      platform: "android",
      name: "Pixel 8",
    });
    applyDeviceSnapshot(ref.environmentId, deviceState({ sessions: [session] }), floating);
    expect(miniPlayerSource()).toMatchObject({ kind: "device" });

    applyDeviceSnapshot(ref.environmentId, deviceState({ sessions: [] }), floating);
    expect(miniPlayerSource()).toBeUndefined();
  });

  it("opens a session that ended and reopened between two snapshots", () => {
    setup();
    applyDeviceSnapshot(ref.environmentId, deviceState({ sessions: [session] }), floating);
    expect(miniPlayerSource()).toBeUndefined();

    const reopened = { ...session, openedAt: "2026-01-01T00:05:00.000Z" };
    applyDeviceSnapshot(ref.environmentId, deviceState({ sessions: [reopened] }), floating);
    expect(miniPlayerSource()).toMatchObject({ kind: "device", deviceId: "pixel" });
  });

  it("opens a device for a thread that had no sessions when the baseline was taken", () => {
    setup();
    const otherRef = scopeThreadRef(ref.environmentId, ThreadId.make("thread-2"));
    applyDeviceSnapshot(ref.environmentId, deviceState({ sessions: [session] }), floating);
    applyDeviceSnapshot(
      ref.environmentId,
      deviceState({ sessions: [session, { ...session, threadId: otherRef.threadId }] }),
      floating,
    );
    expect(miniPlayerSource()).toBeUndefined();
    expect(
      usePreviewMiniPlayerStore.getState().byThreadKey[scopedThreadKey(otherRef)]?.source,
    ).toMatchObject({ kind: "device", deviceId: "pixel" });
  });
});

describe("floatDeviceSurface", () => {
  const source = {
    kind: "device",
    hostId: "local",
    deviceId: "pixel",
    platform: "android",
    name: "Pixel 8",
  } as const;

  it("floats a device with a live session, or before device state loads", () => {
    setup();
    floatDeviceSurface(ref, source, deviceState({ sessions: [session] }));
    expect(miniPlayerSource()).toMatchObject({ kind: "device", deviceId: "pixel" });

    setup();
    floatDeviceSurface(ref, source, null);
    expect(miniPlayerSource()).toMatchObject({ kind: "device", deviceId: "pixel" });
  });

  it("does not float a device whose session ended", () => {
    setup();
    floatDeviceSurface(ref, source, deviceState({ sessions: [] }));
    expect(miniPlayerSource()).toBeUndefined();
  });
});

describe("revealServerTabs", () => {
  const tab = (tabId: string, force?: boolean): PreviewSessionSnapshot => ({
    threadId: "thread-1",
    tabId,
    navStatus: { _tag: "Loading", url: "http://localhost:5173/", title: "" },
    canGoBack: false,
    canGoForward: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
    runtime: "server",
    reveal: true,
    ...(force === undefined ? {} : { revealRequest: { id: "r1", force } }),
  });
  const floatingTabId = () => {
    const source = miniPlayerSource();
    return source?.kind === "browser" ? source.tabId : null;
  };

  it("floats revealed tabs, and only forced ones when floating previews are off", () => {
    setup();
    revealServerTabs(ref, [tab("tab_plain")], { autoShowFloatingPreview: false });
    expect(floatingTabId()).toBeNull();
    revealServerTabs(ref, [tab("tab_forced", true)], { autoShowFloatingPreview: false });
    expect(floatingTabId()).toBe("tab_forced");
  });

  it("focuses a tab already in the panel instead of floating it when forced", () => {
    setup();
    useRightPanelStore.getState().openBrowser(ref, "tab_a");
    const browserSurfaceId = useRightPanelStore.getState().byThreadKey[threadKey]?.activeSurfaceId;
    useRightPanelStore.getState().open(ref, "diff");

    revealServerTabs(ref, [tab("tab_a", false)], { autoShowFloatingPreview: true });
    expect(useRightPanelStore.getState().byThreadKey[threadKey]?.activeSurfaceId).not.toBe(
      browserSurfaceId,
    );
    const userActionRevision = useRightPanelStore.getState().getUserActionRevision(ref);
    revealServerTabs(ref, [tab("tab_a", true)], { autoShowFloatingPreview: true });
    expect(useRightPanelStore.getState().byThreadKey[threadKey]?.activeSurfaceId).toBe(
      browserSurfaceId,
    );
    expect(floatingTabId()).toBeNull();
    // A user action moves keyboard focus into the panel; an agent reveal must not.
    expect(useRightPanelStore.getState().getUserActionRevision(ref)).toBe(userActionRevision);
  });
});

describe("followPreviewSessions", () => {
  const snapshot = (tabId: string, reveal = true): PreviewSessionSnapshot => ({
    threadId: "thread-1",
    tabId,
    navStatus: { _tag: "Loading", url: "http://localhost:5173/", title: "" },
    canGoBack: false,
    canGoForward: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
    runtime: "server",
    reveal,
  });
  const previewState = (sessions: ReadonlyArray<PreviewSessionSnapshot>, listLoaded = true) => ({
    ...previewStateTesting.EMPTY_THREAD_PREVIEW_STATE,
    listLoaded,
    sessions: Object.fromEntries(sessions.map((entry) => [entry.tabId, entry])),
  });
  const browserTabs = () =>
    useRightPanelStore
      .getState()
      .byThreadKey[threadKey]?.surfaces.filter((surface) => surface.kind === "preview")
      .map((surface) => surface.id) ?? [];

  it("adds visible sessions as tabs and drops tabs whose session ended", () => {
    setup();
    useRightPanelStore.getState().openBrowser(ref, "tab_gone");
    followPreviewSessions(ref, previewState([snapshot("tab_a"), snapshot("tab_hidden", false)]));
    expect(browserTabs()).toEqual(["browser:tab_a"]);
  });

  it("waits for the first server list before treating missing sessions as closed", () => {
    setup();
    useRightPanelStore.getState().openBrowser(ref, "tab_a");
    usePreviewMiniPlayerStore.getState().open(ref, browserMiniPlayerSource("tab_a"));
    followPreviewSessions(ref, previewState([], false));
    expect(browserTabs()).toEqual(["browser:tab_a"]);
    expect(miniPlayerSource()).toMatchObject({ kind: "browser", tabId: "tab_a" });

    followPreviewSessions(ref, previewState([]));
    expect(browserTabs()).toEqual([]);
    expect(miniPlayerSource()).toBeUndefined();
  });
});

describe("startAgentOpenedPreviews", () => {
  const serverEpoch = "server-a";
  const serverTab = (overrides: Partial<PreviewSessionSnapshot> = {}): PreviewSessionSnapshot => ({
    threadId: "thread-1",
    tabId: "tab_a",
    navStatus: { _tag: "Loading", url: "http://localhost:5173/", title: "" },
    canGoBack: false,
    canGoForward: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
    runtime: "server",
    reveal: true,
    ...overrides,
  });
  const following = () => {
    setup();
    return { [Symbol.dispose]: startAgentOpenedPreviews() };
  };
  const navigated = (revision: number, snapshot: PreviewSessionSnapshot) =>
    applyPreviewServerEvent(ref, {
      type: "navigated",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      snapshot,
      serverEpoch,
      revision,
    });
  const floatingTabId = () => {
    const source = miniPlayerSource();
    return source?.kind === "browser" ? source.tabId : null;
  };
  const browserTabs = (threadKeyToRead = threadKey) =>
    useRightPanelStore
      .getState()
      .byThreadKey[threadKeyToRead]?.surfaces.filter((surface) => surface.kind === "preview")
      .map((surface) => surface.id);

  it("treats the first list as a baseline and floats tabs opened later", () => {
    using _following = following();
    reconcilePreviewServerSessions(ref, {
      sessions: [serverTab({ tabId: "tab_restored" })],
      serverEpoch,
      revision: 1,
    });
    expect(floatingTabId()).toBeNull();
    expect(browserTabs()).toEqual(["browser:tab_restored"]);

    const opened = serverTab({ tabId: "tab_agent" });
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: opened.tabId,
      createdAt: opened.updatedAt,
      snapshot: opened,
      serverEpoch,
      revision: 2,
    });
    expect(floatingTabId()).toBe("tab_agent");
  });

  it("reveals an existing tab only for a new reveal request", () => {
    using _following = following();
    const tab = serverTab({ revealRequest: { id: "r1", force: false } });
    reconcilePreviewServerSessions(ref, { sessions: [tab], serverEpoch, revision: 1 });

    navigated(2, { ...tab, updatedAt: "2026-01-01T00:00:01.000Z" });
    expect(floatingTabId()).toBeNull();

    navigated(3, {
      ...tab,
      revealRequest: { id: "r2", force: true },
      updatedAt: "2026-01-01T00:00:02.000Z",
    });
    expect(useRightPanelStore.getState().byThreadKey[threadKey]?.activeSurfaceId).toBe(
      "browser:tab_a",
    );
  });

  it("never reveals tabs this client opened, desktop tabs, or a tab whose close failed", () => {
    using _following = following();
    const tab = serverTab({ tabId: "tab_closing" });
    reconcilePreviewServerSessions(ref, { sessions: [tab], serverEpoch, revision: 1 });
    applyPreviewServerSnapshot(ref, serverTab({ tabId: "tab_own", reveal: undefined }));
    applyPreviewServerSnapshot(ref, { ...serverTab({ tabId: "tab_desktop" }), runtime: "desktop" });
    beginPreviewSessionClose(ref, tab.tabId);
    cancelPreviewSessionClose(ref, tab, tab.tabId);
    expect(floatingTabId()).toBeNull();
  });

  it("follows background threads and closes the floating browser when its session ends", () => {
    using _following = following();
    const other = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-2"));
    reconcilePreviewServerSessions(other, {
      sessions: [serverTab({ threadId: "thread-2", tabId: "tab_b" })],
      serverEpoch,
      revision: 1,
    });
    expect(browserTabs(scopedThreadKey(other))).toEqual(["browser:tab_b"]);

    reconcilePreviewServerSessions(ref, { sessions: [], serverEpoch, revision: 1 });
    const opened = serverTab();
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: opened.tabId,
      createdAt: opened.updatedAt,
      snapshot: opened,
      serverEpoch,
      revision: 2,
    });
    expect(floatingTabId()).toBe("tab_a");
    applyPreviewServerEvent(ref, {
      type: "closed",
      threadId: "thread-1",
      tabId: opened.tabId,
      createdAt: opened.updatedAt,
      serverEpoch,
      revision: 3,
    });
    expect(floatingTabId()).toBeNull();
  });
});

describe("applyPrinterSnapshot", () => {
  const proxyEnvId = "env-home-proxy" as EnvironmentId;
  const printerState = (sessions: PrinterServiceState["sessions"]): PrinterServiceState => ({
    enabled: true,
    agentAccessEnabled: true,
    mediaBasePath: "/api/printer-media",
    printers: [],
    sessions,
    revision: 1,
  });

  it("opens new agent printer sessions, closes ended ones without dismissing, and honors user dismissal", () => {
    setup();
    const sessionA = {
      threadId: ref.threadId,
      printerId: PrinterId.make("p1s-studio"),
      proxyEnvironmentId: proxyEnvId,
      printerLabel: "Studio P1S",
      openedAt: "2026-11-21T01:00:00.000Z",
    };
    const expectedSurfaceId = `printer:${encodeURIComponent(proxyEnvId)}:${encodeURIComponent("p1s-studio")}`;

    // First snapshot establishes baseline without auto-opening.
    applyPrinterSnapshot(ref.environmentId, printerState([sessionA]), { sheetLayout: false });
    expect(useRightPanelStore.getState().byThreadKey[threadKey]).toBeUndefined();

    // New session opens proxied printer surface.
    const sessionB = { ...sessionA, openedAt: "2026-11-21T01:05:00.000Z" };
    applyPrinterSnapshot(ref.environmentId, printerState([sessionB]), { sheetLayout: false });
    expect(useRightPanelStore.getState().byThreadKey[threadKey]?.surfaces.map((s) => s.id)).toEqual(
      [expectedSurfaceId],
    );

    // Ending the session removes the surface WITHOUT marking it user-dismissed.
    applyPrinterSnapshot(ref.environmentId, printerState([]), { sheetLayout: false });
    expect(useRightPanelStore.getState().byThreadKey[threadKey]?.surfaces ?? []).toEqual([]);
    expect(
      useRightPanelStore.getState().byThreadKey[threadKey]?.dismissedPrinterSurfaceIds,
    ).toBeUndefined();

    // A later agent session can re-open it because the user did not dismiss it.
    const sessionC = { ...sessionA, openedAt: "2026-11-21T01:10:00.000Z" };
    applyPrinterSnapshot(ref.environmentId, printerState([sessionC]), { sheetLayout: false });
    expect(useRightPanelStore.getState().byThreadKey[threadKey]?.surfaces.map((s) => s.id)).toEqual(
      [expectedSurfaceId],
    );

    // Explicit user close suppresses later automatic re-opening for the SAME session.
    useRightPanelStore.getState().closeSurface(ref, expectedSurfaceId);
    applyPrinterSnapshot(ref.environmentId, printerState([sessionC]), { sheetLayout: false });
    expect(useRightPanelStore.getState().byThreadKey[threadKey]?.surfaces).toEqual([]);

    // Ending the dismissed session clears dismissal so a NEW agent session can auto-open cleanly.
    applyPrinterSnapshot(ref.environmentId, printerState([]), { sheetLayout: false });
    const sessionD = { ...sessionA, openedAt: "2026-11-21T01:15:00.000Z" };
    applyPrinterSnapshot(ref.environmentId, printerState([sessionD]), { sheetLayout: false });
    expect(useRightPanelStore.getState().byThreadKey[threadKey]?.surfaces.map((s) => s.id)).toEqual(
      [expectedSurfaceId],
    );

    // A manually opened tab is NOT closed when an agent session ends.
    useRightPanelStore.getState().openPrinter(ref, {
      printerId: "p1s-studio",
      proxyEnvironmentId: proxyEnvId,
      label: "Studio P1S",
    });
    applyPrinterSnapshot(ref.environmentId, printerState([]), { sheetLayout: false });
    expect(useRightPanelStore.getState().byThreadKey[threadKey]?.surfaces.map((s) => s.id)).toEqual(
      [expectedSurfaceId],
    );

    // Cross-env duplicate of the same canonical session (even with differing server-local openedAt timestamps)
    // does not open a duplicate tab on the owner env.
    applyPrinterSnapshot(proxyEnvId, printerState([]), { sheetLayout: false });
    const sessionE = { ...sessionA, openedAt: "2026-11-21T01:20:00.000Z" };
    applyPrinterSnapshot(ref.environmentId, printerState([sessionE]), { sheetLayout: false });
    applyPrinterSnapshot(
      proxyEnvId,
      printerState([
        { ...sessionE, proxyEnvironmentId: undefined, openedAt: "2026-11-21T01:20:03.000Z" },
      ]),
      { sheetLayout: false },
    );
    const ownerRef = scopeThreadRef(proxyEnvId, ref.threadId);
    expect(useRightPanelStore.getState().byThreadKey[scopedThreadKey(ownerRef)]).toBeUndefined();

    // Owner-ends / proxy-remains: ownership transfers to surviving proxy env and opens its panel cleanly.
    setup();
    applyPrinterSnapshot(proxyEnvId, printerState([]), { sheetLayout: false });
    applyPrinterSnapshot(ref.environmentId, printerState([]), { sheetLayout: false });
    const ownerSession = {
      threadId: ref.threadId,
      printerId: PrinterId.make("p1s-studio"),
      printerLabel: "Studio P1S",
      openedAt: "2026-11-21T02:00:00.000Z",
    };
    const proxySession = {
      ...ownerSession,
      proxyEnvironmentId: proxyEnvId,
      openedAt: "2026-11-21T02:00:02.000Z",
    };
    // Owner opens first; proxy duplicate is suppressed.
    applyPrinterSnapshot(proxyEnvId, printerState([ownerSession]), { sheetLayout: false });
    applyPrinterSnapshot(ref.environmentId, printerState([proxySession]), { sheetLayout: false });
    expect(
      useRightPanelStore
        .getState()
        .byThreadKey[scopedThreadKey(ownerRef)]?.surfaces.map((s) => s.id),
    ).toEqual(["printer:p1s-studio"]);
    expect(useRightPanelStore.getState().byThreadKey[threadKey]).toBeUndefined();

    // Owner session ends while proxy remains active -> owner panel closes, proxy panel opens.
    applyPrinterSnapshot(proxyEnvId, printerState([]), { sheetLayout: false });
    expect(
      useRightPanelStore.getState().byThreadKey[scopedThreadKey(ownerRef)]?.surfaces ?? [],
    ).toEqual([]);
    expect(useRightPanelStore.getState().byThreadKey[threadKey]?.surfaces.map((s) => s.id)).toEqual(
      [expectedSurfaceId],
    );
  });

  it("closes departing agent-opened tabs on disconnect handoff, preserves manual tabs, and avoids stale tabs on reconnect", () => {
    setup();
    const ownerRef = scopeThreadRef(proxyEnvId, ref.threadId);
    const ownerThreadKey = scopedThreadKey(ownerRef);
    const expectedProxySurfaceId = `printer:${encodeURIComponent(proxyEnvId)}:${encodeURIComponent("p1s-studio")}`;
    const ownerSession = {
      threadId: ref.threadId,
      printerId: PrinterId.make("p1s-studio"),
      printerLabel: "Studio P1S",
      openedAt: "2026-11-21T03:00:00.000Z",
    };
    const proxySession = {
      ...ownerSession,
      proxyEnvironmentId: proxyEnvId,
      openedAt: "2026-11-21T03:00:02.000Z",
    };

    // Baseline both envs, then owner opens first and proxy duplicate is suppressed.
    applyPrinterSnapshot(proxyEnvId, printerState([]), { sheetLayout: false });
    applyPrinterSnapshot(ref.environmentId, printerState([]), { sheetLayout: false });
    applyPrinterSnapshot(proxyEnvId, printerState([ownerSession]), { sheetLayout: false });
    applyPrinterSnapshot(ref.environmentId, printerState([proxySession]), { sheetLayout: false });
    expect(
      useRightPanelStore.getState().byThreadKey[ownerThreadKey]?.surfaces.map((s) => s.id),
    ).toEqual(["printer:p1s-studio"]);
    expect(useRightPanelStore.getState().byThreadKey[threadKey]).toBeUndefined();

    // Owner disconnects while proxy remains active: owner agent-opened tab closes, proxy opens.
    disconnectPrinterEnvironment(proxyEnvId, { sheetLayout: false });
    expect(useRightPanelStore.getState().byThreadKey[ownerThreadKey]?.surfaces ?? []).toEqual([]);
    expect(useRightPanelStore.getState().byThreadKey[threadKey]?.surfaces.map((s) => s.id)).toEqual(
      [expectedProxySurfaceId],
    );

    // Owner reconnects with an empty session list: no stale tab lingers on owner; proxy stays open.
    applyPrinterSnapshot(proxyEnvId, printerState([]), { sheetLayout: false });
    expect(useRightPanelStore.getState().byThreadKey[ownerThreadKey]?.surfaces ?? []).toEqual([]);
    expect(useRightPanelStore.getState().byThreadKey[threadKey]?.surfaces.map((s) => s.id)).toEqual(
      [expectedProxySurfaceId],
    );

    // Manually opened tabs on a disconnecting environment are preserved even on handoff.
    setup();
    applyPrinterSnapshot(proxyEnvId, printerState([]), { sheetLayout: false });
    applyPrinterSnapshot(ref.environmentId, printerState([]), { sheetLayout: false });
    applyPrinterSnapshot(proxyEnvId, printerState([ownerSession]), { sheetLayout: false });
    applyPrinterSnapshot(ref.environmentId, printerState([proxySession]), { sheetLayout: false });
    useRightPanelStore.getState().openPrinter(ownerRef, {
      printerId: "p1s-studio",
      label: "Studio P1S",
    });
    disconnectPrinterEnvironment(proxyEnvId, { sheetLayout: false });
    expect(
      useRightPanelStore.getState().byThreadKey[ownerThreadKey]?.surfaces.map((s) => s.id),
    ).toEqual(["printer:p1s-studio"]);
  });

  it("retains a single-environment agent tab across transient disconnect and reconciles on reconnect", () => {
    setup();
    const ownerRef = scopeThreadRef(proxyEnvId, ref.threadId);
    const ownerThreadKey = scopedThreadKey(ownerRef);
    const ownerSession = {
      threadId: ref.threadId,
      printerId: PrinterId.make("p1s-studio"),
      printerLabel: "Studio P1S",
      openedAt: "2026-11-21T03:30:00.000Z",
    };

    // Continuing session across transient disconnect -> tab survives disconnect and reconnect.
    applyPrinterSnapshot(proxyEnvId, printerState([]), { sheetLayout: false });
    applyPrinterSnapshot(proxyEnvId, printerState([ownerSession]), { sheetLayout: false });
    expect(
      useRightPanelStore.getState().byThreadKey[ownerThreadKey]?.surfaces.map((s) => s.id),
    ).toEqual(["printer:p1s-studio"]);

    disconnectPrinterEnvironment(proxyEnvId, { sheetLayout: false });
    expect(
      useRightPanelStore.getState().byThreadKey[ownerThreadKey]?.surfaces.map((s) => s.id),
    ).toEqual(["printer:p1s-studio"]);

    applyPrinterSnapshot(proxyEnvId, printerState([ownerSession]), { sheetLayout: false });
    expect(
      useRightPanelStore.getState().byThreadKey[ownerThreadKey]?.surfaces.map((s) => s.id),
    ).toEqual(["printer:p1s-studio"]);

    // Ending the session after reconnect closes the tab cleanly.
    applyPrinterSnapshot(proxyEnvId, printerState([]), { sheetLayout: false });
    expect(useRightPanelStore.getState().byThreadKey[ownerThreadKey]?.surfaces ?? []).toEqual([]);

    // Ended session during transient disconnect -> tab closes on the first reconnect snapshot.
    const nextSession = { ...ownerSession, openedAt: "2026-11-21T03:40:00.000Z" };
    applyPrinterSnapshot(proxyEnvId, printerState([nextSession]), { sheetLayout: false });
    expect(
      useRightPanelStore.getState().byThreadKey[ownerThreadKey]?.surfaces.map((s) => s.id),
    ).toEqual(["printer:p1s-studio"]);

    disconnectPrinterEnvironment(proxyEnvId, { sheetLayout: false });
    expect(
      useRightPanelStore.getState().byThreadKey[ownerThreadKey]?.surfaces.map((s) => s.id),
    ).toEqual(["printer:p1s-studio"]);

    applyPrinterSnapshot(proxyEnvId, printerState([]), { sheetLayout: false });
    expect(useRightPanelStore.getState().byThreadKey[ownerThreadKey]?.surfaces ?? []).toEqual([]);
  });

  it("does not resurrect a user-dismissed tab when canonical ownership transfers across thread keys", () => {
    setup();
    const ownerRef = scopeThreadRef(proxyEnvId, ref.threadId);
    const ownerThreadKey = scopedThreadKey(ownerRef);
    const expectedProxySurfaceId = `printer:${encodeURIComponent(proxyEnvId)}:${encodeURIComponent("p1s-studio")}`;
    const ownerSession = {
      threadId: ref.threadId,
      printerId: PrinterId.make("p1s-studio"),
      printerLabel: "Studio P1S",
      openedAt: "2026-11-21T04:00:00.000Z",
    };
    const proxySession = {
      ...ownerSession,
      proxyEnvironmentId: proxyEnvId,
      openedAt: "2026-11-21T04:00:01.000Z",
    };

    // Case 1: Session-end transfer after user dismisses owner tab.
    applyPrinterSnapshot(proxyEnvId, printerState([]), { sheetLayout: false });
    applyPrinterSnapshot(ref.environmentId, printerState([]), { sheetLayout: false });
    applyPrinterSnapshot(proxyEnvId, printerState([ownerSession]), { sheetLayout: false });
    applyPrinterSnapshot(ref.environmentId, printerState([proxySession]), { sheetLayout: false });
    useRightPanelStore.getState().closeSurface(ownerRef, "printer:p1s-studio");
    expect(useRightPanelStore.getState().byThreadKey[ownerThreadKey]?.surfaces).toEqual([]);

    // Owner session ends while proxy remains -> ownership transfers without resurrecting proxy tab.
    applyPrinterSnapshot(proxyEnvId, printerState([]), { sheetLayout: false });
    expect(useRightPanelStore.getState().byThreadKey[threadKey]?.surfaces ?? []).toEqual([]);

    // Once proxy also ends, a brand-new later session can auto-open cleanly.
    applyPrinterSnapshot(ref.environmentId, printerState([]), { sheetLayout: false });
    const freshProxySession = { ...proxySession, openedAt: "2026-11-21T04:10:00.000Z" };
    applyPrinterSnapshot(ref.environmentId, printerState([freshProxySession]), {
      sheetLayout: false,
    });
    expect(useRightPanelStore.getState().byThreadKey[threadKey]?.surfaces.map((s) => s.id)).toEqual(
      [expectedProxySurfaceId],
    );

    // Case 2: Disconnect transfer after user dismisses owner tab.
    setup();
    applyPrinterSnapshot(proxyEnvId, printerState([]), { sheetLayout: false });
    applyPrinterSnapshot(ref.environmentId, printerState([]), { sheetLayout: false });
    applyPrinterSnapshot(proxyEnvId, printerState([ownerSession]), { sheetLayout: false });
    applyPrinterSnapshot(ref.environmentId, printerState([proxySession]), { sheetLayout: false });
    useRightPanelStore.getState().closeSurface(ownerRef, "printer:p1s-studio");
    disconnectPrinterEnvironment(proxyEnvId, { sheetLayout: false });
    expect(useRightPanelStore.getState().byThreadKey[ownerThreadKey]?.surfaces ?? []).toEqual([]);
    expect(useRightPanelStore.getState().byThreadKey[threadKey]?.surfaces ?? []).toEqual([]);
  });
});
