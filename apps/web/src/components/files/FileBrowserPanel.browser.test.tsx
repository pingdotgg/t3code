import {
  EnvironmentId,
  type ProjectEntry,
  type ProjectStatFileInput,
  type ProjectStatFileResult,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { commands, page, userEvent } from "vite-plus/test/browser";

import { COMPOSER_MENTION_DRAG_TYPE } from "~/components/chat/composerMentionDrag";
import { RightPanelSheet } from "~/components/RightPanelSheet";
import { dismissContextMenu } from "~/contextMenuFallback";
import { isMacPlatform } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { act, render } from "../../../test/render";
import FileBrowserPanel from "./FileBrowserPanel";
import { dispatchPreviewAction } from "../preview/previewActionBus";
import { writeExpandedDirectories } from "./fileTreeExpansion";
import { FULL_TEXT_MAX_BYTES } from "./largeTextProtocol";

const entries: readonly ProjectEntry[] = [
  { path: "src", kind: "directory" },
  { path: "README.md", kind: "file" },
];
const loadingDirectories: ReadonlySet<string> = new Set();
const directory: {
  entries: readonly ProjectEntry[];
  load: () => Promise<void>;
  refresh: () => void;
  revalidate: (directoryPath: string) => void;
  ready: boolean;
  error: null;
  isPending: boolean;
  loadingDirectories: ReadonlySet<string>;
} = {
  entries,
  load: () => Promise.resolve(),
  refresh: () => {},
  revalidate: () => {},
  ready: true,
  error: null,
  isPending: false,
  loadingDirectories,
};
const pathSearch = {
  entries: [],
  isPending: false,
  error: null,
  truncated: false,
  refresh: () => {},
};

vi.mock("./useDirectoryEntries", () => ({ useDirectoryEntries: () => directory }));
vi.mock("~/state/queries", () => ({ useProjectPathSearch: () => pathSearch }));
vi.mock("~/fileContextMenu", () => ({
  useFileContextMenu: () => ({ buildItems: () => [], activate: () => Promise.resolve() }),
}));
const downloadFile = vi.fn();
vi.mock("./useFileDownload", () => ({ useFileDownload: () => downloadFile }));
// One stat answer per workspace root and relative path, waiting until a test settles it.
const statAnswers = new Map<
  string,
  Atom.Writable<AsyncResult.AsyncResult<ProjectStatFileResult, string>>
>();
const statAnswer = (cwd: string, relativePath: string) => {
  const key = `${cwd}|${relativePath}`;
  const known = statAnswers.get(key);
  if (known) return known;
  const answer = Atom.make<AsyncResult.AsyncResult<ProjectStatFileResult, string>>(
    AsyncResult.initial(true),
  ).pipe(Atom.keepAlive);
  statAnswers.set(key, answer);
  return answer;
};
vi.mock("~/state/projects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/state/projects")>();
  return {
    ...actual,
    projectEnvironment: {
      ...actual.projectEnvironment,
      // Derived, so the refresh each read asks for keeps the answer a test set.
      statFile: ({ input }: { input: ProjectStatFileInput }) =>
        Atom.make((get) => get(statAnswer(input.cwd, input.relativePath))),
    },
  };
});
vi.mock("~/state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/session")>()),
  readEnvironmentScope: () => true,
}));
vi.mock("~/hooks/useWorkspaceMutationRefresh", () => ({ useWorkspaceMutationRefresh: () => {} }));

function findTreeRow(path: string): HTMLElement | null {
  for (const host of document.querySelectorAll("*")) {
    const row = host.shadowRoot?.querySelector<HTMLElement>(`[data-item-path="${path}"]`);
    if (row) return row;
  }
  return null;
}

function findTreeScroller(): HTMLElement | null {
  for (const host of document.querySelectorAll("*")) {
    const scroller = host.shadowRoot?.querySelector<HTMLElement>(
      "[data-file-tree-virtualized-scroll]",
    );
    if (scroller) return scroller;
  }
  return null;
}

function isTreeRowInView(path: string): boolean {
  const rowRect = findTreeRow(path)?.getBoundingClientRect();
  const scrollerRect = findTreeScroller()?.getBoundingClientRect();
  return (
    rowRect !== undefined &&
    scrollerRect !== undefined &&
    rowRect.top >= scrollerRect.top &&
    rowRect.bottom <= scrollerRect.bottom
  );
}

function sizedContainer(): HTMLElement {
  const container = document.createElement("div");
  container.style.cssText = "display:flex;flex-direction:column;height:300px;width:300px";
  return container;
}

function withDirectoryListing(listing: readonly ProjectEntry[]): Disposable {
  directory.entries = listing;
  return {
    [Symbol.dispose]: () => {
      directory.entries = entries;
      directory.ready = true;
    },
  };
}

describe("FileBrowserPanel", () => {
  it("copies with the pointer and returns to the row after keyboard dismissal", async () => {
    await using _screen = await render(
      <FileBrowserPanel
        environmentId={EnvironmentId.make("env-files")}
        cwd="/repo"
        projectName="repo"
        selectedPath={null}
        selectedPathRevealId={0}
        onOpenFile={() => {}}
        workspaceMutationId={null}
      />,
    );
    using _menu = { [Symbol.dispose]: () => dismissContextMenu() };
    using clipboard = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);

    async function openRowMenu(path: string) {
      await vi.waitFor(() => expect(findTreeRow(path)).not.toBeNull());
      findTreeRow(path)!.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          composed: true,
          button: 2,
        }),
      );
    }

    await openRowMenu("src/");
    const copyPath = page.getByRole("menuitem", { name: "Copy path", exact: true });
    const download = page.getByRole("menuitem", { name: "Download", exact: true });
    await expect.element(copyPath).toBeVisible();
    expect(download.query()).toBeNull();
    await userEvent.click(copyPath);
    await vi.waitFor(() => expect(clipboard).toHaveBeenCalledWith("/repo/src"));

    await openRowMenu("README.md");
    const copyMention = page.getByRole("menuitem", { name: "Copy mention", exact: true });
    await expect.element(copyMention).toBeVisible();
    await userEvent.click(copyMention);
    await vi.waitFor(() => expect(clipboard).toHaveBeenCalledWith("[README.md](README.md)"));

    await openRowMenu("README.md");
    await userEvent.click(download);
    expect(downloadFile).toHaveBeenCalledWith("/repo", "README.md");

    // Hover can take focus when the keyboard menu reopens under the pointer.
    await commands.resetPointer();
    const row = findTreeRow("README.md")!;
    await userEvent.keyboard("{Tab}");
    row.focus();
    await userEvent.keyboard("{Shift>}{F10}{/Shift}");
    await expect.element(download).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect((row.getRootNode() as ShadowRoot).activeElement).toBe(row));
  });

  it("offers Open preview for markdown files and opens them rendered", async () => {
    const onOpenFilePreview = vi.fn();
    await using _screen = await render(
      <FileBrowserPanel
        environmentId={EnvironmentId.make("env-files")}
        cwd="/repo"
        projectName="repo"
        selectedPath={null}
        selectedPathRevealId={0}
        onOpenFile={() => {}}
        onOpenFilePreview={onOpenFilePreview}
        workspaceMutationId={null}
      />,
    );
    using _menu = { [Symbol.dispose]: () => dismissContextMenu() };
    using _answers = { [Symbol.dispose]: () => statAnswers.clear() };
    appAtomRegistry.set(statAnswer("/repo", "README.md"), AsyncResult.success({ byteLength: 18 }));
    await vi.waitFor(() => expect(findTreeRow("README.md")).not.toBeNull());
    const action = page.getByRole("menuitem", { name: "Open preview", exact: true });

    findTreeRow("src/")!.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, composed: true, button: 2 }),
    );
    await expect
      .element(page.getByRole("menuitem", { name: "Copy mention", exact: true }))
      .toBeVisible();
    await expect.element(action).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");

    findTreeRow("README.md")!.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, composed: true, button: 2 }),
    );
    await userEvent.click(action);
    expect(onOpenFilePreview).toHaveBeenCalledWith("README.md");
  });

  it("offers Open preview only for markdown whose size is confirmed renderable", async () => {
    using _listing = withDirectoryListing([
      { path: "huge.md", kind: "file" },
      { path: "small.md", kind: "file" },
      { path: "slow-huge.md", kind: "file" },
      { path: "slow-small.md", kind: "file" },
      { path: "failed.md", kind: "file" },
    ]);
    // A network workspace: the generic metadata endpoint never stats one, the workspace stat does.
    const cwd = "\\\\nas\\share\\project";
    const answer = (path: string, byteLength: number) =>
      appAtomRegistry.set(statAnswer(cwd, path), AsyncResult.success({ byteLength }));
    using _answers = { [Symbol.dispose]: () => statAnswers.clear() };
    answer("huge.md", FULL_TEXT_MAX_BYTES + 1);
    answer("small.md", FULL_TEXT_MAX_BYTES);
    appAtomRegistry.set(statAnswer(cwd, "failed.md"), AsyncResult.fail("unknown method"));
    await using _screen = await render(
      <FileBrowserPanel
        environmentId={EnvironmentId.make("env-files")}
        cwd={cwd}
        projectName="repo"
        selectedPath={null}
        selectedPathRevealId={0}
        onOpenFile={() => {}}
        onOpenFilePreview={() => {}}
        workspaceMutationId={null}
      />,
    );
    using _menu = { [Symbol.dispose]: () => dismissContextMenu() };
    await vi.waitFor(() => expect(findTreeRow("huge.md")).not.toBeNull());
    const action = page.getByRole("menuitem", { name: "Open preview", exact: true });
    const copyPath = page.getByRole("menuitem", { name: "Copy path", exact: true });
    async function expectOffered(path: string, offered: boolean) {
      findTreeRow(path)!.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          composed: true,
          button: 2,
        }),
      );
      await expect.element(copyPath).toBeVisible();
      if (offered) await expect.element(action).toBeVisible();
      else await expect.element(action).not.toBeInTheDocument();
      await userEvent.keyboard("{Escape}");
      await expect.element(copyPath).not.toBeInTheDocument();
    }

    await expectOffered("small.md", true);
    await expectOffered("failed.md", true);
    await expectOffered("huge.md", false);

    // Before the stat answers, the file may still turn out too large to render.
    await expectOffered("slow-huge.md", false);
    await expectOffered("slow-small.md", false);
    answer("slow-huge.md", FULL_TEXT_MAX_BYTES + 1);
    answer("slow-small.md", 2048);
    await expectOffered("slow-huge.md", false);
    await vi.waitFor(() => expectOffered("slow-small.md", true));
  });

  it("dragging a file row carries a composer mention without opening it, and dragend releases it", async () => {
    const onOpenFile = vi.fn();
    await using _screen = await render(
      <FileBrowserPanel
        environmentId={EnvironmentId.make("env-files")}
        cwd="/repo"
        projectName="repo"
        selectedPath={null}
        selectedPathRevealId={0}
        onOpenFile={onOpenFile}
        workspaceMutationId={null}
      />,
    );
    await vi.waitFor(() => expect(findTreeRow("README.md")).not.toBeNull());
    const row = findTreeRow("README.md")!;

    const dataTransfer = new DataTransfer();
    row.dispatchEvent(
      new DragEvent("dragstart", { bubbles: true, cancelable: true, composed: true, dataTransfer }),
    );
    // The tree selects the row the drag picked up; mid-drag that must not open it.
    row.click();
    await vi.waitFor(() => expect(row.getAttribute("aria-selected")).toBe("true"));

    expect(dataTransfer.getData(COMPOSER_MENTION_DRAG_TYPE)).toContain("README.md");
    expect(onOpenFile).not.toHaveBeenCalled();

    row.dispatchEvent(new DragEvent("dragend", { bubbles: true, composed: true, dataTransfer }));
    await vi.waitFor(() => expect(row.getAttribute("aria-selected")).not.toBe("true"));

    row.click();
    await vi.waitFor(() => expect(onOpenFile).toHaveBeenCalledTimes(1));

    // The selection stays put, so reopening the selected file must not depend on a selection change.
    row.click();
    await vi.waitFor(() => expect(onOpenFile).toHaveBeenCalledTimes(2));
  });

  it("keeps an expanded folder open when a very large listing rebuilds the tree", async () => {
    using _listing = withDirectoryListing(entries);
    const renderPanel = () => (
      <FileBrowserPanel
        environmentId={EnvironmentId.make("env-files")}
        cwd="/repo-large-folder-1"
        projectName="repo"
        selectedPath={null}
        selectedPathRevealId={0}
        onOpenFile={() => {}}
        workspaceMutationId={null}
      />
    );
    await using screen = await render(renderPanel());
    await vi.waitFor(() => expect(findTreeRow("src/")).not.toBeNull());
    findTreeRow("src/")!.click();
    await vi.waitFor(() => expect(findTreeRow("src/")!.getAttribute("aria-expanded")).toBe("true"));

    directory.entries = [
      ...entries,
      // Out of sort order, because inserting in order hides the cost of each insert.
      ...Array.from({ length: 2_000 }, (_, index): ProjectEntry => {
        const name = String((index * 7_919) % 2_000).padStart(4, "0");
        return { path: `src/generated-${name}`, kind: "directory" };
      }),
    ];
    await screen.rerender(renderPanel());

    await vi.waitFor(() => expect(findTreeRow("src/generated-0000/")).not.toBeNull());
    expect(findTreeRow("src/")!.getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps the selected file through a very large listing without reopening it", async () => {
    const onOpenFile = vi.fn();
    const renderPanel = () => (
      <FileBrowserPanel
        environmentId={EnvironmentId.make("env-files")}
        cwd="/repo-large-folder-2"
        projectName="repo"
        selectedPath="src/aaa.ts"
        selectedPathRevealId={1}
        onOpenFile={onOpenFile}
        workspaceMutationId={null}
      />
    );
    using _listing = withDirectoryListing([...entries, { path: "src/aaa.ts", kind: "file" }]);
    await using screen = await render(renderPanel());
    await vi.waitFor(() =>
      expect(findTreeRow("src/aaa.ts")?.getAttribute("aria-selected")).toBe("true"),
    );

    directory.entries = [
      ...directory.entries,
      ...Array.from({ length: 2_000 }, (_, index): ProjectEntry => {
        const name = String((index * 7_919) % 2_000).padStart(4, "0");
        return { path: `src/generated-${name}.ts`, kind: "file" };
      }),
    ];
    await screen.rerender(renderPanel());

    await vi.waitFor(() => expect(findTreeRow("src/generated-0000.ts")).not.toBeNull());
    expect(findTreeRow("src/aaa.ts")?.getAttribute("aria-selected")).toBe("true");
    expect(findTreeRow("src/")?.getAttribute("aria-expanded")).toBe("true");
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("keeps an open search accurate when a very large folder listing arrives", async () => {
    const renderPanel = () => (
      <FileBrowserPanel
        environmentId={EnvironmentId.make("env-files")}
        cwd="/repo-large-folder-3"
        projectName="repo"
        selectedPath={null}
        selectedPathRevealId={0}
        onOpenFile={() => {}}
        workspaceMutationId={null}
      />
    );
    using _listing = withDirectoryListing([
      ...entries,
      { path: "lib", kind: "directory" },
      { path: "lib/generated-existing.ts", kind: "file" },
    ]);
    await using screen = await render(renderPanel());
    const search = page.getByRole("searchbox", { name: "Search repo files" });
    await userEvent.fill(search, "generated-");
    await vi.waitFor(() => expect(findTreeRow("lib/generated-existing.ts")).not.toBeNull());

    directory.entries = [
      ...directory.entries,
      ...Array.from({ length: 2_000 }, (_, index): ProjectEntry => {
        const name = String((index * 7_919) % 2_000).padStart(4, "0");
        return { path: `src/generated-${name}.ts`, kind: "file" };
      }),
    ];
    await screen.rerender(renderPanel());

    await vi.waitFor(() => expect(findTreeRow("src/generated-0000.ts")).not.toBeNull());
    expect(findTreeRow("lib/generated-existing.ts")).not.toBeNull();
    await expect.element(search).toHaveValue("generated-");
  });

  it("mod+f from a tree row, or the panel find command, focuses the file search", async () => {
    await using _screen = await render(
      <FileBrowserPanel
        environmentId={EnvironmentId.make("env-files")}
        cwd="/repo"
        projectName="repo"
        selectedPath={null}
        selectedPathRevealId={0}
        onOpenFile={() => {}}
        workspaceMutationId={null}
        answersPanelFind
      />,
    );
    await vi.waitFor(() => expect(findTreeRow("README.md")).not.toBeNull());
    findTreeRow("README.md")!.focus();

    const modifier = isMacPlatform(navigator.platform) ? "Meta" : "Control";
    await userEvent.keyboard(`{${modifier}>}f{/${modifier}}`);

    const search = page.getByRole("searchbox", { name: "Search repo files" });
    await expect.element(search).toHaveFocus();

    (search.element() as HTMLElement).blur();
    dispatchPreviewAction("find");
    await expect.element(search).toHaveFocus();
  });

  it("Escape in the file search clears it without closing the panel sheet", async () => {
    const onCloseSheet = vi.fn();
    await using _screen = await render(
      <RightPanelSheet animationDurationMs={0} open onClose={onCloseSheet}>
        <FileBrowserPanel
          environmentId={EnvironmentId.make("env-files")}
          cwd="/repo"
          projectName="repo"
          selectedPath={null}
          selectedPathRevealId={0}
          onOpenFile={() => {}}
          workspaceMutationId={null}
        />
      </RightPanelSheet>,
    );
    const search = page.getByRole("searchbox", { name: "Search repo files" });
    await userEvent.fill(search, "read");
    for (const composition of [
      { key: "Escape", isComposing: true, keyCode: 27 },
      { key: "Escape", isComposing: false, keyCode: 229 },
    ]) {
      // Safari ends the composition just before the Escape keydown.
      await act(() => {
        search.element().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
        search
          .element()
          .dispatchEvent(new KeyboardEvent("keydown", { ...composition, bubbles: true }));
      });
      await expect.element(search).toHaveValue("read");
    }
    expect(search.element().getAttribute("type")).toBe("text");

    await userEvent.keyboard("{Escape}");
    await expect.element(search).toHaveValue("");
    await expect.element(search).toHaveFocus();
    await act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", repeat: true, bubbles: true }),
      );
    });
    expect(onCloseSheet).not.toHaveBeenCalled();

    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(onCloseSheet).toHaveBeenCalledOnce());
  });

  it("keeps expanded folders when the panel remounts", async () => {
    const panel = () => (
      <FileBrowserPanel
        environmentId={EnvironmentId.make("env-files")}
        cwd="/repo"
        projectName="repo"
        selectedPath={null}
        selectedPathRevealId={0}
        onOpenFile={() => {}}
        workspaceMutationId={null}
      />
    );
    {
      await using _first = await render(panel());
      await vi.waitFor(() => expect(findTreeRow("src/")).not.toBeNull());
      findTreeRow("src/")!.click();
      await vi.waitFor(() =>
        expect(findTreeRow("src/")!.getAttribute("aria-expanded")).toBe("true"),
      );
    }

    using revalidate = vi.spyOn(directory, "revalidate");
    await using _second = await render(panel());
    await vi.waitFor(() => expect(findTreeRow("src/")).not.toBeNull());
    await vi.waitFor(() => expect(findTreeRow("src/")!.getAttribute("aria-expanded")).toBe("true"));

    // Refresh revalidates the folders behind the rows on screen: the open one and the root.
    // The tree can render its rows again at any time, so compare folders, not calls.
    revalidate.mockClear();
    await userEvent.click(page.getByRole("button", { name: "Refresh workspace files" }));
    expect(new Set(revalidate.mock.calls.flat())).toEqual(new Set(["src", ""]));
  });

  it("opens a chain of single folders from one click and keeps it closed once closed", async () => {
    const chain: readonly ProjectEntry[] = [
      { path: "tests", kind: "directory" },
      { path: "tests/edit", kind: "directory" },
      { path: "tests/edit/unit", kind: "directory" },
      { path: "tests/edit/unit/a.ts", kind: "file" },
    ];
    const panel = () => (
      <FileBrowserPanel
        environmentId={EnvironmentId.make("env-files")}
        cwd="/repo-single-folder-chain"
        projectName="repo"
        selectedPath={null}
        selectedPathRevealId={0}
        onOpenFile={() => {}}
        workspaceMutationId={null}
      />
    );
    using _listing = withDirectoryListing(chain.slice(0, 1));
    {
      await using screen = await render(panel());
      await vi.waitFor(() => expect(findTreeRow("tests/")).not.toBeNull());
      findTreeRow("tests/")!.click();
      await vi.waitFor(() =>
        expect(findTreeRow("tests/")!.getAttribute("aria-expanded")).toBe("true"),
      );
      for (const listed of [2, 3, 4]) {
        directory.entries = chain.slice(0, listed);
        await screen.rerender(panel());
      }
      await vi.waitFor(() => expect(findTreeRow("tests/edit/unit/a.ts")).not.toBeNull());

      findTreeRow("tests/edit/unit/")!.click();
      await vi.waitFor(() => expect(findTreeRow("tests/edit/unit/a.ts")).toBeNull());
      directory.entries = [...chain, { path: "tests/edit/unit/b.ts", kind: "file" }];
      await screen.rerender(panel());
      expect(findTreeRow("tests/edit/unit/")!.getAttribute("aria-expanded")).toBe("false");
    }

    directory.entries = [...chain, { path: "pkg", kind: "directory" }];
    await using remounted = await render(panel());
    await vi.waitFor(() => expect(findTreeRow("tests/edit/unit/")).not.toBeNull());
    expect(findTreeRow("tests/edit/unit/")!.getAttribute("aria-expanded")).toBe("false");

    // An ignored folder can hold tens of thousands of entries, so it still opens by hand.
    findTreeRow("pkg/")!.click();
    await vi.waitFor(() => expect(findTreeRow("pkg/")!.getAttribute("aria-expanded")).toBe("true"));
    directory.entries = [
      ...directory.entries,
      { path: "pkg/node_modules", kind: "directory", ignored: true },
    ];
    await remounted.rerender(panel());
    await vi.waitFor(() => expect(findTreeRow("pkg/node_modules/")).not.toBeNull());
    expect(findTreeRow("pkg/node_modules/")!.getAttribute("aria-expanded")).toBe("false");
  });

  describe("revealing a folder while folders above it are still loading", () => {
    const roots = Array.from({ length: 12 }, (_, index): ProjectEntry => {
      return { path: `d${String(index).padStart(2, "0")}`, kind: "directory" };
    });
    const listing = (parent: string, count: number) =>
      Array.from({ length: count }, (_, index): ProjectEntry => {
        return { path: `${parent}/f${String(index).padStart(3, "0")}.ts`, kind: "file" };
      });
    const renderPanel = (cwd: string) => (
      <FileBrowserPanel
        environmentId={EnvironmentId.make("env-files")}
        cwd={cwd}
        projectName="repo"
        selectedPath="d09"
        selectedPathRevealId={1}
        onOpenFile={() => {}}
        workspaceMutationId={null}
      />
    );
    // The tree mounts empty and measures itself before the first listing arrives, as it does for real.
    async function renderRevealedPanel(cwd: string) {
      writeExpandedDirectories(`env-files:${cwd}`, ["d01/", "d01/sub/"]);
      directory.ready = false;
      await using stack = new AsyncDisposableStack();
      const screen = stack.use(await render(renderPanel(cwd), { container: sizedContainer() }));
      directory.entries = roots;
      directory.ready = true;
      await screen.rerender(renderPanel(cwd));
      await vi.waitFor(() => expect(isTreeRowInView("d09/")).toBe(true));
      stack.move();
      return screen;
    }

    it("keeps the revealed folder in view as restored folders above it load", async () => {
      const cwd = "/repo-reveal-follows-loading";
      using _listing = withDirectoryListing([]);
      await using screen = await renderRevealedPanel(cwd);

      // d01 lists after the reveal and holds another restored folder, which lists in turn.
      directory.entries = [...roots, ...listing("d01", 60), { path: "d01/sub", kind: "directory" }];
      await screen.rerender(renderPanel(cwd));
      await vi.waitFor(() => expect(findTreeScroller()!.scrollHeight).toBeGreaterThan(60 * 24));
      directory.entries = [...directory.entries, ...listing("d01/sub", 60)];
      await screen.rerender(renderPanel(cwd));

      await vi.waitFor(() => expect(isTreeRowInView("d09/")).toBe(true));
    });

    it("leaves the scroll position alone once the user scrolls the tree", async () => {
      const cwd = "/repo-reveal-user-scroll";
      using _listing = withDirectoryListing([]);
      await using screen = await renderRevealedPanel(cwd);

      const scroller = findTreeScroller()!;
      scroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true, composed: true }));
      scroller.scrollTop = 0;
      directory.entries = [...roots, ...listing("d01", 60)];
      await screen.rerender(renderPanel(cwd));
      await vi.waitFor(() => expect(scroller.scrollHeight).toBeGreaterThan(60 * 24));

      expect(scroller.scrollTop).toBe(0);
    });
  });
});
