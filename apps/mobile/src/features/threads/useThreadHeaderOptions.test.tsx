// @vitest-environment jsdom
import type { VcsStatusResult } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

// Native header item factories are only read when options are applied, so the fake
// navigation snapshots the right items at each setOptions, as native-stack does.
const harness = vi.hoisted(() => ({
  setOptionsCalls: 0,
  renderedRightItems: [] as Array<ReadonlyArray<Record<string, unknown>>>,
  navigatedRoutes: [] as string[],
}));

vi.mock("@react-navigation/native", () => {
  const navigation = {
    canGoBack: () => true,
    dispatch: () => {},
    goBack: () => {},
    navigate: (route: string) => {
      harness.navigatedRoutes.push(route);
    },
    addListener: () => () => {},
    setOptions: (options: { unstable_headerRightItems?: () => Array<Record<string, unknown>> }) => {
      harness.setOptionsCalls += 1;
      harness.renderedRightItems.push(options.unstable_headerRightItems?.() ?? []);
    },
  };
  return {
    StackActions: { replace: () => ({}) },
    useNavigation: () => navigation,
  };
});
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("react-native", () => ({ Alert: { alert: () => {} }, Linking: {}, Platform: {} }));
vi.mock("../layout/AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspaceLayout: () => ({
    layout: { usesSplitView: false },
    panes: { primarySidebarVisible: false, auxiliaryPaneVisible: false },
    togglePrimarySidebar: () => {},
    toggleAuxiliaryPane: () => {},
  }),
}));
vi.mock("../layout/native-mail-search-toolbar", () => ({
  NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED: true,
  createNativeMailSearchToolbarItem: () => ({}),
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeVariables: {} }),
}));

import { ThreadHeader } from "./ThreadHeader";

const projectScripts: never[] = [];

function status(
  files: ReadonlyArray<string>,
  overrides: Partial<VcsStatusResult> = {},
): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: false,
    isDefaultRef: true,
    refName: "master",
    hasWorkingTreeChanges: files.length > 0,
    workingTree: {
      files: files.map((path) => ({ path, insertions: 0, deletions: 0 })),
      insertions: 0,
      deletions: 0,
    },
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  } as unknown as VcsStatusResult;
}

// Mirrors the route screen: every render passes fresh gitControls callbacks.
function Header(props: { readonly gitStatus: VcsStatusResult | null; readonly title?: string }) {
  return (
    <ThreadHeader
      title={props.title ?? "Thread"}
      subtitle=""
      headerColor="#000"
      usesNativeHeaderGlass
      gitControls={{
        environmentId: "environment-1",
        threadId: "thread-1",
        currentBranch: "master",
        gitStatus: props.gitStatus,
        gitOperationLabel: null,
        onPull: async () => {},
        onRunAction: async () => null,
        canOpenTerminal: true,
        canOperateTerminal: true,
        canOpenFiles: true,
        projectScripts,
        terminalSessions: [],
        onOpenTerminal: () => {},
        onOpenNewTerminal: () => {},
        onRunProjectScript: async () => {},
      }}
      hasThreadCwd
      hasWorkspaceRoot
      fileInspectorSupported={false}
      inspectorMode={null}
      onToggleInspector={() => {}}
      onOpenGitInspector={() => {}}
      onOpenFilesInspector={() => {}}
    />
  );
}

function renderedGitMenuItems(): Array<{
  description?: unknown;
  label?: unknown;
  onPress?: () => void;
}> {
  const items = harness.renderedRightItems.at(-1) ?? [];
  const git = items.find((item) => item.identifier === "thread-right-git") as
    | { menu: { items: Array<{ description?: unknown; label?: unknown; onPress?: () => void }> } }
    | undefined;
  return git?.menu.items ?? [];
}

function renderedGitStatusDescription(): unknown {
  return renderedGitMenuItems()[0]?.description;
}

let root: Root | null = null;

function render(element: React.ReactElement) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root ??= createRoot(document.createElement("div"));
  act(() => root!.render(element));
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  harness.setOptionsCalls = 0;
  harness.renderedRightItems = [];
  harness.navigatedRoutes = [];
});

describe("ThreadHeader", () => {
  it("re-applies native header items when Git status changes", () => {
    render(<Header gitStatus={status([])} />);
    expect(renderedGitStatusDescription()).toBe("Clean");

    // A refreshed status (e.g. after reconnect) must reach the Git popover even
    // though nothing else in the header changed.
    render(<Header gitStatus={status(["audit.txt"])} />);
    expect(renderedGitStatusDescription()).toBe("1 changed");

    render(<Header gitStatus={status([])} />);
    expect(renderedGitStatusDescription()).toBe("Clean");
  });

  it("does not re-apply options for re-renders with equivalent header content", () => {
    render(<Header gitStatus={status([])} />);
    const applied = harness.setOptionsCalls;

    // Streaming re-renders the route with fresh callbacks and equal Git content.
    for (let index = 0; index < 20; index += 1) {
      render(<Header gitStatus={status([])} />);
    }
    expect(harness.setOptionsCalls).toBe(applied);
  });

  it("re-applies menu actions when the default ref changes behind the same label", async () => {
    // An unpushed commit on a branch with an open PR shows "Push" whether or not the
    // branch is the default one, but only the default branch asks for confirmation.
    const pushable = (isDefaultRef: boolean) =>
      status([], {
        isDefaultRef,
        aheadCount: 1,
        hasPrimaryRemote: true,
        pr: { state: "open", url: "https://example.com/pr/1" },
      } as Partial<VcsStatusResult>);
    render(<Header gitStatus={pushable(false)} />);
    expect(renderedGitMenuItems()[1]?.label).toBe("Push");

    render(<Header gitStatus={pushable(true)} />);
    expect(renderedGitMenuItems()[1]?.label).toBe("Push");
    await act(async () => renderedGitMenuItems()[1]?.onPress?.());
    expect(harness.navigatedRoutes).toEqual(["GitConfirm"]);
  });
});
