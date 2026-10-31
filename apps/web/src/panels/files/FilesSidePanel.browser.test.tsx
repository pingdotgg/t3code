import { act, render as renderScreen, type Screen } from "../../../test/render";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import {
  cloneElement,
  Suspense,
  use,
  useLayoutEffect,
  type ReactElement,
  type ReactNode,
} from "react";
import { describe, expect, it, vi } from "vite-plus/test";

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

vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => [],
}));
vi.mock("~/state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentServerConfigsAtom: Atom.make(new Map()),
    primaryServerKeybindingsAtom: {},
    primaryServerEnvironmentThemesAtom: Atom.make([]),
    serverEnvironment: { configValueAtom: () => null },
  };
});
// This client holds every scope, so files can be read, written and previewed.
vi.mock("~/state/filesystem", () => ({
  filesystemEnvironment: {},
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
}));
vi.mock("~/state/session", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const Option = await import("effect/Option");
  return {
    environmentSession: {
      initialConfigValueAtom: Atom.family(() => Atom.make(null)),
      preparedConnectionValueAtom: Atom.family(() => Atom.make(Option.none())),
      sessionStateAtom: Atom.family(() => Atom.make(AsyncResult.initial())),
    },
    environmentSessionStatesAtom: () => Atom.make([]),
    readPreparedConnection: () => null,
    usePreparedConnection: (): ReturnType<typeof import("~/state/session").usePreparedConnection> =>
      Option.none(),

    useEnvironmentScope: () => true,
    readEnvironmentScope: () => true,
    sessionHasScope: () => true,
  };
});
// The desktop app hosts these browsers itself, so no environment's server browser is consulted.
vi.mock("~/browser/previewRuntime", () => ({
  previewRuntimeFor: () => undefined,
  isPreviewAvailableFor: () => true,
  usePreviewAvailable: () => true,
}));
vi.mock("~/state/environments", () => ({
  useEnvironmentHttpBaseUrl: () => "http://localhost:3773/",
  usePrimaryEnvironmentId: () => null,
  readPrimaryEnvironmentId: () => null,
  useEnvironment: () => ({ label: "Local" }),
}));
vi.mock("~/remoteOpen", () => ({
  openRemoteEditorUrl: vi.fn(),
  useRemoteCapableEditors: () => [],
  useRemoteOpenHint: () => null,
  resolveRemoteOpenState: () => ({ mode: "local-exec" }),
  useRemoteOpenResolution: () => ({ mode: "local-exec" }),
  useRemoteOpenState: () => ({ mode: "local-exec" }),
}));
vi.mock("~/hooks/useSettings", () => ({
  updateClientSettings: vi.fn(),
  isClientSettingsHydrated: () => true,
  ensureClientSettingsHydrated: () => Promise.resolve(),
  getClientSettings: () => DEFAULT_CLIENT_SETTINGS,
  useClientSettings: (select: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    select(DEFAULT_CLIENT_SETTINGS),
  useUpdateClientSettings: () => vi.fn(),
}));
vi.mock("~/hooks/useTheme", () => ({
  useRenderedAppearance: () => "light",
  useTheme: () => ({ resolvedTheme: "light" }),
}));
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
vi.mock("~/browser/browserDefaults", () => ({
  browserDefaultOpenProfileId: () => "default",
  browserDefaultOpenViewport: () => ({ _tag: "fill" }),
  resolveBrowserDefaults: () =>
    late.browserDefaults ?? Promise.resolve({ viewport: { _tag: "fill" }, profileId: "default" }),
}));
vi.mock("~/components/files/projectFilesQueryState", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    confirmProjectFileQueryData: vi.fn(),
    getUnsavedProjectFileQueryData: () => null,
    getOptimisticProjectFileQueryData: () => null,
    getProjectFileContents: () => undefined,
    getProjectFileQueryAtom: () => Atom.make(null),
    setProjectFileQueryData: vi.fn(),
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
  };
});

vi.mock("~/components/DiffWorkerPoolProvider", () => ({ DiffWorkerPoolProvider: Wrapper }));
// The Pierre tree is a web component; this stand-in keeps the real panel's right-click handler.
vi.mock("@pierre/trees/react", () => ({
  FileTree: () => <span>File tree ready</span>,
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
vi.mock("~/components/chat/OpenInPicker", () => ({ OpenInPicker: () => null }));
vi.mock("~/components/chat/PierreEntryIcon", () => ({ PierreEntryIcon: () => null }));
vi.mock("~/components/ui/tooltip", () => ({
  Tooltip: Wrapper,
  TooltipTrigger: ({ children, render }: { children?: ReactNode; render?: ReactElement }) =>
    render ? cloneElement(render, {}, children) : children,
  TooltipPopup: () => null,
}));
// Menus render through a portal; these stand-ins keep their open and pick semantics.
vi.mock("~/components/ui/menu", () => ({
  MenuItemLabel: Wrapper,
  MenuShortcut: () => null,
  MenuSub: Wrapper,
  MenuSubTrigger: Wrapper,
  MenuSubPopup: Wrapper,
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
  screen: Screen,
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
            openInShortcutEnabled
            id="files"
            onNavigateFolder={() => undefined}
            folderTrail={undefined}
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
    await screen.rerender(element);
  });
  if (relativePath === null) {
    await expect.element(screen.getByText("File tree ready", { exact: true })).toBeVisible();
  } else {
    await expect
      .element(screen.getByRole("navigation", { name: "File path", exact: true }))
      .toBeVisible();
  }
}

async function press(node: HTMLButtonElement) {
  await act(async () => node.click());
}

async function openSrcFolder(screen: Screen) {
  await expect
    .element(screen.getByRole("button", { name: "Browse src", exact: true }))
    .toBeVisible();
  const browse = screen.container.querySelectorAll<HTMLButtonElement>(
    'button[aria-label="Browse src"]',
  );
  expect(browse).toHaveLength(1);
  await press(browse[0]!);
}

const siblingValues = (screen: Screen) =>
  Array.from(screen.container.querySelectorAll<HTMLButtonElement>("button[data-value]")).map(
    (node) => node.dataset.value,
  );

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
async function openInBrowser(screen: Screen) {
  late.assetUrl = late.deferred();
  late.session = late.deferred();
  await press(
    screen.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Open file in preview browser"]',
    )!,
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

describe("files side panel", () => {
  it("opens a sibling file as a tab in the host's own thread", async () => {
    resetFixture();
    using _toast = vi.spyOn(toastManager, "add");
    await import("./FilesSidePanel");
    await using screen = await renderScreen(null, { router: false });
    const threadRef = refOn("environment-a");
    await renderFileFor(screen, threadRef);
    await openSrcFolder(screen);
    expect(siblingValues(screen)).toEqual(["src/a.ts", "src/b.ts"]);

    await press(
      screen.container.querySelector<HTMLButtonElement>('button[data-value="src/b.ts"]')!,
    );
    expect(surfacesOf(threadRef)).toMatchObject([{ kind: "file", relativePath: "src/b.ts" }]);
    expect(surfacesOf(refOn("environment-b"))).toBeUndefined();
  });

  it("follows the host to another environment's thread with the same id", async () => {
    resetFixture();
    using _toast = vi.spyOn(toastManager, "add");
    await import("./FilesSidePanel");
    await using screen = await renderScreen(null, { router: false });
    await renderFileFor(screen, refOn("environment-a"));
    const threadRef = refOn("environment-b");
    await renderFileFor(screen, threadRef);
    await openSrcFolder(screen);
    expect(siblingValues(screen)).toEqual(["src/a.ts", "src/c.ts"]);

    await press(
      screen.container.querySelector<HTMLButtonElement>('button[data-value="src/c.ts"]')!,
    );
    expect(surfacesOf(threadRef)).toMatchObject([{ kind: "file", relativePath: "src/c.ts" }]);
    expect(surfacesOf(refOn("environment-a"))).toBeUndefined();
  });

  it("opens a tree click in the thread showing now, not the one the tree first showed", async () => {
    resetFixture();
    using _toast = vi.spyOn(toastManager, "add");
    await import("./FilesSidePanel");
    await using screen = await renderScreen(null, { router: false });
    // Threads in the same project share one tree, so it outlives the switch.
    await renderFileFor(screen, refOn("environment-a"));
    const threadRef = refOn("environment-a", "thread-b");
    await renderFileFor(screen, threadRef);

    await act(async () => late.selectTreeRows!(["README.md"]));
    expect(surfacesOf(threadRef)).toMatchObject([{ kind: "file", relativePath: "README.md" }]);
    expect(surfacesOf(refOn("environment-a"))).toBeUndefined();
  });

  it("opens a tree click that lands before the switch's passive effects in the new thread", async () => {
    resetFixture();
    using _toast = vi.spyOn(toastManager, "add");
    await import("./FilesSidePanel");
    await using screen = await renderScreen(null, { router: false });
    await renderFileFor(screen, refOn("environment-a"));
    const threadRef = refOn("environment-a", "thread-b");
    await renderFileFor(screen, threadRef, "src/a.ts", threadRef, () =>
      late.selectTreeRows!(["README.md"]),
    );

    expect(surfacesOf(threadRef)).toMatchObject([{ kind: "file", relativePath: "README.md" }]);
    expect(surfacesOf(refOn("environment-a"))).toBeUndefined();
  });
});

describe("files actions that settle late", () => {
  it("adds a tree entry to the chat of the thread it was picked in", async () => {
    resetFixture();
    using _toast = vi.spyOn(toastManager, "add");
    await import("./FilesSidePanel");
    await using screen = await renderScreen(null, { router: false });
    const threadRef = refOn("environment-a");
    await renderFileFor(screen, threadRef, null);
    const pick = rightClickTreeRow();
    await pick("add-to-chat");
    expect(composerOf(threadRef)).toHaveBeenCalledExactlyOnceWith("[a.ts](src/a.ts) ", {
      ensureLeadingBoundary: true,
    });
  });

  it("drops a late Add to chat after moving to the same thread id in another environment", async () => {
    resetFixture();
    using _toast = vi.spyOn(toastManager, "add");
    await import("./FilesSidePanel");
    await using screen = await renderScreen(null, { router: false });
    await renderFileFor(screen, refOn("environment-a"), null);
    const pick = rightClickTreeRow();
    await renderFileFor(screen, refOn("environment-b"), null);
    await pick("add-to-chat");
    expect(insertedAnywhere()).toBe(false);
  });

  it("drops a late Add to chat after moving to another thread in the project", async () => {
    resetFixture();
    using _toast = vi.spyOn(toastManager, "add");
    await import("./FilesSidePanel");
    await using screen = await renderScreen(null, { router: false });
    await renderFileFor(screen, refOn("environment-a"), null);
    const pick = rightClickTreeRow();
    await renderFileFor(screen, refOn("environment-a", "thread-other"), null);
    await pick("add-to-chat");
    expect(insertedAnywhere()).toBe(false);

    // The new thread's own menu still reaches its composer.
    await rightClickTreeRow()("add-to-chat");
    expect(composerOf(refOn("environment-a", "thread-other"))).toHaveBeenCalledOnce();
  });

  it("keeps a late Add to chat dropped after leaving and returning to the thread", async () => {
    resetFixture();
    using _toast = vi.spyOn(toastManager, "add");
    await import("./FilesSidePanel");
    await using screen = await renderScreen(null, { router: false });
    const threadRef = refOn("environment-a");
    await renderFileFor(screen, threadRef, null);
    const pick = rightClickTreeRow();
    await renderFileFor(screen, refOn("environment-a", "thread-other"), null);
    await renderFileFor(screen, threadRef, null);
    await pick("add-to-chat");
    expect(insertedAnywhere()).toBe(false);
  });

  it("opens a Browser tab in the thread that is still showing", async () => {
    resetFixture();
    using _toast = vi.spyOn(toastManager, "add");
    await import("./FilesSidePanel");
    await using screen = await renderScreen(null, { router: false });
    const threadRef = refOn("environment-a");
    await renderFileFor(screen, threadRef, "index.html");
    await openInBrowser(screen);
    await settleAsset();
    await settleSession();
    expect(browsersOf(threadRef).map((surface) => surface.id)).toEqual(["browser:tab-1"]);
  });

  it("still opens a browser after the composer switches drafts in the same thread", async () => {
    resetFixture();
    using _toast = vi.spyOn(toastManager, "add");
    await import("./FilesSidePanel");
    await using screen = await renderScreen(null, { router: false });
    const threadRef = refOn("environment-a");
    await renderFileFor(screen, threadRef, "index.html");
    await openInBrowser(screen);
    // Editing a queued message moves the composer to a draft; the thread stays.
    await renderFileFor(
      screen,
      threadRef,
      "index.html",
      "draft-1" as PanelHost["composerDraftTarget"],
    );
    await settleAsset();
    await settleSession();
    expect(browsersOf(threadRef).map((surface) => surface.id)).toEqual(["browser:tab-1"]);
  });

  it("never asks for a browser when the thread was left while the file was prepared", async () => {
    resetFixture();
    using _toast = vi.spyOn(toastManager, "add");
    await import("./FilesSidePanel");
    await using screen = await renderScreen(null, { router: false });
    const threadRef = refOn("environment-a");
    await renderFileFor(screen, threadRef, "index.html");
    await openInBrowser(screen);
    await renderFileFor(screen, refOn("environment-b"), "index.html");
    await settleAsset();
    expect(late.previewRequests).toBe(0);
    expect(browsersOf(threadRef)).toEqual([]);
    expect(browsersOf(refOn("environment-b"))).toEqual([]);
  });

  it("keeps a browser the server opened after the thread was left in that thread", async () => {
    resetFixture();
    using _toast = vi.spyOn(toastManager, "add");
    await import("./FilesSidePanel");
    await using screen = await renderScreen(null, { router: false });
    const threadRef = refOn("environment-a");
    await renderFileFor(screen, threadRef, "index.html");
    await openInBrowser(screen);
    await settleAsset();
    expect(late.previewRequests).toBe(1);
    await renderFileFor(screen, refOn("environment-a", "thread-other"), "index.html");
    await settleSession();
    expect(readThreadPreviewState(threadRef).snapshot?.tabId).toBe("tab-1");
    expect(browsersOf(threadRef).map((surface) => surface.id)).toEqual(["browser:tab-1"]);
    expect(browsersOf(refOn("environment-a", "thread-other"))).toEqual([]);
  });

  it("keeps a late open dropped after leaving and returning to the thread", async () => {
    resetFixture();
    using _toast = vi.spyOn(toastManager, "add");
    await import("./FilesSidePanel");
    await using screen = await renderScreen(null, { router: false });
    const threadRef = refOn("environment-a");
    await renderFileFor(screen, threadRef, "index.html");
    await openInBrowser(screen);
    await renderFileFor(screen, refOn("environment-a", "thread-other"), "index.html");
    await renderFileFor(screen, threadRef, "index.html");
    await settleAsset();
    expect(late.previewRequests).toBe(0);
    expect(browsersOf(threadRef)).toEqual([]);
  });

  it("reports a browser failure in the thread that is still showing", async () => {
    resetFixture();
    using _toast = vi.spyOn(toastManager, "add");
    await import("./FilesSidePanel");
    await using screen = await renderScreen(null, { router: false });
    await renderFileFor(screen, refOn("environment-a"), "index.html");
    await openInBrowser(screen);
    await failAsset();
    expect(browserErrorToasts()).toHaveLength(1);
  });

  it("stays silent when the file fails to prepare after the thread was left", async () => {
    resetFixture();
    using _toast = vi.spyOn(toastManager, "add");
    await import("./FilesSidePanel");
    await using screen = await renderScreen(null, { router: false });
    await renderFileFor(screen, refOn("environment-a"), "index.html");
    await openInBrowser(screen);
    await renderFileFor(screen, refOn("environment-b"), "index.html");
    await failAsset();
    expect(browserErrorToasts()).toEqual([]);
  });

  it("stays silent when browser settings fail to load after the panel closed", async () => {
    resetFixture();
    using _toast = vi.spyOn(toastManager, "add");
    await import("./FilesSidePanel");
    await using screen = await renderScreen(null, { router: false });
    await renderFileFor(screen, refOn("environment-a"), "index.html");
    let rejectSettings!: (error: Error) => void;
    late.browserDefaults = new Promise((_, reject) => (rejectSettings = reject));
    await openInBrowser(screen);
    await settleAsset();
    await screen.unmount();
    await act(async () => rejectSettings(new Error("settings unreadable")));
    expect(late.previewRequests).toBe(0);
    expect(browserErrorToasts()).toEqual([]);
  });

  it("stays silent when a browser fails to open after leaving and returning", async () => {
    resetFixture();
    using _toast = vi.spyOn(toastManager, "add");
    await import("./FilesSidePanel");
    await using screen = await renderScreen(null, { router: false });
    const threadRef = refOn("environment-a");
    await renderFileFor(screen, threadRef, "index.html");
    await openInBrowser(screen);
    await settleAsset();
    await renderFileFor(screen, refOn("environment-a", "thread-other"), "index.html");
    await renderFileFor(screen, threadRef, "index.html");
    await failSession();
    expect(browserErrorToasts()).toEqual([]);
  });
});

function resetFixture() {
  late.selectTreeRows = null;
  localStorage.clear();
  siblingsByEnvironment.clear();
  composers.clear();
  late.previewRequests = 0;
  late.browserDefaults = null;
  resetPreviewStateForTests();
  siblingsByEnvironment.set("environment-a", ["src/a.ts", "src/b.ts"]);
  siblingsByEnvironment.set("environment-b", ["src/a.ts", "src/c.ts"]);
  useRightPanelStore.setState({
    byThreadKey: {},
    threadPanelVisibilityByThreadKey: {},
    userActionRevisionByThreadKey: {},
  });
}
