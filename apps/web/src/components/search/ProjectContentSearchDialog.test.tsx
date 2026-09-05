import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { AuthFilesystemReadScope, EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  canReadFiles: true,
  isCheckingAccess: false,
  error: null as string | null,
  readScope: vi.fn(),
  openFile: vi.fn(),
}));

const target = {
  environmentId: EnvironmentId.make("content-search-secondary"),
  cwd: "/project",
  projectName: "Project",
  threadRef: scopeThreadRef(
    EnvironmentId.make("content-search-secondary"),
    ThreadId.make("content-search-thread"),
  ),
};

vi.mock("~/hooks/useActiveProjectTarget", () => ({ useActiveProjectTarget: () => target }));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: { getState: () => ({ openFile: state.openFile }) },
}));
vi.mock("~/state/session", () => ({ readEnvironmentScope: state.readScope }));
vi.mock("~/state/queries", () => ({
  useProjectContentSearch: ({ query }: { query: string }) => ({
    canReadFiles: state.canReadFiles,
    isCheckingAccess: state.isCheckingAccess,
    error: state.error,
    isPending: state.isCheckingAccess,
    hasQuery: query.length > 0,
    truncated: false,
    invalidRegex: false,
    matches:
      state.canReadFiles && query.length > 0
        ? [{ path: "src/index.ts", lineNumber: 3, lineContent: "match", matchRanges: [] }]
        : [],
  }),
}));
vi.mock("../CommandPaletteContent", () => ({ CommandPaletteContent: "section" }));
vi.mock("../chat/PierreEntryIcon", () => ({ PierreEntryIcon: () => null }));
vi.mock("./HighlightedSearchLine", () => ({ HighlightedSearchLine: () => null }));
vi.mock("../ui/scroll-area", () => ({ ScrollArea: "div" }));
vi.mock("../ui/toggle", () => ({ Toggle: "button" }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: "div",
  TooltipPopup: "span",
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
}));

import { ProjectContentSearchDialog } from "./ProjectContentSearchDialog";

let renderer: ReactTestRenderer | undefined;
const onOpenChange = vi.fn();

beforeEach(() => {
  state.canReadFiles = true;
  state.isCheckingAccess = false;
  state.error = null;
  state.readScope.mockReset().mockReturnValue(true);
  state.openFile.mockClear();
  onOpenChange.mockClear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("document", { querySelector: () => null });
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

async function openSearch() {
  await act(() => {
    renderer = create(<ProjectContentSearchDialog onOpenChange={onOpenChange} />);
  });
  return renderer!.root;
}

it("enables search after access resolves and opens a result in its own environment", async () => {
  state.canReadFiles = false;
  state.isCheckingAccess = true;
  const root = await openSearch();
  expect(root.findByType("section").props.inputProps.disabled).toBe(true);
  expect(
    root.findAllByType("div").some((node) => node.children.includes("Checking file access…")),
  ).toBe(true);

  state.canReadFiles = true;
  state.isCheckingAccess = false;
  await act(() => renderer!.update(<ProjectContentSearchDialog onOpenChange={onOpenChange} />));
  expect(root.findByType("section").props.inputProps.disabled).toBe(false);
  await act(() => root.findByType("section").props.onValueChange("match"));
  await act(() => root.findByProps({ "data-content-search-result": 0 }).props.onClick());

  expect(state.readScope).toHaveBeenCalledWith(target.environmentId, AuthFilesystemReadScope);
  expect(state.openFile).toHaveBeenCalledWith(target.threadRef, "src/index.ts", 3);
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

it.each(["pointer", "keyboard"])(
  "rechecks access before a retained %s action opens a result",
  async (action) => {
    const root = await openSearch();
    await act(() => root.findByType("section").props.onValueChange("match"));
    const openResult = root.findByProps({ "data-content-search-result": 0 }).props.onClick;
    const onKeyDown = root.findByType("section").props.inputProps.onKeyDown;

    state.readScope.mockReturnValue(false);
    await act(() => {
      if (action === "pointer") openResult();
      else onKeyDown({ key: "Enter", preventDefault() {} });
    });

    expect(state.openFile).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  },
);
