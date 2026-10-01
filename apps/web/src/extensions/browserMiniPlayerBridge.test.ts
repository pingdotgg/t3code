import { beforeEach, expect, it, vi } from "vite-plus/test";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, ProjectId } from "@t3tools/contracts";
import { createBrowserMiniPlayerBridge } from "./browserMiniPlayerBridge";
import { usePreviewMiniPlayerStore, browserMiniPlayerSource } from "../previewMiniPlayerStore";
import { readThreadShell } from "../state/entities";
import { isPreviewSupportedInRuntime, readThreadPreviewState } from "../previewStateStore";
import { appAtomRegistry } from "../rpc/atomRegistry";

vi.mock("../state/entities", () => ({ readThreadShell: vi.fn() }));
vi.mock("../previewStateStore", () => ({
  isPreviewSupportedInRuntime: vi.fn(() => true),
  readThreadPreviewState: vi.fn(),
  previewStateAtom: (key: string) => key,
}));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: { subscribe: vi.fn(() => () => {}) } }));

const environmentId = EnvironmentId.make("env-a");
const ref = scopeThreadRef(environmentId, ThreadId.make("thread-a"));
const context = {
  client: "desktop",
  resource: {
    namespace: "t3.browser",
    id: "view",
    environmentId,
    projectId: "project-a",
    threadId: ref.threadId,
  },
};
const held = { tabId: "tab-a", serverEpoch: "epoch-a" };

beforeEach(() => {
  vi.clearAllMocks();
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
  vi.mocked(readThreadShell).mockReturnValue({
    projectId: ProjectId.make("project-a"),
  } as ReturnType<typeof readThreadShell>);
  vi.mocked(readThreadPreviewState).mockReturnValue({
    serverEpoch: held.serverEpoch,
    sessions: { [held.tabId]: { navStatus: { _tag: "Idle" } } },
    desktopByTabId: { [held.tabId]: { hasWebContents: true } },
  } as ReturnType<typeof readThreadPreviewState>);
});

function fixture() {
  const lifetime = new AbortController();
  const bridge = createBrowserMiniPlayerBridge(environmentId)({
    grants: { capabilities: ["t3.ui/panels"], projectIds: ["project-a"] },
    lifetime: lifetime.signal,
  });
  return { bridge, lifetime };
}

it("subscribes before the thread shell returns after reconnect and cleans up on installation end", () => {
  const { bridge, lifetime } = fixture();
  vi.mocked(readThreadShell).mockReturnValue(null);
  const listener = vi.fn();
  const dispose = bridge.subscribe(context, listener);
  expect(bridge.read(context)).toBeNull();
  vi.mocked(readThreadShell).mockReturnValue({
    projectId: ProjectId.make("project-a"),
  } as ReturnType<typeof readThreadShell>);
  usePreviewMiniPlayerStore.getState().open(ref, browserMiniPlayerSource(held.tabId));
  expect(listener).toHaveBeenCalledTimes(1);
  expect(bridge.read(context)).toBe(held.tabId);
  lifetime.abort();
  usePreviewMiniPlayerStore.getState().close(ref);
  expect(listener).toHaveBeenCalledTimes(1);
  expect(bridge.read(context)).toBeNull();
  dispose();
});

it("uses the native web-contents and unreachable state with a local subscription", () => {
  const { bridge } = fixture();
  const dispose = bridge.subscribe(context, vi.fn());
  expect(appAtomRegistry.subscribe).toHaveBeenCalledTimes(1);
  expect(bridge.canFloat(context, held)).toBe(true);
  const state = readThreadPreviewState(ref);
  vi.mocked(readThreadPreviewState).mockReturnValue({ ...state, desktopByTabId: {} });
  expect(bridge.canFloat(context, held)).toBe(false);
  vi.mocked(readThreadPreviewState).mockReturnValue({ ...state, serverEpoch: "epoch-stale" });
  expect(bridge.canFloat(context, held)).toBe(false);
  vi.mocked(readThreadPreviewState).mockReturnValue({
    ...state,
    sessions: { [held.tabId]: { navStatus: { _tag: "LoadFailed" } } },
  } as ReturnType<typeof readThreadPreviewState>);
  expect(bridge.canFloat(context, held)).toBe(false);
  dispose();
});

it("omits unsupported clients and rejects cross-project or cross-environment reads", () => {
  vi.mocked(isPreviewSupportedInRuntime).mockReturnValueOnce(false);
  const { bridge } = fixture();
  expect(bridge.supported).toBe(false);
  usePreviewMiniPlayerStore.getState().open(ref, browserMiniPlayerSource(held.tabId));
  expect(
    bridge.read({ ...context, resource: { ...context.resource, projectId: "project-b" } }),
  ).toBeNull();
  expect(
    bridge.read({ ...context, resource: { ...context.resource, environmentId: "env-b" } }),
  ).toBeNull();
});
