import {
  CodeView,
  DEFAULT_THEMES,
  parseDiffFromFile,
  preloadHighlighter,
  type CodeViewItem,
} from "@pierre/diffs";
import { expect, it, vi } from "vite-plus/test";

const LINES = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`);

function contents(changes: Record<number, string>) {
  return `${LINES.map((line, index) => changes[index] ?? line).join("\n")}\n`;
}

function currentMatchText() {
  return Array.from(CSS.highlights.get("diffs-search-current") ?? [], String);
}

// Upstream find skips folded files and collapsed context, and drops focus on close. Our @pierre/diffs patch covers all three.
it("finds and reveals matches in folded files and collapsed context, then hands focus back", async () => {
  await preloadHighlighter({ themes: Object.values(DEFAULT_THEMES), langs: ["text"] });
  let items: CodeViewItem<undefined>[] = [
    {
      id: "folded",
      type: "diff",
      collapsed: true,
      fileDiff: parseDiffFromFile(
        { name: "folded.txt", contents: "old\n" },
        { name: "folded.txt", contents: "NEEDLE added\n" },
      ),
    },
    {
      id: "context",
      type: "diff",
      fileDiff: parseDiffFromFile(
        { name: "context.txt", contents: contents({ 39: "needle in context" }) },
        {
          name: "context.txt",
          contents: contents({ 0: "changed", 39: "needle in context", 79: "changed" }),
        },
      ),
    },
  ];
  const root = document.createElement("div");
  root.style.cssText = "width: 800px; height: 300px; overflow: auto;";
  document.body.append(root);
  const search = { matchCount: 0, currentMatchIndex: undefined as number | undefined };
  const view = new CodeView<undefined>({
    diffStyle: "unified",
    searchOptions: { scrollBehavior: "instant" },
    onSearchStateChange: (state) => {
      search.matchCount = state?.matchCount ?? 0;
      search.currentMatchIndex = state?.currentMatchIndex;
    },
    onRevealSearchMatch: (item) => {
      items = items.map((candidate) =>
        candidate.id === item.id ? { ...candidate, collapsed: false, version: 1 } : candidate,
      );
      view.setItems(items);
    },
  });
  using _view = {
    [Symbol.dispose]: () => {
      view.cleanUp();
      root.remove();
    },
  };
  view.setup(root);
  view.setItems(items);

  view.openSearch({ query: "needle" });
  await vi.waitFor(() => expect(search).toEqual({ matchCount: 2, currentMatchIndex: 0 }));
  await vi.waitFor(() => expect(currentMatchText()).toEqual(["NEEDLE"]));

  view.navigateSearch("next");
  await vi.waitFor(() => expect(currentMatchText()).toEqual(["needle"]));
  expect(search.currentMatchIndex).toBe(1);

  // Focus that leaves the viewer on close takes the find shortcut with it.
  const input = root.querySelector("[data-search-panel]")?.shadowRoot?.querySelector("input");
  input!.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }),
  );
  expect(view.isSearchOpen()).toBe(false);
  expect(document.activeElement).toBe(root);
});
