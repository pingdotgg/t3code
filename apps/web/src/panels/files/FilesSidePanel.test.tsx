import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import {
  act,
  cloneElement,
  Suspense,
  use,
  useLayoutEffect,
  type ReactElement,
  type ReactNode,
} from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ChatComposerHandle } from "~/components/chat/ChatComposer";
import { toastManager } from "~/components/ui/toast";
import { ComposerHandleContext, type ComposerHandleRef } from "~/composerHandleContext";
import { readThreadPreviewState, resetPreviewStateForTests } from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";

const { siblingsByEnvironment, late, Wrapper, MenuContext, RadioContext } = await vi.hoisted(
  async () => {
    const { createContext: createHoistedContext } = await import("react");
    // Settles when a test says so, like a native menu or a server round trip.
    const deferred = <A,>() => {
      let resolve!: (value: A) => void;
      const promise = new Promise<A>((settle) => (resolve = settle));
      return { promise, resolve };
    };
    const late = {
      deferred,
      // The tree's right-click handler, as handed to the Pierre tree.
      openTreeMenu: null as null | ((item: unknown, context: unknown) => void),
      // The tree's selection handler from its first render; the real tree keeps that one.
      selectTreeRows: null as null | ((paths: ReadonlyArray<string>) => void),
      menuChoice: deferred<string | null>(),
      assetUrl: deferred<unknown>(),
      session: deferred<unknown>(),
      // Saved browser settings; already loaded unless a test holds them.
      browserDefaults: null as null | Promise<unknown>,
      previewRequests: 0,
    };
    return {
      late,
      // Files in the `src` folder, per environment.
      siblingsByEnvironment: new Map<string, ReadonlyArray<string>>(),
      Wrapper: ({ children }: { children?: ReactNode }) => children,
      MenuContext: createHoistedContext<(open: boolean) => void>(() => undefined),
      RadioContext: createHoistedContext<(value: string) => void>(() => undefined),
    };
  },
);

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => [] }));
vi.mock("~/state/server", () => ({ primaryServerKeybindingsAtom: {} }));
// This client holds every scope, so files can be read, written and previewed.
vi.mock("~/state/filesystem", () => ({
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
}));
vi.mock("~/state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/session")>()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
// The desktop app hosts these browsers itself, so no environment's server browser is consulted.
vi.mock("~/browser/previewRuntime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/browser/previewRuntime")>()),
  previewRuntimeFor: () => undefined,
  isPreviewAvailableFor: () => true,
  usePreviewAvailable: () => true,
}));
vi.mock("~/state/environments", () => ({
  useEnvironmentHttpBaseUrl: () => "http://localhost:3773/",
  usePrimaryEnvironmentId: () => null,
}));
vi.mock("~/remoteOpen", () => ({ useRemoteOpenState: () => ({ mode: "local-exec" }) }));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: (select: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    select(DEFAULT_CLIENT_SETTINGS),
  useUpdateClientSettings: () => vi.fn(),
}));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
// The panel's only command and query runner: open a preview session, create an asset URL.
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => () => {
    late.previewRequests += 1;
    return late.session.promise;
  },
}));
vi.mock("~/state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => () => late.assetUrl.promise,
}));
vi.mock("~/browser/browserDefaults", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/browser/browserDefaults")>()),
  resolveBrowserDefaults: () =>
    late.browserDefaults ?? Promise.resolve({ viewport: { _tag: "fill" }, profileId: "default" }),
}));
vi.mock("~/components/files/projectFilesQueryState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/components/files/projectFilesQueryState")>()),
  useProjectFileQuery: () => ({
    data: null,
    error: null,
    isPending: true,
    isNotFile: false,
    refresh: vi.fn(),
  }),
  useProjectEntriesQuery: (environmentId: string, _cwd: string, directoryPath?: string) => ({
    data:
      directoryPath === "src"
        ? {
            entries: (siblingsByEnvironment.get(environmentId) ?? []).map((path) => ({
              path,
              kind: "file",
              parentPath: "src",
            })),
            truncated: false,
          }
        : null,
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
}));
vi.mock("~/components/DiffWorkerPoolProvider", () => ({ DiffWorkerPoolProvider: Wrapper }));
// The Pierre tree is a web component; this stand-in keeps the real panel's right-click handler.
vi.mock("@pierre/trees/react", () => ({
  FileTree: () => null,
  useFileTree: (options: {
    composition: { contextMenu: { onOpen: (item: unknown, context: unknown) => void } };
    onSelectionChange: (paths: ReadonlyArray<string>) => void;
  }) => {
    late.openTreeMenu = options.composition.contextMenu.onOpen;
    late.selectTreeRows ??= options.onSelectionChange;
    return {
      model: {
        isSearchOpen: () => false,
        getItem: () => null,
        getSelectedPaths: () => [],
        subscribe: () => () => undefined,
        setGitStatus: () => undefined,
        resetPaths: () => undefined,
        batch: () => undefined,
        closeSearch: () => undefined,
        scrollToPath: () => undefined,
      },
    };
  },
  useFileTreeSearch: () => ({ value: "", close: () => undefined, setValue: () => undefined }),
  useFileTreeSelector: () => false,
}));
vi.mock("~/components/files/useDirectoryEntries", () => ({
  useDirectoryEntries: () => ({
    entries: [
      { path: "src", kind: "directory" },
      { path: "README.md", kind: "file" },
    ],
    load: () => undefined,
    refresh: () => undefined,
    isPending: false,
    ready: true,
    error: null,
  }),
}));
vi.mock("~/state/queries", () => ({
  useProjectPathSearch: () => ({ entries: [], isPending: false, refresh: () => undefined }),
}));
vi.mock("~/fileContextMenu", () => ({
  useFileContextMenu: () => ({ buildItems: () => [], activate: vi.fn() }),
}));
vi.mock("~/localApi", () => ({
  readLocalApi: () => ({ contextMenu: { show: () => late.menuChoice.promise } }),
}));
vi.mock("~/components/chat/PierreEntryIcon", () => ({ PierreEntryIcon: () => null }));
vi.mock("~/components/ui/tooltip", () => ({
  Tooltip: Wrapper,
  TooltipTrigger: ({ children, render }: { children?: ReactNode; render?: ReactElement }) =>
    render ? cloneElement(render, {}, children) : children,
  TooltipPopup: () => null,
}));
// Menus render through a portal; these stand-ins keep their open and pick semantics.
vi.mock("~/components/ui/menu", () => ({
  Menu: ({
    children,
    onOpenChange,
  }: {
    children?: ReactNode;
    onOpenChange: (open: boolean) => void;
  }) => <MenuContext value={onOpenChange}>{children}</MenuContext>,
  MenuTrigger: function MenuTrigger({ render }: { render: ReactElement }) {
    const onOpenChange = use(MenuContext);
    return cloneElement(render as ReactElement<{ onClick: () => void }>, {
      onClick: () => onOpenChange(true),
    });
  },
  MenuPopup: Wrapper,
  MenuGroup: Wrapper,
  MenuItem: Wrapper,
  MenuSeparator: () => null,
  MenuRadioGroup: ({
    children,
    onValueChange,
  }: {
    children?: ReactNode;
    onValueChange: (value: string) => void;
  }) => <RadioContext value={onValueChange}>{children}</RadioContext>,
  MenuRadioItem: function MenuRadioItem({
    children,
    value,
  }: {
    children?: ReactNode;
    value: string;
  }) {
    const onValueChange = use(RadioContext);
    return (
      <button type="button" data-value={value} onClick={() => onValueChange(value)}>
        {children}
      </button>
    );
  },
}));

import { RegisteredSidePanel } from "../bundledPanels";
import { PanelHostContext, type PanelHost } from "../panelHost";

// The same thread id on two environments is two threads.
const refOn = (environmentId: string, thread = "thread-a"): ScopedThreadRef => ({
  environmentId: EnvironmentId.make(environmentId),
  threadId: ThreadId.make(thread),
});
let renderer: ReactTestRenderer | undefined;

// The chat layout owns one composer ref; navigation swaps the composer behind it.
const composerRef: ComposerHandleRef = { current: null };
const composers = new Map<
  string,
  ReturnType<typeof vi.fn<ChatComposerHandle["insertTextAtEnd"]>>
>();
function composerOf(threadRef: ScopedThreadRef) {
  const key = scopedThreadKey(threadRef);
  if (!composers.has(key))
    composers.set(
      key,
      vi.fn(() => true),
    );
  return composers.get(key)!;
}

// Runs `run` inside the commit, after the panel's layout effects and before any passive effect.
function DuringCommit({ run }: { run: (() => void) | undefined }) {
  useLayoutEffect(() => run?.(), [run]);
  return null;
}

async function renderFileFor(
  threadRef: ScopedThreadRef,
  relativePath: string | null = "src/a.ts",
  composerDraftTarget: PanelHost["composerDraftTarget"] = threadRef,
  duringCommit?: () => void,
) {
  const host: PanelHost = {
    threadRef,
    visible: true,
    composerDraftTarget,
    workspaceMutationId: null,
    sendAnnotation: () => undefined,
  };
  const element = (
    <ComposerHandleContext value={composerRef}>
      <PanelHostContext value={host}>
        <Suspense fallback={null}>
          <RegisteredSidePanel
            id="files"
            cwd="/repo"
            projectName="repo"
            relativePath={relativePath}
            availableEditors={[]}
            revealLine={null}
            revealRequestId={0}
            onPendingChange={() => undefined}
            selectedFilePending={false}
          />
        </Suspense>
        <DuringCommit run={duringCommit} />
      </PanelHostContext>
    </ComposerHandleContext>
  );
  await act(async () => {
    composerRef.current = {
      insertTextAtEnd: composerOf(threadRef),
    } as unknown as ChatComposerHandle;
    if (renderer) renderer.update(element);
    else renderer = create(element);
  });
}

async function press(node: ReactTestInstance) {
  await act(async () => node.props.onClick());
}

async function openSrcFolder() {
  const browse = renderer!.root.findAll(
    (node) => node.type === "button" && node.props["aria-label"] === "Browse src",
  );
  expect(browse).toHaveLength(1);
  await press(browse[0]!);
}

const siblingValues = () =>
  renderer!.root
    .findAll((node) => node.type === "button" && node.props["data-value"] !== undefined)
    .map((node) => node.props["data-value"] as string);

const surfacesOf = (threadRef: ScopedThreadRef) =>
  useRightPanelStore.getState().byThreadKey[scopedThreadKey(threadRef)]?.surfaces;

// Right-clicks a tree row and returns a way to pick from the native menu later.
function rightClickTreeRow() {
  late.menuChoice = late.deferred();
  const closed = late.deferred<void>();
  late.openTreeMenu!(
    { path: "src/a.ts" },
    {
      anchorElement: { getBoundingClientRect: () => ({ left: 0, bottom: 0 }) },
      close: closed.resolve,
    },
  );
  return (choice: string) =>
    act(async () => {
      late.menuChoice.resolve(choice);
      await closed.promise;
    });
}

const insertedAnywhere = () => [...composers.values()].some((insert) => insert.mock.calls.length);

const browsersOf = (threadRef: ScopedThreadRef) =>
  (surfacesOf(threadRef) ?? []).filter((surface) => surface.kind === "preview");

// Presses "Open file in preview browser" with the asset URL and preview session still pending.
async function openInBrowser() {
  late.assetUrl = late.deferred();
  late.session = late.deferred();
  await press(
    renderer!.root.find(
      (node) =>
        node.type === "button" && node.props["aria-label"] === "Open file in preview browser",
    ),
  );
}

const settleAsset = () =>
  act(async () => {
    late.assetUrl.resolve(AsyncResult.success({ relativeUrl: "/a/index.html", expiresAt: 0 }));
  });
const settleSession = () =>
  act(async () => {
    late.session.resolve(
      AsyncResult.success({
        threadId: ThreadId.make("thread-a"),
        tabId: "tab-1",
        navStatus: { _tag: "Loading", url: "http://localhost:3773/a/index.html", title: "" },
        canGoBack: false,
        canGoForward: false,
        updatedAt: "2026-10-04T00:00:00.000Z",
      }),
    );
  });

const failAsset = () =>
  act(async () => {
    late.assetUrl.resolve(AsyncResult.failure(Cause.fail(new Error("asset unavailable"))));
  });
const failSession = () =>
  act(async () => {
    late.session.resolve(AsyncResult.failure(Cause.fail(new Error("preview unavailable"))));
  });
const browserErrorToasts = () =>
  vi
    .mocked(toastManager.add)
    .mock.calls.filter(([toast]) => toast.title === "Unable to open file in browser");

// Transform the lazy body once up front, so mounting it settles inside one act().
beforeAll(() => import("./FilesSidePanel"), 30_000);
beforeEach(() => {
  late.selectTreeRows = null;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const storage = new Map<string, string>();
  vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("window", {
    desktopBridge: { preview: {} },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  });
  siblingsByEnvironment.clear();
  composers.clear();
  late.previewRequests = 0;
  late.browserDefaults = null;
  vi.spyOn(toastManager, "add");
  resetPreviewStateForTests();
  siblingsByEnvironment.set("environment-a", ["src/a.ts", "src/b.ts"]);
  siblingsByEnvironment.set("environment-b", ["src/a.ts", "src/c.ts"]);
  useRightPanelStore.setState({
    byThreadKey: {},
    threadPanelVisibilityByThreadKey: {},
    userActionRevisionByThreadKey: {},
  });
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("files side panel", () => {
  it("opens a sibling file as a tab in the host's own thread", async () => {
    const threadRef = refOn("environment-a");
    await renderFileFor(threadRef);
    await openSrcFolder();
    expect(siblingValues()).toEqual(["src/a.ts", "src/b.ts"]);

    await press(
      renderer!.root.find(
        (node) => node.type === "button" && node.props["data-value"] === "src/b.ts",
      ),
    );
    expect(surfacesOf(threadRef)).toMatchObject([{ kind: "file", relativePath: "src/b.ts" }]);
    expect(surfacesOf(refOn("environment-b"))).toBeUndefined();
  });

  it("follows the host to another environment's thread with the same id", async () => {
    await renderFileFor(refOn("environment-a"));
    const threadRef = refOn("environment-b");
    await renderFileFor(threadRef);
    await openSrcFolder();
    expect(siblingValues()).toEqual(["src/a.ts", "src/c.ts"]);

    await press(
      renderer!.root.find(
        (node) => node.type === "button" && node.props["data-value"] === "src/c.ts",
      ),
    );
    expect(surfacesOf(threadRef)).toMatchObject([{ kind: "file", relativePath: "src/c.ts" }]);
    expect(surfacesOf(refOn("environment-a"))).toBeUndefined();
  });

  it("opens a tree click in the thread showing now, not the one the tree first showed", async () => {
    // Threads in the same project share one tree, so it outlives the switch.
    await renderFileFor(refOn("environment-a"));
    const threadRef = refOn("environment-a", "thread-b");
    await renderFileFor(threadRef);

    await act(async () => late.selectTreeRows!(["README.md"]));
    expect(surfacesOf(threadRef)).toMatchObject([{ kind: "file", relativePath: "README.md" }]);
    expect(surfacesOf(refOn("environment-a"))).toBeUndefined();
  });

  it("opens a tree click that lands before the switch's passive effects in the new thread", async () => {
    await renderFileFor(refOn("environment-a"));
    const threadRef = refOn("environment-a", "thread-b");
    await renderFileFor(threadRef, "src/a.ts", threadRef, () =>
      late.selectTreeRows!(["README.md"]),
    );

    expect(surfacesOf(threadRef)).toMatchObject([{ kind: "file", relativePath: "README.md" }]);
    expect(surfacesOf(refOn("environment-a"))).toBeUndefined();
  });
});

describe("files actions that settle late", () => {
  it("adds a tree entry to the chat of the thread it was picked in", async () => {
    const threadRef = refOn("environment-a");
    await renderFileFor(threadRef, null);
    const pick = rightClickTreeRow();
    await pick("add-to-chat");
    expect(composerOf(threadRef)).toHaveBeenCalledExactlyOnceWith("[a.ts](src/a.ts) ", {
      ensureLeadingBoundary: true,
    });
  });

  it("drops a late Add to chat after moving to the same thread id in another environment", async () => {
    await renderFileFor(refOn("environment-a"), null);
    const pick = rightClickTreeRow();
    await renderFileFor(refOn("environment-b"), null);
    await pick("add-to-chat");
    expect(insertedAnywhere()).toBe(false);
  });

  it("drops a late Add to chat after moving to another thread in the project", async () => {
    await renderFileFor(refOn("environment-a"), null);
    const pick = rightClickTreeRow();
    await renderFileFor(refOn("environment-a", "thread-other"), null);
    await pick("add-to-chat");
    expect(insertedAnywhere()).toBe(false);

    // The new thread's own menu still reaches its composer.
    await rightClickTreeRow()("add-to-chat");
    expect(composerOf(refOn("environment-a", "thread-other"))).toHaveBeenCalledOnce();
  });

  it("keeps a late Add to chat dropped after leaving and returning to the thread", async () => {
    const threadRef = refOn("environment-a");
    await renderFileFor(threadRef, null);
    const pick = rightClickTreeRow();
    await renderFileFor(refOn("environment-a", "thread-other"), null);
    await renderFileFor(threadRef, null);
    await pick("add-to-chat");
    expect(insertedAnywhere()).toBe(false);
  });

  it("opens a Browser tab in the thread that is still showing", async () => {
    const threadRef = refOn("environment-a");
    await renderFileFor(threadRef, "index.html");
    await openInBrowser();
    await settleAsset();
    await settleSession();
    expect(browsersOf(threadRef).map((surface) => surface.id)).toEqual(["browser:tab-1"]);
  });

  it("still opens a browser after the composer switches drafts in the same thread", async () => {
    const threadRef = refOn("environment-a");
    await renderFileFor(threadRef, "index.html");
    await openInBrowser();
    // Editing a queued message moves the composer to a draft; the thread stays.
    await renderFileFor(threadRef, "index.html", "draft-1" as PanelHost["composerDraftTarget"]);
    await settleAsset();
    await settleSession();
    expect(browsersOf(threadRef).map((surface) => surface.id)).toEqual(["browser:tab-1"]);
  });

  it("never asks for a browser when the thread was left while the file was prepared", async () => {
    const threadRef = refOn("environment-a");
    await renderFileFor(threadRef, "index.html");
    await openInBrowser();
    await renderFileFor(refOn("environment-b"), "index.html");
    await settleAsset();
    expect(late.previewRequests).toBe(0);
    expect(browsersOf(threadRef)).toEqual([]);
    expect(browsersOf(refOn("environment-b"))).toEqual([]);
  });

  it("keeps a browser the server opened after the thread was left in that thread", async () => {
    const threadRef = refOn("environment-a");
    await renderFileFor(threadRef, "index.html");
    await openInBrowser();
    await settleAsset();
    expect(late.previewRequests).toBe(1);
    await renderFileFor(refOn("environment-a", "thread-other"), "index.html");
    await settleSession();
    expect(readThreadPreviewState(threadRef).snapshot?.tabId).toBe("tab-1");
    expect(browsersOf(threadRef).map((surface) => surface.id)).toEqual(["browser:tab-1"]);
    expect(browsersOf(refOn("environment-a", "thread-other"))).toEqual([]);
  });

  it("keeps a late open dropped after leaving and returning to the thread", async () => {
    const threadRef = refOn("environment-a");
    await renderFileFor(threadRef, "index.html");
    await openInBrowser();
    await renderFileFor(refOn("environment-a", "thread-other"), "index.html");
    await renderFileFor(threadRef, "index.html");
    await settleAsset();
    expect(late.previewRequests).toBe(0);
    expect(browsersOf(threadRef)).toEqual([]);
  });

  it("reports a browser failure in the thread that is still showing", async () => {
    await renderFileFor(refOn("environment-a"), "index.html");
    await openInBrowser();
    await failAsset();
    expect(browserErrorToasts()).toHaveLength(1);
  });

  it("stays silent when the file fails to prepare after the thread was left", async () => {
    await renderFileFor(refOn("environment-a"), "index.html");
    await openInBrowser();
    await renderFileFor(refOn("environment-b"), "index.html");
    await failAsset();
    expect(browserErrorToasts()).toEqual([]);
  });

  it("stays silent when browser settings fail to load after the panel closed", async () => {
    await renderFileFor(refOn("environment-a"), "index.html");
    let rejectSettings!: (error: Error) => void;
    late.browserDefaults = new Promise((_, reject) => (rejectSettings = reject));
    await openInBrowser();
    await settleAsset();
    act(() => renderer!.unmount());
    renderer = undefined;
    await act(async () => rejectSettings(new Error("settings unreadable")));
    expect(late.previewRequests).toBe(0);
    expect(browserErrorToasts()).toEqual([]);
  });

  it("stays silent when a browser fails to open after leaving and returning", async () => {
    const threadRef = refOn("environment-a");
    await renderFileFor(threadRef, "index.html");
    await openInBrowser();
    await settleAsset();
    await renderFileFor(refOn("environment-a", "thread-other"), "index.html");
    await renderFileFor(threadRef, "index.html");
    await failSession();
    expect(browserErrorToasts()).toEqual([]);
  });
});
