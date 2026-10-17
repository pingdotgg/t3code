import { EnvironmentId, type ProjectEntry } from "@t3tools/contracts";
import type { FileTree as FileTreeModel } from "@pierre/trees";
import { FileTree } from "@pierre/trees/react";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const entries: ProjectEntry[] = [{ path: "README.md", kind: "file" }];

vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("~/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipPopup: () => null,
}));
vi.mock("~/fileContextMenu", () => ({
  useFileContextMenu: () => ({ buildItems: () => [], activate: vi.fn() }),
}));
vi.mock("~/state/queries", () => ({
  useProjectPathSearch: () => ({
    entries: [],
    error: null,
    isPending: false,
    truncated: false,
    refresh: vi.fn(),
  }),
}));
vi.mock("./useDirectoryEntries", () => ({
  useDirectoryEntries: () => ({
    entries,
    load: () => Promise.resolve(),
    refresh: vi.fn(),
    ready: true,
    error: null,
    isPending: false,
    loadingDirectories: new Set(),
  }),
}));

import FileBrowserPanel from "./FileBrowserPanel";

describe("FileBrowserPanel tree selection", () => {
  let renderer: ReactTestRenderer | undefined;

  function Panel({ onOpenFile }: { onOpenFile: (relativePath: string) => void }) {
    return (
      <FileBrowserPanel
        environmentId={EnvironmentId.make("environment-local")}
        cwd="/workspace"
        projectName="workspace"
        selectedPath={null}
        selectedPathRevealId={0}
        onOpenFile={onOpenFile}
        workspaceMutationId={null}
      />
    );
  }

  const model = (): FileTreeModel => renderer!.root.findByType(FileTree).props.model;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  });

  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("opens a clicked file in the thread the panel shows now", async () => {
    // Threads in one workspace share this panel; switching threads only swaps the opener.
    const openInFirstThread = vi.fn();
    const openInSecondThread = vi.fn();
    await act(async () => {
      renderer = create(<Panel onOpenFile={openInFirstThread} />);
    });
    await act(async () => {
      renderer!.update(<Panel onOpenFile={openInSecondThread} />);
    });

    await act(async () => model().getItem("README.md")!.select());

    expect(openInFirstThread).not.toHaveBeenCalled();
    expect(openInSecondThread).toHaveBeenCalledWith("README.md");
  });
});
