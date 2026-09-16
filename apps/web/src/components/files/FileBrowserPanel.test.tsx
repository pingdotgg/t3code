import type { FileTree as FileTreeModel } from "@pierre/trees";
import { FileTree } from "@pierre/trees/react";
import { EnvironmentId, type ProjectEntry } from "@t3tools/contracts";
import { act, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import FileBrowserPanel from "./FileBrowserPanel";

const { loads } = vi.hoisted(() => ({ loads: vi.fn() }));
const folders: Record<string, readonly ProjectEntry[]> = {
  "": [
    { path: "apps", kind: "directory" },
    { path: "docs", kind: "directory" },
  ],
  apps: [{ path: "apps/web", kind: "directory" }],
  "apps/web": [{ path: "apps/web/src", kind: "directory" }],
  "apps/web/src": [{ path: "apps/web/src/index.ts", kind: "file" }],
  docs: [{ path: "docs/readme.md", kind: "file" }],
};

vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("~/composerHandleContext", () => ({ useComposerHandleContext: () => null }));
vi.mock("~/hooks/useWorkspaceMutationRefresh", () => ({ useWorkspaceMutationRefresh: () => {} }));
vi.mock("~/localApi", () => ({ readLocalApi: () => null }));
vi.mock("~/hooks/useCopyToClipboard", () => ({ writeTextToClipboard: vi.fn() }));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("~/state/queries", () => ({
  useProjectPathSearch: () => ({ entries: [], isPending: false }),
}));
vi.mock("~/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipPopup: () => null,
}));
vi.mock("./useDirectoryEntries", () => ({
  useDirectoryEntries: () => {
    const [directories, setDirectories] = useState(new Map<string, readonly ProjectEntry[]>());
    const load = useCallback(async (path: string) => {
      await loads(path);
      setDirectories((current) =>
        current.has(path) ? current : new Map(current).set(path, folders[path] ?? []),
      );
    }, []);
    useEffect(() => {
      void load("");
    }, [load]);
    return {
      entries: useMemo(() => [...directories.values()].flat(), [directories]),
      loadedDirectories: useMemo(() => new Set(directories.keys()), [directories]),
      load,
      refresh: () => {},
      ready: directories.has(""),
      error: null,
      isPending: false,
    };
  },
}));

let renderer: ReactTestRenderer | undefined;
const storage = new Map<string, string>();
const model = (): FileTreeModel => renderer!.root.findByType(FileTree).props.model;
const expanded = (path: string) => {
  const item = model().getItem(path);
  return item && "isExpanded" in item && item.isExpanded();
};
async function mount(cwd = "/repo", selectedPath: string | null = null) {
  await act(async () => {
    renderer = create(
      <FileBrowserPanel
        environmentId={EnvironmentId.make("test")}
        cwd={cwd}
        projectName="Test"
        selectedPath={selectedPath}
        selectedPathRevealId={0}
        onOpenFile={() => {}}
        workspaceMutationId={null}
      />,
    );
  });
}
async function unmount() {
  await act(async () => renderer?.unmount());
  renderer = undefined;
}
async function toggle(path: string) {
  await act(async () => {
    const item = model().getItem(path);
    if (item && "toggle" in item) item.toggle();
  });
}
beforeEach(() => {
  storage.clear();
  loads.mockReset();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("document", { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal("window", {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  });
});
afterEach(async () => {
  await unmount();
  vi.unstubAllGlobals();
});

it("restores deep folders and siblings after remount, and remembers a collapse", async () => {
  await mount();
  expect(expanded("apps/")).toBe(false);
  for (const path of ["apps/", "apps/web/", "apps/web/src/", "docs/"]) await toggle(path);
  await unmount();
  loads.mockClear();
  await mount();
  for (const path of ["apps/", "apps/web/", "apps/web/src/", "docs/"])
    expect(expanded(path)).toBe(true);
  expect(loads.mock.calls.map(([path]) => path)).toEqual(
    expect.arrayContaining(["apps", "apps/web", "apps/web/src", "docs"]),
  );
  await toggle("docs/");
  await unmount();
  await mount();
  expect(expanded("docs/")).toBe(false);
  expect(expanded("apps/web/src/")).toBe(true);
  await unmount();
  await mount("/other");
  expect(expanded("apps/")).toBe(false);
});

it("still reveals a selected file with empty storage", async () => {
  await mount("/repo", "apps/web/src/index.ts");
  expect(expanded("apps/web/src/")).toBe(true);
  expect(model().getSelectedPaths()).toContain("apps/web/src/index.ts");
});

it.each(["not json", '{"unexpected":true}'])("ignores malformed storage: %s", async (value) => {
  storage.set('t3code.fileTreeExpansion:["test","/repo"]', value);
  await mount();
  expect(expanded("apps/")).toBe(false);
});

it("skips deleted paths without requesting missing directories", async () => {
  storage.set(
    't3code.fileTreeExpansion:["test","/repo"]',
    JSON.stringify(["apps/", "apps/web/", "apps/deleted/", "apps/deleted/deep/", "gone/"]),
  );
  await mount();
  expect(expanded("apps/web/")).toBe(true);
  expect(loads.mock.calls.map(([path]) => path)).not.toContain("apps/deleted");
  expect(loads.mock.calls.map(([path]) => path)).not.toContain("gone");
  expect(JSON.parse(storage.get('t3code.fileTreeExpansion:["test","/repo"]')!)).toEqual([
    "apps/",
    "apps/web/",
  ]);
});

it("persists collapse all and does not persist temporary search expansion", async () => {
  await mount();
  await toggle("apps/");
  await act(async () => {
    model().openSearch("docs");
  });
  await act(async () => {
    model().closeSearch();
  });
  await act(async () => {
    renderer!.root.findByProps({ "aria-label": "Expand all folders" }).props.onClick();
  });
  await act(async () => {
    renderer!.root.findByProps({ "aria-label": "Collapse all folders" }).props.onClick();
  });
  await unmount();
  await mount();
  expect(expanded("apps/")).toBe(false);
  expect(expanded("docs/")).toBe(false);
});

it("cancels pending restoration when collapse all is pressed", async () => {
  storage.set(
    't3code.fileTreeExpansion:["test","/repo"]',
    JSON.stringify(["apps/", "apps/web/", "docs/"]),
  );
  let complete!: () => void;
  const pending = new Promise<void>((resolve) => {
    complete = resolve;
  });
  loads.mockImplementation((path: string) => (path === "apps" ? pending : undefined));
  await mount();
  await act(async () => {
    renderer!.root.findByProps({ "aria-label": "Collapse all folders" }).props.onClick();
  });
  await act(async () => complete());
  expect(expanded("apps/")).toBe(false);
  expect(expanded("apps/web/")).toBe(false);
});
