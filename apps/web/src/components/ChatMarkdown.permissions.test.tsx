import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type AuthEnvironmentScope,
  type EditorId,
  type ThreadLinkedPullRequest,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { AsyncResult } from "effect/unstable/reactivity";
import { cloneElement, type ReactElement, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  allowed: true,
  listeners: new Set<() => void>(),
  openEditor: vi.fn(),
  updateMetadata: vi.fn(),
  search: vi.fn(),
  choose: vi.fn(),
  openFile: vi.fn(),
  openExternal: vi.fn(),
  copy: vi.fn(),
  toast: vi.fn(),
  linkedPullRequest: null as ThreadLinkedPullRequest | null,
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => serverConfig }));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../hooks/useSettings", () => ({
  getClientSettings: () => DEFAULT_CLIENT_SETTINGS,
  useClientSettings: (select?: (value: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    select ? select(DEFAULT_CLIENT_SETTINGS) : DEFAULT_CLIENT_SETTINGS,
}));
vi.mock("./ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render, children }: { render: ReactElement; children?: ReactNode }) =>
    children === undefined ? render : cloneElement(render, undefined, children),
  TooltipPopup: () => null,
}));
vi.mock("./chat/PierreEntryIcon", () => ({ PierreEntryIcon: () => null }));
vi.mock("./ui/toast", () => ({
  toastManager: { add: state.toast },
  stackedThreadToast: (value: unknown) => value,
}));
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => state.search }));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "updateMetadata" ? state.updateMetadata : state.openEditor,
}));
vi.mock("../state/session", async () => {
  const { useSyncExternalStore } = await import("react");
  const readEnvironmentScope = (id: EnvironmentId | null, scope: AuthEnvironmentScope) =>
    id !== null &&
    (scope !== AuthOrchestrationOperateScope || id !== threadRef.environmentId || state.allowed);
  return {
    readEnvironmentScope,
    useEnvironmentScope: (id: EnvironmentId | null, scope: AuthEnvironmentScope) =>
      useSyncExternalStore(
        (listener) => {
          state.listeners.add(listener);
          return () => state.listeners.delete(listener);
        },
        () => readEnvironmentScope(id, scope),
      ),
    usePreparedConnection: () => ({ _tag: "None" }),
  };
});
vi.mock("../state/server", () => ({
  serverEnvironment: { configValueAtom: () => "config" },
}));
vi.mock("../state/threads", () => ({
  threadEnvironment: { updateMetadata: "updateMetadata" },
}));
vi.mock("../state/entities", () => ({
  readThreadShell: () => ({ linkedPullRequest: state.linkedPullRequest }),
  useProjects: () => [{ id: linkedPullRequest.projectId, environmentId: threadRef.environmentId }],
}));
vi.mock("../rightPanelStore", () => ({
  useRightPanelStore: { getState: () => ({ openFile: state.openFile }) },
}));
vi.mock("../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("../hooks/useLocalStorage", () => ({
  useLocalStorage: () => ["vscode", vi.fn()],
  getLocalStorageItem: () => "vscode",
  setLocalStorageItem: vi.fn(),
}));
vi.mock("../hooks/useCopyToClipboard", () => ({
  writeTextToClipboard: state.copy,
  useCopyToClipboard: () => ({ copyToClipboard: state.copy, isCopied: false }),
}));
vi.mock("../localApi", () => ({
  readLocalApi: () => ({
    contextMenu: { show: state.choose },
    shell: { openExternal: state.openExternal },
  }),
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectForChangeRequest: (projects: readonly { id: ProjectId }[]) => projects[0],
  matchesLinkedPullRequestUrl: (candidate: ThreadLinkedPullRequest, href: string) =>
    candidate.url === href,
  parseChangeRequestUrl: (href: string) =>
    href === linkedPullRequest.url
      ? { repository: linkedPullRequest.repository, number: linkedPullRequest.number }
      : null,
  useOpenChangeRequestLink: () => vi.fn(),
}));

import ChatMarkdown from "./ChatMarkdown";

const threadRef = {
  environmentId: EnvironmentId.make("selected"),
  threadId: ThreadId.make("thread"),
};
const linkedPullRequest: ThreadLinkedPullRequest = {
  projectId: ProjectId.make("project"),
  repository: "example/repo",
  number: 42,
  url: "https://github.com/example/repo/pull/42",
};
const serverConfig = {
  availableEditors: ["vscode", "file-manager"] as readonly EditorId[],
  shellRevealInFileManager: true,
  shellRevealInFileManagerKind: "xdg-open",
  environment: { platform: { os: "linux" }, capabilities: { threadPullRequestLinking: true } },
};
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  state.allowed = true;
  state.listeners.clear();
  state.linkedPullRequest = null;
  state.openEditor.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.updateMetadata.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.search.mockReset().mockResolvedValue(AsyncResult.success({ entries: [] }));
  state.choose.mockReset().mockResolvedValue(null);
  state.openFile.mockReset();
  state.openExternal.mockReset().mockResolvedValue(undefined);
  state.copy.mockReset().mockResolvedValue(undefined);
  state.toast.mockReset();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {});
  vi.stubGlobal("navigator", { clipboard: { writeText: state.copy } });
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

async function renderMarkdown(text: string) {
  await act(async () => {
    renderer = create(<ChatMarkdown cwd="/work" threadRef={threadRef} text={text} />);
  });
}

function menuEvent() {
  return { preventDefault: vi.fn(), stopPropagation: vi.fn(), clientX: 10, clientY: 10 };
}

function anchor() {
  return renderer!.root.findByType("a");
}

async function openContextMenu() {
  await act(async () => anchor().props.onContextMenu(menuEvent()));
}

function offeredActions() {
  return state.choose.mock.lastCall![0].map((item: { id: string }) => item.id);
}

it("removes host actions after revocation while keeping file preview and copying", async () => {
  await renderMarkdown("[Readme](docs/readme.md)");
  await openContextMenu();
  expect(offeredActions()).toEqual(["open", "reveal", "copy-relative", "copy-full"]);
  await act(async () => {
    state.allowed = false;
    for (const listener of state.listeners) listener();
  });
  state.choose.mockResolvedValue("copy-full");
  await openContextMenu();
  expect(offeredActions()).toEqual(["copy-relative", "copy-full"]);
  expect(state.copy).toHaveBeenCalledWith("/work/docs/readme.md");
  await act(async () => anchor().props.onClick(menuEvent()));
  expect(state.openFile).toHaveBeenCalledWith(threadRef, "docs/readme.md", undefined);
  expect(state.openEditor).not.toHaveBeenCalled();
});

it("does not launch an editor after revocation during a native context menu", async () => {
  let choose: (action: string) => void = () => {
    throw new Error("Menu not opened");
  };
  state.choose.mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        choose = resolve;
      }),
  );
  await renderMarkdown("[Readme](docs/readme.md)");
  await openContextMenu();
  expect(offeredActions()).toContain("open");
  await act(async () => {
    state.allowed = false;
    choose("open");
  });
  expect(state.openEditor).not.toHaveBeenCalled();
});

it("does not reveal a file after revocation during its workspace lookup", async () => {
  let finishLookup: () => void = () => {
    throw new Error("Lookup not started");
  };
  state.search.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishLookup = () => resolve(AsyncResult.success({ entries: [] }));
      }),
  );
  state.choose.mockResolvedValue("reveal");
  await renderMarkdown("[Readme](readme.md)");
  await openContextMenu();
  expect(state.search).toHaveBeenCalledOnce();
  await act(async () => {
    state.allowed = false;
    finishLookup();
  });
  expect(state.openEditor).not.toHaveBeenCalled();
});

it.each([false, true])(
  "keeps PR links usable without offering metadata edits (linked=%s)",
  async (linked) => {
    state.allowed = false;
    state.linkedPullRequest = linked ? linkedPullRequest : null;
    state.choose.mockResolvedValue("open-external");
    await renderMarkdown(`[Review](${linkedPullRequest.url})`);
    await openContextMenu();
    expect(offeredActions()).toEqual(["open-external", "copy-link"]);
    expect(state.openExternal).toHaveBeenCalledWith(linkedPullRequest.url);
    expect(state.updateMetadata).not.toHaveBeenCalled();
  },
);

it.each(["link-to-thread", "unlink-from-thread"])(
  "rechecks %s after a native context menu returns",
  async (action) => {
    state.linkedPullRequest = action === "unlink-from-thread" ? linkedPullRequest : null;
    let choose: (action: string) => void = () => {
      throw new Error("Menu not opened");
    };
    state.choose.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          choose = resolve;
        }),
    );
    await renderMarkdown(`[Review](${linkedPullRequest.url})`);
    await openContextMenu();
    expect(offeredActions()).toContain(action);
    await act(async () => {
      state.allowed = false;
      choose(action);
    });
    expect(state.updateMetadata).not.toHaveBeenCalled();

    await act(async () => {
      state.allowed = true;
      for (const listener of state.listeners) listener();
    });
    state.choose.mockResolvedValue(action);
    await openContextMenu();
    expect(state.updateMetadata).toHaveBeenCalledExactlyOnceWith({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        linkedPullRequest: action === "link-to-thread" ? linkedPullRequest : null,
      },
    });
  },
);
