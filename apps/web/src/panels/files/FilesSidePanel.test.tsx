import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { act, cloneElement, Suspense, use, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
  useEnvironmentHttpBaseUrl: () => null,
  usePrimaryEnvironmentId: () => null,
}));
vi.mock("~/remoteOpen", () => ({ useRemoteOpenState: () => ({ mode: "local-exec" }) }));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: (select: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    select(DEFAULT_CLIENT_SETTINGS),
  useUpdateClientSettings: () => vi.fn(),
}));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
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
// The tree is the Pierre file tree web component; the breadcrumbs are the entry point under test.
vi.mock("~/components/files/FileBrowserPanel", () => ({ default: () => null }));
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
const threadId = ThreadId.make("thread-a");
const refOn = (environmentId: string): ScopedThreadRef => ({
  environmentId: EnvironmentId.make(environmentId),
  threadId,
});
let renderer: ReactTestRenderer | undefined;

async function renderFileFor(threadRef: ScopedThreadRef) {
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
          id="files"
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

// Transform the lazy body once up front, so mounting it settles inside one act().
beforeAll(() => import("./FilesSidePanel"), 30_000);
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const storage = new Map<string, string>();
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  });
  siblingsByEnvironment.clear();
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
});
