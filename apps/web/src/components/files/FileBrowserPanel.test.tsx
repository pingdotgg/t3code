// @vitest-environment jsdom
import { EnvironmentId, type ProjectEntry } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type BatchOperation = { readonly type: "add" | "remove"; readonly path: string };

interface FakeRowHandle {
  isDirectory(): boolean;
  isExpanded(): boolean;
  expand(): void;
  collapse(): void;
  select(): void;
  deselect(): void;
}

class FakeFileTreeModel {
  readonly rows = new Map<string, { expanded: boolean }>();
  readonly expandCalls: string[] = [];
  private readonly listeners = new Set<() => void>();

  getItem(path: string): FakeRowHandle | null {
    const row = this.rows.get(path);
    if (!row) return null;
    return {
      isDirectory: () => path.endsWith("/"),
      isExpanded: () => row.expanded,
      expand: () => {
        this.expandCalls.push(path);
        if (!row.expanded) {
          row.expanded = true;
          this.emit();
        }
      },
      collapse: () => {
        if (row.expanded) {
          row.expanded = false;
          this.emit();
        }
      },
      select: () => {},
      deselect: () => {},
    };
  }

  resetPaths(paths: readonly string[]) {
    const next = new Map<string, { expanded: boolean }>();
    for (const path of paths) {
      next.set(path, { expanded: this.rows.get(path)?.expanded ?? false });
    }
    this.rows.clear();
    for (const [path, row] of next) this.rows.set(path, row);
  }

  batch(updates: readonly BatchOperation[]) {
    for (const update of updates) {
      if (update.type === "add") {
        if (!this.rows.has(update.path)) this.rows.set(update.path, { expanded: false });
      } else if (update.path.endsWith("/")) {
        for (const path of this.rows.keys()) {
          if (path === update.path || path.startsWith(update.path)) this.rows.delete(path);
        }
      } else {
        this.rows.delete(update.path);
      }
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }

  isSearchOpen(): boolean {
    return false;
  }

  setGitStatus(): void {}

  closeSearch(): void {}

  getSelectedPaths(): string[] {
    return [];
  }

  scrollToPath(): void {}
}

function createGate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const harness = vi.hoisted(() => ({
  model: null as FakeFileTreeModel | null,
  entries: [] as ProjectEntry[],
  loadCalls: [] as string[],
  failing: new Set<string>(),
  error: null as string | null,
  gates: new Map<string, { promise: Promise<void>; release: () => void }>(),
  onOpenFile: vi.fn<(path: string) => void>(),
  children: {
    "": [
      { path: "apps", kind: "directory" },
      { path: "README.md", kind: "file" },
    ],
    apps: [{ path: "apps/web", kind: "directory" }],
    "apps/web": [{ path: "apps/web/src", kind: "directory" }],
    "apps/web/src": [{ path: "apps/web/src/components", kind: "directory" }],
    "apps/web/src/components": [{ path: "apps/web/src/components/Button.tsx", kind: "file" }],
  } as Record<string, ProjectEntry[]>,
}));

vi.mock("@pierre/trees/react", () => ({
  useFileTree: () => ({ model: harness.model }),
  useFileTreeSearch: () => ({ value: "", close: vi.fn(), setValue: vi.fn() }),
  useFileTreeSelector: (_model: unknown, select: (model: unknown) => unknown) =>
    select(harness.model),
  FileTree: () => null,
}));

vi.mock("./useDirectoryEntries", () => {
  // Defined once so the hook returns a stable `load` across renders; otherwise
  // every test-renderer update would retrigger load effects.
  const load = async (directoryPath: string) => {
    harness.loadCalls.push(directoryPath);
    // `gated` holds a listing open so a test can act while a restore is still
    // in flight.
    const gate = harness.gates.get(directoryPath);
    if (gate) await gate.promise;
    // The real hook reports a failed listing through `error` and leaves the
    // folder's children unloaded, rather than rejecting.
    if (harness.failing.has(directoryPath)) {
      harness.error = "Unable to load folder.";
      return;
    }
    for (const entry of harness.children[directoryPath] ?? []) {
      if (!harness.entries.some((existing) => existing.path === entry.path)) {
        harness.entries.push(entry);
      }
    }
  };
  return {
    useDirectoryEntries: () => ({
      entries: harness.entries,
      load,
      refresh: () => {},
      ready: true,
      error: harness.error,
      isPending: false,
    }),
  };
});

vi.mock("~/state/queries", () => ({
  useProjectPathSearch: () => ({
    entries: [],
    isPending: false,
    error: null,
    truncated: false,
    refresh: vi.fn(),
  }),
}));

vi.mock("~/components/ui/refresh-icon", () => ({ RefreshIcon: () => null }));
vi.mock("~/components/ui/button", () => ({
  Button: ({ children, ...props }: { children?: ReactNode }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));
vi.mock("~/components/ui/input-group", () => ({
  InputGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  InputGroupInput: () => null,
}));
vi.mock("~/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render?: ReactNode }) => <>{render}</>,
  TooltipPopup: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("~/composerHandleContext", () => ({ useComposerHandleContext: () => null }));
vi.mock("~/hooks/useCopyToClipboard", () => ({ writeTextToClipboard: async () => {} }));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("~/hooks/useWorkspaceMutationRefresh", () => ({ useWorkspaceMutationRefresh: () => {} }));
vi.mock("~/fileContextMenu", () => ({
  useFileContextMenu: () => ({ buildItems: () => [], activate: async () => {} }),
}));
vi.mock("~/localApi", () => ({ readLocalApi: () => null }));
vi.mock("~/pierre-icons", () => ({ T3_PIERRE_ICONS: {} }));
vi.mock("~/pierre-tree-theme", () => ({
  PIERRE_TREE_UNSAFE_CSS: "",
  pierreTreeStyle: () => ({}),
}));
vi.mock("./fileTreeDragMention", () => ({
  createFileTreeDragMentionController: () => ({
    handleSelectionChange: () => {},
    isDragInProgress: () => false,
    handleDragStart: () => {},
    handleDragEnd: () => {},
  }),
}));
vi.mock("@t3tools/shared/composerTrigger", () => ({ serializeComposerFileLink: (p: string) => p }));
vi.mock("lucide-react", () => ({ ChevronsDownUpIcon: () => null, ChevronsUpDownIcon: () => null }));

import FileBrowserPanel from "./FileBrowserPanel";
import { fileTreeExpansionStorageKey } from "./fileTreeExpansionPersistence";

const environmentId = EnvironmentId.make("env-1");
const cwd = "/workspace";
const storageKey = fileTreeExpansionStorageKey(environmentId, cwd);

let renderer: ReactTestRenderer | null = null;

function panelElement() {
  return (
    <FileBrowserPanel
      environmentId={environmentId}
      cwd={cwd}
      projectName="repo"
      selectedPath={null}
      selectedPathRevealId={0}
      onOpenFile={harness.onOpenFile}
      workspaceMutationId={null}
    />
  );
}

async function settle(rounds = 5) {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      renderer?.update(panelElement());
    });
  }
}

function isExpanded(path: string): boolean {
  return harness.model?.getItem(path)?.isExpanded() ?? false;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear();
  harness.model = new FakeFileTreeModel();
  harness.entries.length = 0;
  harness.entries.push(...harness.children[""]!);
  harness.loadCalls = [];
  harness.gates.clear();
  harness.failing.clear();
  harness.error = null;
  harness.onOpenFile.mockReset();
  renderer = null;
});

afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("FileBrowserPanel expansion persistence", () => {
  it("restores a stored deep path parent-before-child on mount", async () => {
    window.localStorage.setItem(storageKey, JSON.stringify(["apps/", "apps/web/"]));
    await act(async () => {
      renderer = create(panelElement());
    });
    await settle();

    expect(harness.loadCalls).toEqual(["", "apps", "apps/web"]);
    expect(isExpanded("apps/")).toBe(true);
    expect(isExpanded("apps/web/")).toBe(true);
  });

  it("keeps restored folders expanded across a remount", async () => {
    window.localStorage.setItem(storageKey, JSON.stringify(["apps/", "apps/web/"]));
    await act(async () => {
      renderer = create(panelElement());
    });
    await settle();
    expect(isExpanded("apps/web/")).toBe(true);

    await act(async () => renderer?.unmount());
    renderer = null;
    harness.model = new FakeFileTreeModel();
    harness.entries.length = 0;
    harness.entries.push(...harness.children[""]!);
    harness.loadCalls = [];
    await act(async () => {
      renderer = create(panelElement());
    });
    await settle();

    expect(isExpanded("apps/")).toBe(true);
    expect(isExpanded("apps/web/")).toBe(true);
  });

  it("writes expansion to storage on toggle so a remount restores it", async () => {
    await act(async () => {
      renderer = create(panelElement());
    });
    await settle();

    await act(async () => {
      harness.model?.getItem("apps/")?.expand();
    });
    await settle();
    expect(JSON.parse(window.localStorage.getItem(storageKey) ?? "null")).toEqual(["apps/"]);

    await act(async () => renderer?.unmount());
    renderer = null;
    harness.model = new FakeFileTreeModel();
    harness.entries.length = 0;
    harness.entries.push(...harness.children[""]!);
    harness.loadCalls = [];
    await act(async () => {
      renderer = create(panelElement());
    });
    await settle();

    expect(isExpanded("apps/")).toBe(true);
  });

  it("removes a collapsed folder from storage", async () => {
    window.localStorage.setItem(storageKey, JSON.stringify(["apps/"]));
    await act(async () => {
      renderer = create(panelElement());
    });
    await settle();
    expect(isExpanded("apps/")).toBe(true);

    await act(async () => {
      harness.model?.getItem("apps/")?.collapse();
    });
    await settle();
    expect(JSON.parse(window.localStorage.getItem(storageKey) ?? "null")).toEqual([]);
  });

  it("keeps a folder the user collapses while the restore is still loading", async () => {
    // "apps/web" never finishes loading, so the restore stays in flight while
    // the user closes "apps/" again.
    const gate = createGate();
    harness.gates.set("apps/web", gate);
    window.localStorage.setItem(storageKey, JSON.stringify(["apps/", "apps/web/"]));
    await act(async () => {
      renderer = create(panelElement());
    });
    await settle();
    expect(isExpanded("apps/")).toBe(true);

    await act(async () => {
      harness.model?.getItem("apps/")?.collapse();
    });
    await settle();
    expect(isExpanded("apps/")).toBe(false);

    await act(async () => {
      gate.release();
    });
    await settle();

    // A later restore pass must not reopen what the user just closed, while the
    // folder that finished loading still restores.
    expect(isExpanded("apps/")).toBe(false);
    expect(JSON.parse(window.localStorage.getItem(storageKey) ?? "null")).toEqual(["apps/web/"]);
    expect(isExpanded("apps/web/")).toBe(true);
  });

  it("prunes stored paths that no longer exist", async () => {
    window.localStorage.setItem(storageKey, JSON.stringify(["apps/", "gone/"]));
    await act(async () => {
      renderer = create(panelElement());
    });
    await settle();

    expect(harness.loadCalls).toContain("gone");
    expect(isExpanded("apps/")).toBe(true);
    expect(JSON.parse(window.localStorage.getItem(storageKey) ?? "null")).toEqual(["apps/"]);
  });

  it("keeps stored folders whose listing failed to load", async () => {
    // A transient read failure leaves "apps/web/" unrestored. Treating that as
    // "the folder is gone" would erase expansion the user still has.
    harness.failing.add("apps");
    window.localStorage.setItem(storageKey, JSON.stringify(["apps/", "apps/web/"]));
    await act(async () => {
      renderer = create(panelElement());
    });
    await settle();

    expect(isExpanded("apps/")).toBe(true);
    expect(isExpanded("apps/web/")).toBe(false);
    expect(JSON.parse(window.localStorage.getItem(storageKey) ?? "null")).toEqual([
      "apps/",
      "apps/web/",
    ]);
  });

  it("stays closed when storage is empty", async () => {
    await act(async () => {
      renderer = create(panelElement());
    });
    await settle();

    expect(harness.loadCalls).toEqual([]);
    expect(harness.model?.expandCalls).toEqual([]);
  });
});
