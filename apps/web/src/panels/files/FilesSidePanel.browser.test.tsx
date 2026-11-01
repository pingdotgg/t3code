import { act, render as renderScreen, type Screen } from "../../../test/render";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { cloneElement, Suspense, use, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { useRightPanelStore } from "~/rightPanelStore";

const { siblingsByEnvironment, Wrapper, MenuContext, RadioContext } = await vi.hoisted(async () => {
  const { createContext: createHoistedContext } = await import("react");
  return {
    // Files in the `src` folder, per environment.
    siblingsByEnvironment: new Map<string, ReadonlyArray<string>>(),
    Wrapper: ({ children }: { children?: ReactNode }) => children,
    MenuContext: createHoistedContext<(open: boolean) => void>(() => undefined),
    RadioContext: createHoistedContext<(value: string) => void>(() => undefined),
  };
});

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
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
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
// The tree is the Pierre file tree web component; the breadcrumbs are the entry point under test.
vi.mock("~/components/files/FileBrowserPanel", () => ({ default: () => null }));
vi.mock("~/browser/browserDefaults", () => ({
  resolveBrowserDefaults: () =>
    Promise.resolve({ viewport: { _tag: "fill" }, profileId: "default" }),
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
const threadId = ThreadId.make("thread-a");
const refOn = (environmentId: string): ScopedThreadRef => ({
  environmentId: EnvironmentId.make(environmentId),
  threadId,
});

async function renderFileFor(screen: Screen, threadRef: ScopedThreadRef) {
  const host: PanelHost = {
    threadRef,
    visible: true,
    composerDraftTarget: threadRef,
    workspaceMutationId: null,
    sendAnnotation: () => undefined,
  };
  const element = (
    <PanelHostContext value={host}>
      <Suspense fallback={null}>
        <RegisteredSidePanel
          openInShortcutEnabled
          id="files"
          onNavigateFolder={() => undefined}
          folderTrail={undefined}
          cwd="/repo"
          projectName="repo"
          relativePath="src/a.ts"
          availableEditors={[]}
          revealLine={null}
          revealRequestId={0}
          onPendingChange={() => undefined}
          selectedFilePending={false}
        />
      </Suspense>
    </PanelHostContext>
  );
  await act(async () => {
    await screen.rerender(element);
  });
  await expect
    .element(screen.getByRole("navigation", { name: "File path", exact: true }))
    .toBeVisible();
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

// Transform the lazy body once up front, so mounting it settles inside one act().

describe("files side panel", () => {
  it("opens a sibling file as a tab in the host's own thread", async () => {
    resetFixture();
    await import("./FilesSidePanel");
    // PanelHostContext supplies the thread; these interactions do not use route navigation.
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
    await import("./FilesSidePanel");
    // PanelHostContext supplies the thread; these interactions do not use route navigation.
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
});

function resetFixture() {
  localStorage.clear();
  siblingsByEnvironment.clear();
  siblingsByEnvironment.set("environment-a", ["src/a.ts", "src/b.ts"]);
  siblingsByEnvironment.set("environment-b", ["src/a.ts", "src/c.ts"]);
  useRightPanelStore.setState({
    byThreadKey: {},
    threadPanelVisibilityByThreadKey: {},
    userActionRevisionByThreadKey: {},
  });
}
