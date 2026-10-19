import "../../index.css";

import { EnvironmentId, type ProjectEntry } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import FileBrowserPanel from "./FileBrowserPanel";

const files = vi.hoisted(() => ({
  directoryEntries: [] as ProjectEntry[],
  directoryReady: true,
  directoryPending: false,
  searchEntries: [] as ProjectEntry[],
  searchPending: false,
  searchError: null as string | null,
  loadingDirectories: new Set<string>() as ReadonlySet<string>,
  load: vi.fn(async () => {}),
  refresh: vi.fn(),
}));

vi.mock("./useDirectoryEntries", () => ({
  useDirectoryEntries: () => ({
    entries: files.directoryEntries,
    loadingDirectories: files.loadingDirectories,
    load: files.load,
    refresh: files.refresh,
    ready: files.directoryReady,
    error: null,
    isPending: files.directoryPending,
  }),
}));
vi.mock("~/state/queries", () => ({
  useProjectPathSearch: () => ({
    entries: files.searchEntries,
    isPending: files.searchPending,
    error: files.searchError,
    truncated: false,
    refresh: files.refresh,
  }),
}));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("~/hooks/useWorkspaceMutationRefresh", () => ({ useWorkspaceMutationRefresh: vi.fn() }));
vi.mock("~/composerHandleContext", () => ({ useComposerHandleContext: () => null }));
vi.mock("~/fileContextMenu", () => ({ useFileContextMenu: () => ({}) }));
vi.mock("~/localApi", () => ({ readLocalApi: () => undefined }));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("~/components/MorphIcon", () => ({ MorphIcon: () => null }));
vi.mock("~/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipPopup: () => null,
}));

describe("Files panel search", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  const props = {
    environmentId: EnvironmentId.make("test-environment"),
    cwd: "/workspace",
    projectName: "Test project",
    selectedPath: null,
    selectedPathRevealId: 0,
    onOpenFile: vi.fn(),
    workspaceMutationId: null,
  };

  async function render() {
    if (!container) {
      container = document.body.appendChild(document.createElement("div"));
      // The tree virtualizes its rows, so it needs a real viewport to render any.
      container.style.cssText =
        "display: flex; flex-direction: column; width: 320px; height: 480px;";
      root = createRoot(container);
    }
    await act(async () => root!.render(<FileBrowserPanel {...props} />));
  }

  function searchInput() {
    const input = container!.querySelector<HTMLInputElement>('input[type="search"]');
    expect(input).not.toBeNull();
    return input!;
  }

  async function search(value: string) {
    const input = searchInput();
    // React tracks the last value it saw on the element, so set it through the native setter.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    await act(async () => {
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function visiblePaths() {
    const tree = container!.querySelector("file-tree-container");
    if (!tree) return [];
    return [...tree.shadowRoot!.querySelectorAll("[data-item-path]")].map((row) =>
      row.getAttribute("data-item-path"),
    );
  }

  function hasMessage(message: string) {
    return [...container!.querySelectorAll("div")].some(
      (node) => node.childNodes.length === 1 && node.textContent === message,
    );
  }

  function expectVisibleLoadingStatus() {
    const status = container!.querySelector<HTMLElement>('[role="status"]');
    expect(status?.textContent).toBe("Loading files…");
    expect(status!.checkVisibility()).toBe(true);
    const bounds = status!.getBoundingClientRect();
    expect(bounds.width).toBeGreaterThan(1);
    expect(bounds.height).toBeGreaterThan(1);
  }

  function rowTop(path: string) {
    const row = container!
      .querySelector("file-tree-container")
      ?.shadowRoot!.querySelector(`[data-item-path="${CSS.escape(path)}"]`);
    expect(row, `visible row ${path}`).not.toBeNull();
    const bounds = row!.getBoundingClientRect();
    expect(bounds.height).toBeGreaterThan(0);
    return bounds.top;
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    files.directoryEntries = [
      { path: "src", kind: "directory" },
      { path: "src/app.ts", kind: "file" },
      { path: "package.json", kind: "file" },
    ];
    files.directoryReady = true;
    files.directoryPending = false;
    files.searchEntries = [];
    files.searchPending = false;
    files.searchError = null;
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    vi.unstubAllGlobals();
  });

  it("keeps visible rows stationary during loading while showing initial loading status", async () => {
    const entries = files.directoryEntries;
    files.directoryEntries = [];
    files.directoryReady = false;
    files.directoryPending = true;
    await render();
    expect(visiblePaths()).toEqual([]);
    expectVisibleLoadingStatus();

    files.directoryEntries = entries;
    files.directoryReady = true;
    files.directoryPending = false;
    await render();
    expect(visiblePaths()).toEqual(["src/", "package.json"]);
    const initialTop = rowTop("package.json");

    files.directoryPending = true;
    await render();
    expect(rowTop("package.json")).toBe(initialTop);

    files.directoryPending = false;
    await search("pack");
    expect(visiblePaths()).toEqual(["package.json"]);
    const filteredTop = rowTop("package.json");

    files.searchPending = true;
    await search("package");
    expect(visiblePaths()).toEqual(["package.json"]);
    expect(rowTop("package.json")).toBe(filteredTop);

    files.searchPending = false;
    await render();
    expect(rowTop("package.json")).toBe(filteredTop);
  });

  it("shows no matching files instead of the full tree when a filename is absent", async () => {
    await render();
    expect(visiblePaths()).toEqual(["src/", "package.json"]);

    await search(".env.local");
    expect(visiblePaths()).toEqual([]);
    expect(hasMessage("No matching files.")).toBe(true);

    await search("package");
    expect(visiblePaths()).toEqual(["package.json"]);
    expect(hasMessage("No matching files.")).toBe(false);

    await search("");
    expect(visiblePaths()).toEqual(["src/", "package.json"]);
  });

  it("still finds ignored files already loaded from a directory", async () => {
    files.directoryEntries.push({ path: ".env.local", kind: "file", ignored: true });
    await render();
    await search(".env.local");
    expect(visiblePaths()).toEqual([".env.local"]);
    expect(hasMessage("No matching files.")).toBe(false);
  });

  it("waits for remote matches without showing unrelated files or a premature empty result", async () => {
    await render();
    files.searchPending = true;
    await search("settings.ts");
    expect(visiblePaths()).toEqual([]);
    expectVisibleLoadingStatus();
    expect(hasMessage("No matching files.")).toBe(false);

    files.searchEntries = [{ path: "config/settings.ts", kind: "file" }];
    files.searchPending = false;
    await render();
    expect(visiblePaths()).toEqual(["config/", "config/settings.ts"]);
    expect(hasMessage("No matching files.")).toBe(false);
  });

  it("restores the tree on Escape after an unsuccessful search", async () => {
    await render();
    await search("missing-file");
    expect(visiblePaths()).toEqual([]);

    const input = searchInput();
    input.focus();
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.activeElement).not.toBe(input);
    expect(visiblePaths()).toEqual(["src/", "package.json"]);
    expect(hasMessage("No matching files.")).toBe(false);
  });

  it("does not report an empty result when the search failed", async () => {
    await render();
    files.searchError = "Workspace search failed.";
    await search("missing-file");
    expect(visiblePaths()).toEqual([]);
    expect(hasMessage("No matching files.")).toBe(false);
    expect(container!.textContent).toContain("Workspace search failed.");
  });
});
