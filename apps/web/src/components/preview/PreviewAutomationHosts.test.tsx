import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  ThreadId,
  ProjectId,
  type PreviewAutomationRequest,
  type ScopedThreadRef,
  type ClientSettings,
  type PreviewAutomationResponse,
  type PreviewAutomationStreamEvent,
  type PreviewOpenInput,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { __resetClientSettingsPersistenceForTests } from "~/hooks/useSettings";
import {
  applyPreviewDesktopState,
  applyPreviewServerSnapshot,
  readThreadPreviewState,
  resetPreviewStateForTests,
} from "~/previewStateStore";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import type { readWorkbench } from "~/state/taskWorkbench";
import type {
  startBrowserRecording,
  readActiveBrowserRecordingTargets,
  stopBrowserRecordingForUpload,
} from "~/browser/browserRecording";
import type { uploadBrowserRecording } from "~/browser/browserRecordingUpload";
import { appAtomRegistry, AppAtomRegistryProvider } from "~/rpc/atomRegistry";

import { PreviewAutomationHosts } from "./PreviewAutomationHosts";

const mocks = vi.hoisted(() => ({
  readWorkbench: vi.fn<typeof readWorkbench>(),
  navigate: vi.fn(async () => undefined),
  status: vi.fn(async () => ({
    available: true,
    visible: false,
    tabId: null,
    url: null,
    title: null,
    loading: false,
  })),
  startRecording: vi.fn<typeof startBrowserRecording>(),
  activeRecordings: vi.fn<typeof readActiveBrowserRecordingTargets>(),
  stopForUpload: vi.fn<typeof stopBrowserRecordingForUpload>(),
  uploadRecording: vi.fn<typeof uploadBrowserRecording>(),
  getClientSettings: vi.fn<() => Promise<ClientSettings | null>>(),
  setClientSettings: vi.fn(),
  open: vi.fn(async (_target: { environmentId: EnvironmentId; input: PreviewOpenInput }) =>
    AsyncResult.success(snapshot),
  ),
  list: vi.fn(async (_target: { environmentId: EnvironmentId; input: { threadId: string } }) =>
    AsyncResult.success({ ...emptyList, sessions: [] as PreviewSessionSnapshot[] }),
  ),
  resize: vi.fn(),
  respond:
    vi.fn<
      (target: { environmentId: EnvironmentId; input: PreviewAutomationResponse }) => Promise<void>
    >(),
  focus: vi.fn(async () => undefined),
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({ persistence: mocks }),
}));
vi.mock("~/env", () => ({ isElectron: true }));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: [{ environmentId }] }),
}));
vi.mock("~/state/preview", () => ({
  previewEnvironment: {
    automationRequests: () => requestsAtom,
    list: () => listAtom,
    open: mocks.open,
    resize: mocks.resize,
    respondToAutomation: mocks.respond,
    focusAutomationHost: mocks.focus,
  },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => command,
}));
vi.mock("~/state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => mocks.list,
}));
vi.mock("./previewBridge", () => ({
  previewBridge: { navigate: mocks.navigate, automation: { status: mocks.status } },
}));
vi.mock("~/state/taskWorkbench", () => ({ readWorkbench: mocks.readWorkbench }));
vi.mock("~/browser/browserRecording", () => ({
  startBrowserRecording: mocks.startRecording,
  readActiveBrowserRecordingTargets: mocks.activeRecordings,
  stopBrowserRecordingForUpload: mocks.stopForUpload,
  stopBrowserRecording: vi.fn(),
}));
vi.mock("~/browser/browserRecordingUpload", () => ({
  uploadBrowserRecording: mocks.uploadRecording,
}));

const environmentId = EnvironmentId.make("automation-environment");
const threadId = ThreadId.make("automation-thread");
const threadRef = { environmentId, threadId };
const viewport = { _tag: "freeform", width: 1440, height: 900 } as const;
const savedSettings: ClientSettings = {
  ...DEFAULT_CLIENT_SETTINGS,
  browserDefaultViewport: viewport,
  browserDefaultProfileId: "work",
  browserProfiles: [{ id: "work", name: "Work", kind: "persistent" }],
};
const snapshot: PreviewSessionSnapshot = {
  threadId,
  tabId: "automation-tab",
  navStatus: { _tag: "Idle" },
  canGoBack: false,
  canGoForward: false,
  viewport,
  profileId: "work",
  updatedAt: "2026-09-05T00:00:00.000Z",
};
const emptyList = { sessions: [], serverEpoch: "test-server", revision: 0 };
const listAtom = Atom.make(AsyncResult.success(emptyList));
const requestsAtom = Atom.make<AsyncResult.AsyncResult<PreviewAutomationStreamEvent, Error>>(
  AsyncResult.initial(false),
);
const requestEvent: Extract<PreviewAutomationStreamEvent, { type: "request" }> = {
  type: "request",
  connectionId: "automation-connection",
  request: {
    requestId: "open-request",
    threadId,
    operation: "open",
    input: { open: false, reuseExistingTab: false },
    timeoutMs: 15_000,
  },
};

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

let renderer: ReactTestRenderer | null = null;

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.getClientSettings.mockReset().mockResolvedValue(savedSettings);
  mocks.respond.mockReset();
  mocks.readWorkbench.mockReset().mockImplementation((ref) => readyWorkbench(ref));
  mocks.open
    .mockReset()
    .mockImplementation(async ({ input }) =>
      AsyncResult.success({ ...snapshot, threadId: input.threadId }),
    );
  mocks.list.mockReset().mockImplementation(async ({ environmentId, input }) =>
    AsyncResult.success({
      ...emptyList,
      sessions: Object.values(
        readThreadPreviewState({ environmentId, threadId: ThreadId.make(input.threadId) }).sessions,
      ),
    }),
  );
  mocks.resize.mockReset();
  mocks.activeRecordings.mockReset().mockReturnValue([]);
  mocks.uploadRecording.mockReset().mockResolvedValue("attachment-id");
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
  __resetClientSettingsPersistenceForTests();
  resetPreviewStateForTests();
  appAtomRegistry.set(requestsAtom, AsyncResult.initial(false));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn(), setTimeout });
  vi.stubGlobal("document", { hasFocus: () => false, querySelectorAll: () => [] });
  await act(() => {
    renderer = create(
      <AppAtomRegistryProvider>
        <PreviewAutomationHosts />
      </AppAtomRegistryProvider>,
    );
  });
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = null;
  resetPreviewStateForTests();
  __resetClientSettingsPersistenceForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PreviewAutomationHosts open", () => {
  it("waits for saved settings before opening a tab with the configured profile and viewport", async () => {
    const readStarted = deferred<void>();
    const read = deferred<ClientSettings>();
    const response = deferred<PreviewAutomationResponse>();
    mocks.getClientSettings.mockImplementationOnce(() => {
      readStarted.resolve();
      return read.promise;
    });
    mocks.respond.mockImplementationOnce(async ({ input }) => response.resolve(input));

    await act(async () => {
      appAtomRegistry.set(requestsAtom, AsyncResult.success(requestEvent));
      await readStarted.promise;
    });
    expect(mocks.open).not.toHaveBeenCalled();

    await act(async () => {
      read.resolve(savedSettings);
      await response.promise;
    });

    expect(mocks.open).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { threadId, viewport, profileId: "work" },
    });
    expect(mocks.getClientSettings).toHaveBeenCalledOnce();
    await expect(response.promise).resolves.toMatchObject({ requestId: "open-request", ok: true });
    expect(readThreadPreviewState(threadRef).snapshot).toEqual(snapshot);
    expect(mocks.setClientSettings).not.toHaveBeenCalled();
  });

  it("reports a settings read failure without opening a tab", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.getClientSettings.mockRejectedValueOnce(new Error("Settings read failed"));
    const response = deferred<PreviewAutomationResponse>();
    mocks.respond.mockImplementationOnce(async ({ input }) => response.resolve(input));

    await act(async () => {
      appAtomRegistry.set(requestsAtom, AsyncResult.success(requestEvent));
      await response.promise;
    });

    await expect(response.promise).resolves.toMatchObject({
      requestId: "open-request",
      ok: false,
      error: { _tag: "PreviewAutomationExecutionError" },
    });
    expect(mocks.getClientSettings).toHaveBeenCalledOnce();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(readThreadPreviewState(threadRef).snapshot).toBeNull();
    expect(mocks.setClientSettings).not.toHaveBeenCalled();
  });
});

const taskRef = { environmentId, threadId: ThreadId.make("task:shared-task") };
const siblingRef = { environmentId, threadId: ThreadId.make("sibling-thread") };

function readyWorkbench(ownerRef: ScopedThreadRef): ReturnType<typeof readWorkbench> {
  return {
    status: "ready",
    ownerRef,
    projectRef: {
      environmentId: ownerRef.environmentId,
      projectId: ProjectId.make("primary-project"),
    },
    workspaceRoot: "/primary-project",
    cwd: "/primary-project",
    worktreePath: null,
  };
}

async function sendRequest(request: Partial<PreviewAutomationRequest>) {
  const response = deferred<PreviewAutomationResponse>();
  mocks.respond.mockImplementationOnce(async ({ input }) => response.resolve(input));
  await act(async () => {
    appAtomRegistry.set(
      requestsAtom,
      AsyncResult.success({
        ...requestEvent,
        type: "request",
        request: { ...requestEvent.request, ...request },
      }),
    );
    await response.promise;
  });
  return response.promise;
}

function installTaskTab(tabId = snapshot.tabId) {
  const taskSnapshot = { ...snapshot, threadId: taskRef.threadId, tabId };
  applyPreviewServerSnapshot(taskRef, taskSnapshot);
  applyPreviewDesktopState(taskRef, tabId, {
    hasWebContents: true,
    canGoBack: false,
    canGoForward: false,
    loading: false,
    zoomFactor: 1,
    pictureInPicture: false,
    colorScheme: "system",
    audioMuted: false,
    audible: false,
    controller: "none",
    favicon: null,
  });
  const runtimeTabId = previewRuntimeTabId(taskRef, null, tabId);
  vi.stubGlobal("document", {
    hasFocus: () => false,
    querySelectorAll: () => [
      {
        getAttribute: (name: string) => (name === "data-preview-tab" ? runtimeTabId : null),
        closest: () => ({ getAttribute: () => "active" }),
        executeJavaScript: async () => ({ width: 1440, height: 900 }),
      },
    ],
  });
  return { taskSnapshot, runtimeTabId };
}

describe("PreviewAutomationHosts task ownership", () => {
  beforeEach(() => mocks.readWorkbench.mockImplementation(() => readyWorkbench(taskRef)));

  it("opens for the task and lets a sibling reuse the same tab without member resource writes", async () => {
    const opened = await sendRequest({ requestId: "member-open" });
    expect(opened).toMatchObject({
      requestId: "member-open",
      ok: true,
      result: { tabId: snapshot.tabId },
    });
    expect(mocks.list).toHaveBeenCalledWith({
      environmentId,
      input: { threadId: taskRef.threadId },
    });
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { threadId: taskRef.threadId, viewport, profileId: "work" },
    });
    const reused = await sendRequest({
      requestId: "sibling-open",
      threadId: siblingRef.threadId,
      tabId: snapshot.tabId,
      input: { open: false, reuseExistingTab: true },
    });
    expect(reused).toMatchObject({
      requestId: "sibling-open",
      ok: true,
      result: { tabId: snapshot.tabId },
    });
    expect(mocks.open).toHaveBeenCalledOnce();
    expect(mocks.readWorkbench).toHaveBeenNthCalledWith(1, threadRef);
    expect(mocks.readWorkbench).toHaveBeenNthCalledWith(2, siblingRef);
    expect(readThreadPreviewState(threadRef).snapshot).toBeNull();
    expect(readThreadPreviewState(siblingRef).snapshot).toBeNull();
    expect(readThreadPreviewState(taskRef).snapshot?.threadId).toBe(taskRef.threadId);
    expect(usePreviewMiniPlayerStore.getState().byThreadKey).toEqual({});
  });

  it("navigates a user-created task tab and shows only the task floating preview", async () => {
    const { runtimeTabId } = installTaskTab("user-tab");
    const otherRef = {
      environmentId: EnvironmentId.make("other-environment"),
      threadId: taskRef.threadId,
    };
    const otherSnapshot = { ...snapshot, threadId: otherRef.threadId, tabId: "user-tab" };
    applyPreviewServerSnapshot(otherRef, otherSnapshot);
    const navigated = await sendRequest({
      requestId: "navigate-user-tab",
      operation: "navigate",
      tabId: "user-tab",
      input: { url: "https://example.com", readiness: "none" },
    });
    expect(navigated).toMatchObject({ requestId: "navigate-user-tab", ok: true });
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith(runtimeTabId, "https://example.com");
    expect(Object.keys(usePreviewMiniPlayerStore.getState().byThreadKey)).toEqual([
      scopedThreadKey(taskRef),
    ]);
    expect(readThreadPreviewState(threadRef).snapshot).toBeNull();
    expect(readThreadPreviewState(otherRef).snapshot).toEqual(otherSnapshot);
    const status = await sendRequest({
      requestId: "sibling-status",
      threadId: siblingRef.threadId,
      operation: "status",
      tabId: "user-tab",
      input: {},
    });
    expect(status).toMatchObject({ ok: true, result: { tabId: "user-tab" } });
    expect(mocks.status).toHaveBeenCalledWith(runtimeTabId);
  });

  it("keeps an explicitly suppressed task tab hidden when a sibling uses it", async () => {
    const { runtimeTabId } = installTaskTab();
    await sendRequest({ requestId: "suppress", tabId: snapshot.tabId, input: { open: false } });
    const response = await sendRequest({
      requestId: "sibling-navigate",
      threadId: siblingRef.threadId,
      operation: "navigate",
      tabId: snapshot.tabId,
      input: { url: "https://example.com", readiness: "none" },
    });
    expect(response.ok).toBe(true);
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith(runtimeTabId, "https://example.com");
    expect(usePreviewMiniPlayerStore.getState().byThreadKey).toEqual({});
  });

  it("attributes a stale runtime error to the conversation after navigation", async () => {
    installTaskTab();
    mocks.navigate.mockImplementationOnce(async () => {
      applyPreviewServerSnapshot(taskRef, null);
    });
    const response = await sendRequest({
      requestId: "stale-navigation",
      operation: "navigate",
      tabId: snapshot.tabId,
      input: { url: "https://example.com", readiness: "none" },
    });
    expect(response).toMatchObject({
      requestId: "stale-navigation",
      ok: false,
      error: { _tag: "PreviewAutomationTabNotFoundError", detail: { threadId } },
    });
  });

  it("rejects a tab found only under another environment without presenting it", async () => {
    const otherRef = {
      environmentId: EnvironmentId.make("other-environment"),
      threadId: taskRef.threadId,
    };
    applyPreviewServerSnapshot(otherRef, { ...snapshot, threadId: taskRef.threadId });
    const response = await sendRequest({
      operation: "navigate",
      tabId: snapshot.tabId,
      input: { url: "https://example.com" },
    });
    expect(response).toMatchObject({
      ok: false,
      error: {
        _tag: "PreviewAutomationTabNotFoundError",
        detail: { threadId, requestId: "open-request" },
      },
    });
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(usePreviewMiniPlayerStore.getState().byThreadKey).toEqual({});
  });

  it.each(["loading", "missing"] as const)(
    "opens nothing when workbench data is %s",
    async (reason) => {
      mocks.readWorkbench.mockReturnValue({ status: "unavailable", reason });
      const response = await sendRequest({});
      expect(response).toMatchObject({
        ok: false,
        error: { _tag: "PreviewAutomationTabNotFoundError", detail: { threadId } },
      });
      expect(mocks.list).not.toHaveBeenCalled();
      expect(mocks.open).not.toHaveBeenCalled();
      expect(usePreviewMiniPlayerStore.getState().byThreadKey).toEqual({});
    },
  );

  it("captures ownership across an asynchronous open, then resolves new membership on the next request", async () => {
    const readStarted = deferred<void>();
    const read = deferred<ClientSettings>();
    mocks.getClientSettings.mockImplementationOnce(() => {
      readStarted.resolve();
      return read.promise;
    });
    const response = deferred<PreviewAutomationResponse>();
    mocks.respond.mockImplementationOnce(async ({ input }) => response.resolve(input));
    await act(async () => {
      appAtomRegistry.set(requestsAtom, AsyncResult.success(requestEvent));
      await readStarted.promise;
    });
    const nextTaskRef = { environmentId, threadId: ThreadId.make("task:next-task") };
    mocks.readWorkbench.mockReturnValue(readyWorkbench(nextTaskRef));
    await act(async () => {
      read.resolve(savedSettings);
      await response.promise;
    });
    expect(mocks.open).toHaveBeenLastCalledWith({
      environmentId,
      input: { threadId: taskRef.threadId, viewport, profileId: "work" },
    });
    expect(readThreadPreviewState(nextTaskRef).snapshot).toBeNull();
    await sendRequest({ requestId: "next-owner" });
    expect(mocks.open).toHaveBeenLastCalledWith({
      environmentId,
      input: { threadId: nextTaskRef.threadId, viewport, profileId: "work" },
    });
    expect(readThreadPreviewState(taskRef).snapshot?.threadId).toBe(taskRef.threadId);
    expect(readThreadPreviewState(threadRef).snapshot).toBeNull();
  });

  it("rolls back a failed resize under the captured task owner", async () => {
    const { taskSnapshot } = installTaskTab();
    let clock = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => (clock += 2));
    mocks.resize.mockImplementation(async ({ input }: { input: { viewport: typeof viewport } }) =>
      AsyncResult.success({ ...taskSnapshot, viewport: input.viewport }),
    );
    const response = await sendRequest({
      requestId: "resize-task",
      operation: "resize",
      tabId: snapshot.tabId,
      input: { width: 800, height: 600, timeoutMs: 1 },
    });
    expect(response).toMatchObject({
      ok: false,
      error: {
        _tag: "PreviewAutomationTimeoutError",
        detail: { threadId, requestId: "resize-task" },
      },
    });
    expect(mocks.resize.mock.calls.map(([target]) => target)).toEqual([
      {
        environmentId,
        input: {
          threadId: taskRef.threadId,
          tabId: snapshot.tabId,
          viewport: { _tag: "freeform", width: 800, height: 600 },
        },
      },
      { environmentId, input: { threadId: taskRef.threadId, tabId: snapshot.tabId, viewport } },
    ]);
    expect(readThreadPreviewState(taskRef).snapshot?.viewport).toEqual(viewport);
    expect(readThreadPreviewState(threadRef).snapshot).toBeNull();
  });

  it("records the task tab but uploads the result for the requesting conversation", async () => {
    const { runtimeTabId } = installTaskTab();
    mocks.startRecording.mockResolvedValue("2026-09-13T00:00:00.000Z");
    const started = await sendRequest({
      requestId: "record-start",
      operation: "recordingStart",
      tabId: snapshot.tabId,
      input: {},
    });
    expect(started.ok).toBe(true);
    expect(mocks.startRecording).toHaveBeenCalledExactlyOnceWith(
      runtimeTabId,
      taskRef,
      snapshot.tabId,
    );
    const artifact = {
      id: "recording-id",
      tabId: runtimeTabId,
      createdAt: "2026-09-13T00:00:00.000Z",
      path: "/tmp/recording.webm",
      mimeType: "video/webm",
      sizeBytes: 5,
    };
    const blob = new Blob(["video"]);
    mocks.activeRecordings.mockReturnValue([{ runtimeTabId, serverTabId: snapshot.tabId }]);
    mocks.stopForUpload.mockImplementation(async (_runtimeTabId, upload) => ({
      ...artifact,
      uploadedAttachmentId: await upload(artifact, blob),
    }));
    const stopped = await sendRequest({
      requestId: "record-stop",
      operation: "recordingStop",
      tabId: snapshot.tabId,
      input: { transferToEnvironment: true },
    });
    expect(stopped).toMatchObject({
      requestId: "record-stop",
      ok: true,
      result: { tabId: snapshot.tabId, uploadedAttachmentId: "attachment-id" },
    });
    expect(mocks.activeRecordings).toHaveBeenCalledExactlyOnceWith(taskRef);
    expect(mocks.uploadRecording).toHaveBeenCalledExactlyOnceWith(
      threadRef,
      artifact,
      blob,
      expect.any(Number),
    );
  });
});
