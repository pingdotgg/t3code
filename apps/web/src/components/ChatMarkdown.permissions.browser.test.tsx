import { RegistryContext } from "@effect/atom-react";
import {
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type AuthEnvironmentScope,
  type EditorId,
  type FilesystemEntryMetadata,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import {
  createThreadFilePathIndex,
  type ThreadFilePathIndex,
} from "@t3tools/shared/threadFilePaths";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import { FileMetadataThreadContext } from "../hooks/FileMetadataThreadProvider";
import { useRightPanelStore } from "../rightPanelStore";
import { ThreadFilePathsContext } from "../threadFilePathsContext";

const state = vi.hoisted(() => ({
  allowed: true,
  canRead: true,
  listeners: new Set<() => void>(),
  openEditor: vi.fn(),
  link: vi.fn(),
  unlink: vi.fn(),
  search: vi.fn(),
  choose: vi.fn(),
  openFile: vi.fn(),
  openExternal: vi.fn(),
  copy: vi.fn(),
  pullRequests: [] as ThreadPullRequestLink[],
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
      command === threadEnvironment.linkPullRequest
        ? state.link
        : command === threadEnvironment.unlinkPullRequest
          ? state.unlink
          : state.openEditor) as never,
  };
});
vi.mock(import("../state/session"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  const readEnvironmentScope = (id: EnvironmentId | null, scope: AuthEnvironmentScope) =>
    id !== null &&
    (scope !== AuthFilesystemReadScope || state.canRead) &&
    (scope !== AuthOrchestrationOperateScope || id !== threadRef.environmentId || state.allowed);
  return {
    ...(await original()),
    readEnvironmentScope,
    usePreparedConnection: (() => ({
      _tag: "Some",
      value: { httpBaseUrl: "https://host.test" },
    })) as never,
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
// Only the transport result is replaced; the metadata hook and its subscription stay real.
vi.mock(import("../state/projects"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    projectEnvironment: {
      ...actual.projectEnvironment,
      fileMetadata: (target) => metadataAtom(target.input.path),
    },
  };
});
vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  readThreadShell: (() => ({ pullRequests: state.pullRequests })) as never,
  useProjects: (() => [{ id: projectId, environmentId: threadRef.environmentId }]) as never,
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
vi.mock(import("@t3tools/client-runtime/change-request-links"), async (original) => ({
  ...(await original()),
  resolvePullRequestPreviewTarget: () => null,
  findProjectForChangeRequest: ((projects: readonly { id: ProjectId }[]) => projects[0]) as never,
}));

import ChatMarkdown from "./ChatMarkdown";

const threadRef = {
  environmentId: EnvironmentId.make("selected"),
  threadId: ThreadId.make("thread"),
};
const projectId = ProjectId.make("project");
const linkedPullRequest: ThreadPullRequestLink = {
  host: "github.com",
  repository: "example/repo",
  number: 42,
  url: "https://github.com/example/repo/pull/42",
  source: "manual",
  linkedAt: "2026-09-08T00:00:00.000Z",
  snapshot: null,
  stack: null,
};
const serverConfig = {
  availableEditors: ["vscode", "file-manager"] as readonly EditorId[],
  shellRevealInFileManager: true,
  shellRevealInFileManagerKind: "xdg-open",
  environment: { platform: { os: "linux" }, capabilities: {} },
};

type MetadataResult = AsyncResult.AsyncResult<FilesystemEntryMetadata | null, Error>;
const metadataResults = Atom.family((_key: string) =>
  Atom.make<MetadataResult>(
    AsyncResult.initial(true),
  ).pipe(Atom.keepAlive),
);
let registry: AtomRegistry.AtomRegistry;
const metadataAtom = (path: string) => metadataResults(path);
async function settleMetadata(path: string, result: MetadataResult) {
  await act(async () => registry.set(metadataAtom(path), result));
}

function setup() {
  using stack = new DisposableStack();
  registry = AtomRegistry.make();
  stack.defer(() => registry.dispose());
  state.allowed = true;
  state.canRead = true;
  state.listeners.clear();
  state.pullRequests = [];
  state.openEditor.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.link.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.unlink.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.search.mockReset().mockResolvedValue(AsyncResult.success({ entries: [] }));
  state.choose.mockReset().mockResolvedValue(null);
  state.openFile.mockReset();
  state.openExternal.mockReset().mockResolvedValue(undefined);
  state.copy.mockReset().mockResolvedValue(undefined);
  const { openFile } = useRightPanelStore.getState();
  useRightPanelStore.setState({ openFile: state.openFile });
  stack.defer(() => useRightPanelStore.setState({ openFile }));
  stack.use(vi.spyOn(navigator.clipboard, "writeText").mockImplementation(state.copy));
  stack.use(
    vi.spyOn(navigator.clipboard, "write").mockImplementation(async (items) => {
      const item = items[0]!;
      await state.copy(await (await item.getType("text/plain")).text());
    }),
  );
  return stack.move();
}

async function renderMarkdown(
  text: string,
  index: ThreadFilePathIndex | null = null,
  cwd: string | null = "/work",
) {
  const screen = await render(
    <RegistryContext.Provider value={registry}>
      <FileMetadataThreadContext value={threadRef}>
        <ThreadFilePathsContext value={index}>
          <ChatMarkdown cwd={cwd ?? undefined} threadRef={threadRef} text={text} />
        </ThreadFilePathsContext>
      </FileMetadataThreadContext>
    </RegistryContext.Provider>,
  );
  const anchor = () => screen.container.querySelector("a")!;
  return Object.assign(screen, {
    anchor,
    openContextMenu: () =>
      act(async () => {
        anchor().dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 10,
            clientY: 10,
          }),
        );
      }),
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
  using _setup = setup();
  await using screen = await renderMarkdown("[Readme](docs/readme.md)");
  await screen.openContextMenu();
  expect(offeredActions()).toEqual(["open", "reveal", "copy-relative", "copy-full"]);
  await setAllowed(false);
  state.choose.mockResolvedValue("copy-full");
  await screen.openContextMenu();
  expect(offeredActions()).toEqual(["copy-relative", "copy-full"]);
  await vi.waitFor(() => expect(state.copy).toHaveBeenCalledWith("/work/docs/readme.md"));
  await act(async () => screen.anchor().click());
  expect(state.openFile).toHaveBeenCalledWith(threadRef, "docs/readme.md", undefined);
  expect(state.openEditor).not.toHaveBeenCalled();
});

it("does not launch an editor after revocation during a native context menu", async () => {
  using _setup = setup();
  let choose: (action: string) => void = () => {
    throw new Error("Menu not opened");
  };
  state.choose.mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        choose = resolve;
      }),
  );
  await using screen = await renderMarkdown("[Readme](docs/readme.md)");
  await screen.openContextMenu();
  expect(offeredActions()).toContain("open");
  await act(async () => {
    state.allowed = false;
    choose("open");
  });
  expect(state.openEditor).not.toHaveBeenCalled();
});

it("does not reveal a file after revocation during its workspace lookup", async () => {
  using _setup = setup();
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
  await using screen = await renderMarkdown("[Readme](readme.md)");
  await screen.openContextMenu();
  expect(state.search).toHaveBeenCalledOnce();
  await act(async () => {
    state.allowed = false;
    finishLookup();
  });
  expect(state.openEditor).not.toHaveBeenCalled();
});

it.each(["link-to-thread", "unlink-from-thread"])(
  "rechecks %s after a native context menu returns",
  async (action) => {
    using _setup = setup();
    state.pullRequests = action === "unlink-from-thread" ? [linkedPullRequest] : [];
    const command = action === "link-to-thread" ? state.link : state.unlink;
    let choose: (action: string) => void = () => {
      throw new Error("Menu not opened");
    };
    state.choose.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          choose = resolve;
        }),
    );
    await using screen = await renderMarkdown(`[Review](${linkedPullRequest.url})`);
    await screen.openContextMenu();
    expect(offeredActions()).toContain(action);
    await act(async () => {
      state.allowed = false;
      choose(action);
    });
    expect(command).not.toHaveBeenCalled();

    await setAllowed(true);
    state.choose.mockResolvedValue(action);
    await screen.openContextMenu();
    await vi.waitFor(() =>
      expect(command).toHaveBeenCalledExactlyOnceWith({
        environmentId: threadRef.environmentId,
        input: expect.objectContaining({
          threadId: threadRef.threadId,
          repository: "example/repo",
          number: 42,
        }),
      }),
    );
  },
);

it("acts on a verified thread file and yields to a root file that appears", async () => {
  using _setup = setup();
  const candidate = "/other/checkout/docs/readme.md";
  const text = "[Readme](docs/readme.md:12:3) and `test/readme.md`";
  await using screen = await renderMarkdown(text, createThreadFilePathIndex([candidate]));
  const normalText = screen.container.textContent;
  const expectPanel = async (path: string) => {
    state.openFile.mockClear();
    await act(async () => screen.anchor().click());
    expect(state.openFile).toHaveBeenCalledExactlyOnceWith(threadRef, path, 12);
    expect(screen.container.textContent).toBe(normalText);
  };

  await expectPanel("docs/readme.md");
  await settleMetadata("/work/docs/readme.md", AsyncResult.success(null));
  const candidateResults: MetadataResult[] = [
    AsyncResult.success(null),
    AsyncResult.failure(Cause.fail(new Error("Metadata failed"))),
    AsyncResult.success({ kind: "directory" }),
  ];
  for (const result of candidateResults) {
    await settleMetadata(candidate, result);
    await expectPanel("docs/readme.md");
  }
  await settleMetadata(candidate, AsyncResult.success({ kind: "file" }));
  state.search.mockClear();
  await expectPanel(candidate);

  state.choose.mockResolvedValue("copy-full");
  await screen.openContextMenu();
  await vi.waitFor(() => expect(state.copy).toHaveBeenLastCalledWith(`${candidate}:12:3`));
  state.choose.mockResolvedValue("reveal");
  await screen.openContextMenu();
  await vi.waitFor(() =>
    expect(state.openEditor).toHaveBeenLastCalledWith({
      environmentId: threadRef.environmentId,
      input: { cwd: candidate, editor: "file-manager", reveal: true },
    }),
  );
  expect(state.search).not.toHaveBeenCalled();

  await settleMetadata("/work/docs/readme.md", AsyncResult.success({ kind: "file" }));
  await expectPanel("docs/readme.md");
});

it("does not treat pending, failed, existing, or unreadable root metadata as missing", async () => {
  using _setup = setup();
  const candidate = "/other/docs/guide.md";
  await settleMetadata(candidate, AsyncResult.success({ kind: "file" }));
  await using screen = await renderMarkdown(
    "`docs/guide.md`",
    createThreadFilePathIndex([candidate]),
  );
  const expectPanel = async (path: string) => {
    state.openFile.mockClear();
    await act(async () => screen.anchor().click());
    expect(state.openFile).toHaveBeenCalledExactlyOnceWith(threadRef, path, undefined);
  };
  const rootResults: MetadataResult[] = [
    AsyncResult.initial(true),
    AsyncResult.waiting(AsyncResult.success(null)),
    AsyncResult.failure(Cause.fail(new Error("Disconnected or denied"))),
    AsyncResult.success({ kind: "file" }),
  ];
  for (const rootResult of rootResults) {
    await settleMetadata("/work/docs/guide.md", rootResult);
    await expectPanel("docs/guide.md");
  }
  await act(async () => {
    state.canRead = false;
    for (const listener of state.listeners) listener();
  });
  await settleMetadata("/work/docs/guide.md", AsyncResult.success(null));
  await expectPanel("docs/guide.md");
  await act(async () => {
    state.canRead = true;
    for (const listener of state.listeners) listener();
  });
  await expectPanel(candidate);
});

it("verifies a rootless candidate and keeps the authored label", async () => {
  using _setup = setup();
  const candidate = "/outside/read%20 #?/docs/guide.ts";
  const index = createThreadFilePathIndex([candidate]);
  for (const text of [
    "[Read the file](docs/guide.ts:12:3)",
    "`docs/guide.ts:12:3`",
    "[](docs/guide.ts:12:3)",
  ]) {
    await settleMetadata(candidate, AsyncResult.initial(true));
    state.openFile.mockClear();
    await using screen = await renderMarkdown(text, index, null);
    const label = screen.container.textContent;
    await settleMetadata(candidate, AsyncResult.success({ kind: "file" }));
    expect(screen.container.textContent).toBe(label || "guide.ts · L12:C3");
    await act(async () => screen.anchor().click());
    expect(state.openFile).toHaveBeenCalledExactlyOnceWith(threadRef, candidate, 12);
  }
});
