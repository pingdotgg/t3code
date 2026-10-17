import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type AuthEnvironmentScope,
  type EditorId,
  type ThreadLinkedPullRequest,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { useRightPanelStore } from "../rightPanelStore";

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
  linkedPullRequest: null as ThreadLinkedPullRequest | null,
}));

vi.mock(import("../state/use-atom-query-runner"), async (original) => ({
  ...(await original()),
  useAtomQueryRunner: (() => state.search) as never,
}));
vi.mock(import("../state/use-atom-command"), async (original) => {
  const { threadEnvironment } = await import("../state/threads");
  return {
    ...(await original()),
    useAtomCommand: ((command: unknown) =>
      command === threadEnvironment.updateMetadata
        ? state.updateMetadata
        : state.openEditor) as never,
  };
});
vi.mock(import("../state/session"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  const readEnvironmentScope = (id: EnvironmentId | null, scope: AuthEnvironmentScope) =>
    id !== null &&
    (scope !== AuthOrchestrationOperateScope || id !== threadRef.environmentId || state.allowed);
  return {
    ...(await original()),
    readEnvironmentScope,
    useEnvironmentScope: (id: EnvironmentId | null, scope: AuthEnvironmentScope) =>
      useSyncExternalStore(
        (listener) => {
          state.listeners.add(listener);
          return () => state.listeners.delete(listener);
        },
        () => readEnvironmentScope(id, scope),
      ),
  };
});
// Atoms derived from the server config run in the real registry over this config.
vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const config = Atom.make(() => serverConfig);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => config) as never },
    environmentServerConfigsAtom: Atom.make(
      () => new Map([[threadRef.environmentId, serverConfig]]),
    ) as never,
  };
});
vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  readThreadShell: (() => ({ linkedPullRequest: state.linkedPullRequest })) as never,
  useProjects: (() => [
    { id: linkedPullRequest.projectId, environmentId: threadRef.environmentId },
  ]) as never,
}));
vi.mock(import("../remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }) as never,
}));
vi.mock(import("../hooks/useLocalStorage"), async (original) => ({
  ...(await original()),
  useLocalStorage: (() => ["vscode", vi.fn()]) as never,
  getLocalStorageItem: (() => "vscode") as never,
}));
vi.mock(import("../localApi"), async (original) => ({
  ...(await original()),
  readLocalApi: () =>
    ({
      contextMenu: { show: state.choose },
      shell: { openExternal: state.openExternal },
    }) as never,
}));
vi.mock(import("~/lib/openPullRequestLink"), async (original) => ({
  ...(await original()),
  resolvePullRequestPreviewTarget: () => null,
  findProjectForChangeRequest: ((projects: readonly { id: ProjectId }[]) => projects[0]) as never,
  matchesLinkedPullRequestUrl: (candidate: ThreadLinkedPullRequest, href: string) =>
    candidate.url === href,
  parseChangeRequestUrl: ((href: string) =>
    href === linkedPullRequest.url
      ? {
          host: "github.com",
          repository: linkedPullRequest.repository,
          number: linkedPullRequest.number,
        }
      : null) as never,
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
const roots: Root[] = [];
let container: HTMLDivElement;

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
  useRightPanelStore.setState({ openFile: state.openFile });
  vi.spyOn(navigator.clipboard, "writeText").mockImplementation(state.copy);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function renderMarkdown(text: string) {
  container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(<ChatMarkdown cwd="/work" threadRef={threadRef} text={text} />),
  );
}

function anchor() {
  return container.querySelector("a")!;
}

async function openContextMenu() {
  await act(async () => {
    anchor().dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
    );
  });
}

function offeredActions() {
  return state.choose.mock.lastCall![0].map((item: { id: string }) => item.id);
}

async function setAllowed(allowed: boolean) {
  await act(async () => {
    state.allowed = allowed;
    for (const listener of state.listeners) listener();
  });
}

it("removes host actions after revocation while keeping file preview and copying", async () => {
  await renderMarkdown("[Readme](docs/readme.md)");
  await openContextMenu();
  expect(offeredActions()).toEqual(["open", "reveal", "copy-relative", "copy-full"]);
  await setAllowed(false);
  state.choose.mockResolvedValue("copy-full");
  await openContextMenu();
  expect(offeredActions()).toEqual(["copy-relative", "copy-full"]);
  await vi.waitFor(() => expect(state.copy).toHaveBeenCalledWith("/work/docs/readme.md"));
  await act(async () => anchor().click());
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
    await vi.waitFor(() => expect(state.openExternal).toHaveBeenCalledWith(linkedPullRequest.url));
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

    await setAllowed(true);
    state.choose.mockResolvedValue(action);
    await openContextMenu();
    await vi.waitFor(() =>
      expect(state.updateMetadata).toHaveBeenCalledExactlyOnceWith({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          linkedPullRequest: action === "link-to-thread" ? linkedPullRequest : null,
        },
      }),
    );
  },
);
