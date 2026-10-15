import type { CodeViewScrollTarget } from "@pierre/diffs";
import type { FileTree as FileTreeModel } from "@pierre/trees";
import { FileTree } from "@pierre/trees/react";
import { act, type ComponentProps, type MouseEvent, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { FileDiffMetadata } from "@pierre/diffs";

import { DiffFileTree, type DiffFileTreeEntry } from "./DiffFileTree";
import { diffFileTreeEntries } from "./diffFileTree.logic";
import { useCodeViewFileReveal } from "./useCodeViewFileReveal";

vi.mock("../../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
// Tooltip positioning is unrelated to the tree's actual model and activation path.
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipPopup: () => null,
}));
vi.mock("../ui/menu", () => ({
  Menu: ({ children }: { children: ReactNode }) => children,
  MenuPopup: ({ children }: { children: ReactNode }) => children,
  MenuItem: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => (
    <button role="menuitem" onClick={onClick}>
      {children}
    </button>
  ),
}));

const entries: DiffFileTreeEntry[] = [
  { path: "01-tall.ts", status: "modified" },
  { path: "02-short.ts", status: "modified" },
  { path: "03-medium.ts", status: "modified" },
];

class TreeRow {
  constructor(readonly path: string) {}

  getAttribute(name: string) {
    return name === "data-item-path" ? this.path : null;
  }
}

describe("diff tree file activation", () => {
  let renderer: ReactTestRenderer | undefined;
  const targets: CodeViewScrollTarget[] = [];
  const viewer = {
    getInstance: () => viewer,
    scrollTo: (target: CodeViewScrollTarget) => targets.push(target),
  };

  function Panel({
    files = entries,
    selectedPath = null,
    reviewEntries,
    onReviewFiles,
  }: {
    files?: DiffFileTreeEntry[];
    selectedPath?: string | null;
    reviewEntries?: ReadonlyArray<DiffFileTreeEntry>;
    onReviewFiles?: ComponentProps<typeof DiffFileTree>["onReviewFiles"];
  }) {
    const reveal = useCodeViewFileReveal(viewer, "working-tree");
    return (
      <DiffFileTree
        entries={files}
        ariaLabel="Working tree files"
        selectedPath={selectedPath}
        onSelectFile={(path) => reveal(`${path}\0${path}`)}
        {...(reviewEntries === undefined ? {} : { reviewEntries })}
        onReviewFiles={onReviewFiles}
      />
    );
  }

  const model = (): FileTreeModel => renderer!.root.findByType(FileTree).props.model;

  async function mount(props: Parameters<typeof Panel>[0] = {}) {
    await act(async () => {
      renderer = create(<Panel {...props} />);
    });
  }

  async function openReviewMenu(path: string) {
    const tree = model();
    const item = tree.getItem(path)!;
    await act(async () => {
      tree.getComposition()?.contextMenu?.onOpen?.(
        { kind: item.isDirectory() ? "directory" : "file", name: path, path },
        {
          anchorElement: new TreeRow(path) as unknown as HTMLElement,
          anchorRect: {
            x: 20,
            y: 30,
            top: 30,
            bottom: 30,
            left: 20,
            right: 20,
            width: 0,
            height: 0,
          },
          close: () => tree.getComposition()?.contextMenu?.onClose?.(),
          restoreFocus: () => {},
        },
      );
    });
  }

  const menuItem = (label: string) =>
    renderer!.root
      .findAllByProps({ role: "menuitem" })
      .find((node) => node.children.includes(label));

  async function chooseReviewAction(label: string) {
    await act(async () => menuItem(label)!.props.onClick());
  }

  // Exercise T3's capture handler before the real Pierre model's selection transition.
  // Only DOM hit testing is represented here; native pointer/keyboard dispatch and diff
  // geometry are verified separately in the integrated client.
  async function activate(path: string, modifiers: Partial<MouseEvent<HTMLElement>> = {}) {
    const event = {
      button: 0,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      defaultPrevented: false,
      nativeEvent: { composedPath: () => [{}, new TreeRow(path), {}] },
      ...modifiers,
    } as MouseEvent<HTMLElement>;
    await act(async () => {
      renderer!.root
        .find((node) => String(node.type) === "file-tree-container")
        .props.onClickCapture?.(event);
      const tree = model();
      const item = tree.getItem(path)!;
      if (event.ctrlKey || event.metaKey) {
        item.toggleSelect();
      } else {
        for (const selected of tree.getSelectedPaths()) {
          if (selected !== path) tree.getItem(selected)?.deselect();
        }
        item.select();
      }
      item.focus();
      if ("toggle" in item && !event.ctrlKey && !event.metaKey && !event.shiftKey) item.toggle();
    });
  }

  beforeEach(() => {
    targets.length = 0;
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("HTMLElement", TreeRow);
  });

  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("mounts a file-to-symlink type change as one tree row", async () => {
    // Git carries a type change as a deletion and an addition of the same path.
    const typeChange = diffFileTreeEntries([
      { type: "deleted", name: "AGENTS.md", prevName: "AGENTS.md" } as FileDiffMetadata,
      { type: "new", name: "AGENTS.md", prevName: "AGENTS.md" } as FileDiffMetadata,
      { type: "change", name: "CLAUDE.md", prevName: "CLAUDE.md" } as FileDiffMetadata,
    ]);
    await mount({ files: [...typeChange] });

    const tree = model();
    expect(tree.getItem("AGENTS.md")?.isDirectory()).toBe(false);
    expect(tree.getItem("CLAUDE.md")?.isDirectory()).toBe(false);
    await activate("AGENTS.md");
    expect(targets).toEqual([{ type: "item", id: "AGENTS.md\u0000AGENTS.md", align: "start" }]);
  });

  it("reissues the reveal when the sole selected file is activated again", async () => {
    await mount();
    await activate("02-short.ts");
    expect(model().getSelectedPaths()).toEqual(["02-short.ts"]);
    await activate("02-short.ts");
    expect(targets).toEqual([
      { type: "item", id: "02-short.ts\u000002-short.ts", align: "start" },
      { type: "item", id: "02-short.ts\u000002-short.ts", align: "start" },
    ]);
  });

  it("reveals newly selected files once in either direction", async () => {
    await mount();
    await activate("02-short.ts");
    await activate("01-tall.ts");
    await activate("03-medium.ts");
    expect(targets.map((target) => ("id" in target ? target.id : null))).toEqual(
      ["02-short.ts", "01-tall.ts", "03-medium.ts"].map((path) => `${path}\0${path}`),
    );
  });

  it("keeps focus-only navigation separate from button activation", async () => {
    await mount();
    await activate("02-short.ts");
    await act(async () => model().getItem("01-tall.ts")!.focus());
    expect(model().getSelectedPaths()).toEqual(["02-short.ts"]);
    expect(targets).toHaveLength(1);
    await activate("01-tall.ts", { detail: 0 });
    await activate("01-tall.ts", { detail: 0 });
    expect(targets).toHaveLength(3);
  });

  it.each(["ctrlKey", "metaKey"] as const)(
    "does not reveal a selected file that a %s click deselects",
    async (modifier) => {
      await mount();
      await activate("02-short.ts");
      await activate("02-short.ts", { [modifier]: true });
      expect(model().getSelectedPaths()).toEqual([]);
      expect(targets).toHaveLength(1);
    },
  );

  it("lets a click narrow multiple selected files without a second reveal", async () => {
    await mount();
    await activate("02-short.ts");
    await act(async () => model().getItem("01-tall.ts")!.select());
    expect(model().getSelectedPaths()).toHaveLength(2);
    targets.length = 0;
    await activate("02-short.ts");
    expect(model().getSelectedPaths()).toEqual(["02-short.ts"]);
    expect(targets).toHaveLength(1);
  });

  it("leaves directory selection and expansion to the tree", async () => {
    await mount({ files: [{ path: "src/app.ts", status: "modified" }] });
    const directory = model().getItem("src/")!;
    if (!("isExpanded" in directory)) throw new Error("Expected the directory handle");
    expect(directory.isExpanded()).toBe(true);
    await activate("src/");
    expect(directory.isExpanded()).toBe(false);
    await activate("src/");
    expect(directory.isExpanded()).toBe(true);
    expect(targets).toEqual([]);
  });

  it("reorders refreshed files without reopening a collapsed folder", async () => {
    const files: DiffFileTreeEntry[] = [
      { path: "src/state/shell.ts", status: "modified" },
      { path: "src/features/route.ts", status: "added" },
    ];
    await mount({ files });
    const initialFolder = model().getItem("src/features/")!;
    if (!("collapse" in initialFolder)) throw new Error("Expected the directory handle");
    await act(async () => initialFolder.collapse());
    await act(async () => {
      renderer!.update(<Panel files={[files[1]!, files[0]!]} />);
    });
    const folder = model().getItem("src/features/")!;
    if (!("isExpanded" in folder)) throw new Error("Expected the directory handle");
    expect(folder.isExpanded()).toBe(false);
  });

  it("does not echo controlled selection, but lets the reader activate it", async () => {
    await mount({ selectedPath: "02-short.ts" });
    expect(model().getSelectedPaths()).toEqual(["02-short.ts"]);
    expect(targets).toEqual([]);
    await activate("02-short.ts");
    expect(targets).toHaveLength(1);
    await act(async () => {
      renderer!.update(<Panel selectedPath="03-medium.ts" />);
    });
    expect(model().getSelectedPaths()).toEqual(["03-medium.ts"]);
    expect(targets).toHaveLength(1);
  });

  it("marks a file reviewed and offers the reverse action after its state updates", async () => {
    const onReviewFiles = vi.fn();
    await mount({ onReviewFiles });
    await openReviewMenu("02-short.ts");
    expect(menuItem("Mark as unreviewed")).toBeUndefined();
    await chooseReviewAction("Mark as reviewed");
    expect(onReviewFiles).toHaveBeenCalledWith(["02-short.ts"], true);
    expect(targets).toEqual([]);

    await act(async () => {
      renderer!.update(
        <Panel
          files={entries.map((entry) => ({ ...entry, reviewed: entry.path === "02-short.ts" }))}
          onReviewFiles={onReviewFiles}
        />,
      );
    });
    await openReviewMenu("02-short.ts");
    expect(menuItem("Mark as reviewed")).toBeUndefined();
    await chooseReviewAction("Mark as unreviewed");
    expect(onReviewFiles).toHaveBeenLastCalledWith(["02-short.ts"], false);
  });

  it("reviews selected files and a collapsed folder once, including filtered descendants", async () => {
    const files: DiffFileTreeEntry[] = [
      { path: "src/lib/a.ts", status: "modified" },
      { path: "src/library/neighbor.ts", status: "modified" },
      { path: "README.md", status: "modified" },
    ];
    const onReviewFiles = vi.fn();
    await mount({
      files,
      onReviewFiles,
      reviewEntries: [...files, { path: "src/lib/hidden.ts", status: "modified", reviewed: true }],
    });
    await act(async () => {
      const folder = model().getItem("src/lib/")!;
      folder.select();
      if ("collapse" in folder) folder.collapse();
      model().getItem("src/lib/a.ts")!.select();
      model().getItem("README.md")!.select();
    });
    await openReviewMenu("src/lib/");
    expect(menuItem("Mark as reviewed")).toBeDefined();
    expect(menuItem("Mark as unreviewed")).toBeDefined();
    await chooseReviewAction("Mark as unreviewed");
    expect(onReviewFiles).toHaveBeenCalledWith(
      ["src/lib/a.ts", "README.md", "src/lib/hidden.ts"],
      false,
    );
  });

  it("keeps the batch when opening a selected folder's child menu", async () => {
    const onReviewFiles = vi.fn();
    await mount({
      files: [
        { path: "src/a.ts", status: "modified" },
        { path: "src/b.ts", status: "modified" },
        { path: "README.md", status: "modified" },
      ],
      onReviewFiles,
    });
    await act(async () => {
      model().getItem("src/")!.select();
      model().getItem("README.md")!.select();
    });
    await openReviewMenu("src/a.ts");
    await chooseReviewAction("Mark as reviewed");
    expect(onReviewFiles).toHaveBeenCalledWith(["src/a.ts", "src/b.ts", "README.md"], true);
  });

  it("targets a right-clicked unselected file without reviewing unrelated selected files", async () => {
    const onReviewFiles = vi.fn();
    await mount({ onReviewFiles });
    await act(async () => {
      model().getItem("01-tall.ts")!.select();
      model().getItem("03-medium.ts")!.select();
    });
    await openReviewMenu("02-short.ts");
    await chooseReviewAction("Mark as reviewed");
    expect(onReviewFiles).toHaveBeenCalledWith(["02-short.ts"], true);
  });
});
