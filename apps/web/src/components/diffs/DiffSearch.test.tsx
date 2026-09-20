import { parseDiffFromFile, parsePatchFiles, type CodeViewItem } from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";
import { act, useLayoutEffect, type KeyboardEvent, type ComponentProps } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useDiffSearch } from "./DiffSearch";
import { findDiffSearchMatches, isDiffSearchShortcut } from "./DiffSearch.logic";

vi.mock("../ui/input", () => ({ Input: (props: ComponentProps<"input">) => <input {...props} /> }));
vi.mock("../ui/button", () => ({
  Button: (props: ComponentProps<"button">) => <button {...props} />,
}));

describe("diff search", () => {
  class SearchElement {
    isContentEditable = false;
    constructor(readonly scope = false) {}
    hasAttribute(name: string) {
      return this.scope && name === "data-diff-search-scope";
    }
  }
  beforeEach(() => {
    vi.stubGlobal("HTMLElement", SearchElement);
    vi.stubGlobal("Element", SearchElement);
    vi.stubGlobal("HTMLInputElement", class extends SearchElement {});
    vi.stubGlobal("HTMLTextAreaElement", class extends SearchElement {});
  });
  let renderer: ReactTestRenderer | undefined;
  afterEach(async () => {
    await act(async () => renderer?.unmount());
    vi.unstubAllGlobals();
  });

  it("uses original line numbers on both sides of a partial diff without duplicate context", () => {
    const fileDiff = parsePatchFiles(
      [
        "diff --git a/file.ts b/file.ts",
        "--- a/file.ts",
        "+++ b/file.ts",
        "@@ -20,3 +40,3 @@",
        " shared needle",
        "-old needle",
        "+new needle needle",
        " end",
        "",
      ].join("\n"),
    )[0]!.files[0]!;
    expect(
      findDiffSearchMatches([{ type: "diff", id: "partial", fileDiff }], "needle").matches,
    ).toEqual([
      { id: "partial", lineNumber: 40, side: "additions", character: 7, length: 6 },
      { id: "partial", lineNumber: 21, side: "deletions", character: 4, length: 6 },
      { id: "partial", lineNumber: 41, side: "additions", character: 4, length: 6 },
      { id: "partial", lineNumber: 41, side: "additions", character: 11, length: 6 },
    ]);
  });

  it("finds deleted files and full-file text outside the diff hunks", () => {
    const contents = ["Hidden needle", ...Array.from({ length: 30 }, () => "context"), "old"].join(
      "\n",
    );
    const fileDiff = parseDiffFromFile(
      { name: "full.ts", contents },
      { name: "full.ts", contents: contents.replace("old", "new") },
    );
    const deleted = parseDiffFromFile({ name: "deleted.ts", contents: "lost needle\n" }, null);
    expect(
      findDiffSearchMatches(
        [
          { type: "diff", id: "full", fileDiff, collapsed: true },
          { type: "diff", id: "deleted", fileDiff: deleted },
        ],
        "needle",
      ).matches,
    ).toEqual([
      { id: "full", lineNumber: 1, side: "additions", character: 7, length: 6 },
      { id: "deleted", lineNumber: 1, side: "deletions", character: 5, length: 6 },
    ]);
  });

  it("treats search text literally and matches case without changing offsets", () => {
    expect(
      findDiffSearchMatches(
        [
          {
            type: "file",
            id: "file",
            file: {
              name: "file",
              contents: "prefix [A.B] [a.b]\n",
            },
          },
        ],
        "[a.b]",
      ).matches,
    ).toEqual([
      { id: "file", lineNumber: 1, side: "additions", character: 7, length: 5 },
      { id: "file", lineNumber: 1, side: "additions", character: 13, length: 5 },
    ]);
  });

  it("caps large match sets before scanning later files and distinguishes exact counts", () => {
    const file: CodeViewItem = {
      type: "file",
      id: "large",
      file: { name: "large.txt", contents: "x".repeat(1024 * 1024) },
    };
    const unseen: CodeViewItem = {
      type: "file",
      id: "unseen",
      file: {
        name: "unseen.txt",
        get contents(): string {
          throw new Error("Search should have stopped");
        },
      },
    };
    const result = findDiffSearchMatches([file, unseen], "x");
    expect(result.limited).toBe(true);
    expect(result.matches).toHaveLength(10_000);
    expect(result.matches.at(-1)?.character).toBe(9_999);
    file.file.contents = "x".repeat(10_000);
    expect(findDiffSearchMatches([file], "x").limited).toBe(false);
  });

  it.each(["ctrlKey", "metaKey"])(
    "%s+F finds offscreen files, expands before revealing, wraps matches, and restores collapse on close",
    async (modifier) => {
      vi.stubGlobal("window", { getSelection: () => null });
      const files: CodeViewItem[] = Array.from({ length: 100 }, (_, index) => ({
        type: "file",
        id: `file-${index}`,
        collapsed: true,
        file: {
          name: `file-${index}.ts`,
          contents: index === 99 ? "first needle needle\n" : "empty\n",
        },
      }));
      const nodes = [{ textContent: "first nee" }, { textContent: "dle needle\n" }];
      const ranges: { start: [object, number] | undefined; end: [object, number] | undefined }[] =
        [];
      const line = {
        setAttribute: vi.fn(),
        removeAttribute: vi.fn(),
        ownerDocument: {
          createTreeWalker: () => {
            let index = 0;
            return { nextNode: () => nodes[index++] };
          },
          createRange: () => {
            const range = {
              start: undefined as [object, number] | undefined,
              end: undefined as [object, number] | undefined,
              setStart: (node: object, offset: number) => {
                range.start = [node, offset];
              },
              setEnd: (node: object, offset: number) => {
                range.end = [node, offset];
              },
            };
            ranges.push(range);
            return range;
          },
        },
      };
      vi.stubGlobal("NodeFilter", { SHOW_TEXT: 4 });
      const highlights = new Map<string, object>();
      vi.stubGlobal("CSS", { highlights });
      vi.stubGlobal(
        "Highlight",
        class {
          constructor(readonly range: object) {}
        },
      );
      let visible: readonly CodeViewItem[] = files;
      let revealed = false;
      const scrollTo = vi.fn((target) => {
        expect(visible.find((item) => item.id === target.id)?.collapsed).toBe(false);
        revealed = true;
      });
      const focus = vi.fn();
      const viewer = {
        scrollTo,
        getInstance: () => ({
          getRenderedItems: () =>
            revealed
              ? [
                  {
                    id: "file-99",
                    element: {
                      shadowRoot: { querySelector: () => line, querySelectorAll: () => [line] },
                    },
                  },
                ]
              : [],
          getContainerElement: () => ({ focus }),
        }),
      } as unknown as CodeViewHandle<undefined>;
      function Surface() {
        const search = useDiffSearch(files, viewer);
        useLayoutEffect(() => {
          visible = search.items;
        }, [search.items]);
        return <div onKeyDown={search.onKeyDown}>{search.searchBar}</div>;
      }
      const selectInput = vi.fn();
      await act(async () => {
        renderer = create(<Surface />, {
          createNodeMock: (element) => (element.type === "input" ? { select: selectInput } : null),
        });
      });
      const nativeEvent = {
        key: "f",
        ctrlKey: modifier === "ctrlKey",
        metaKey: modifier === "metaKey",
        altKey: false,
        shiftKey: false,
        composedPath: () => [new SearchElement(true)],
      };
      const event = {
        ...nativeEvent,
        defaultPrevented: false,
        nativeEvent,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      } as unknown as KeyboardEvent<HTMLDivElement>;
      await act(async () =>
        renderer!.root
          .findAllByType("div")[0]!
          .props.onKeyDown({ ...event, defaultPrevented: true }),
      );
      expect(renderer!.root.findAllByType("input")).toHaveLength(0);
      await act(async () => renderer!.root.findAllByType("div")[0]!.props.onKeyDown(event));
      expect(event.preventDefault).toHaveBeenCalled();
      await act(async () =>
        renderer!.root.findByType("input").props.onChange({ target: { value: "needle" } }),
      );
      expect(scrollTo).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: "file-99", lineNumber: 1, align: "center" }),
      );
      expect(ranges.at(-1)).toMatchObject({ start: [nodes[0], 6], end: [nodes[1], 3] });
      expect(highlights.size).toBe(1);
      expect(selectInput).toHaveBeenCalledTimes(1);
      const next = renderer!.root.findByProps({ "aria-label": "Next match" });
      await act(async () => next.props.onClick());
      expect(scrollTo).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: "file-99", lineNumber: 1 }),
      );
      expect(ranges.at(-1)).toMatchObject({ start: [nodes[1], 4], end: [nodes[1], 10] });
      expect(selectInput).toHaveBeenCalledTimes(1);
      await act(async () => next.props.onClick());
      expect(scrollTo).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: "file-99", lineNumber: 1 }),
      );
      await act(async () =>
        renderer!.root.findByProps({ "aria-label": "Close find" }).props.onClick(),
      );
      expect(visible).toBe(files);
      expect(focus).toHaveBeenCalled();
      expect(highlights.size).toBe(0);
      expect(renderer!.root.findAllByType("input")).toHaveLength(0);
    },
  );

  it.each([
    ["ctrlKey", "f"],
    ["metaKey", "f"],
    ["ctrlKey", "d"],
    ["metaKey", "d"],
  ])(
    "gives a later-mounted viewer %s+%s before the global capture shortcut",
    async (modifier, key) => {
      vi.stubGlobal(
        "window",
        Object.assign(new EventTarget(), {
          getSelection: () => ({ toString: () => "needle", rangeCount: 0 }),
        }),
      );
      const togglePanel = vi.fn();
      window.addEventListener(
        "keydown",
        (event) => {
          if (isDiffSearchShortcut(event)) return;
          event.preventDefault();
          togglePanel();
        },
        true,
      );
      const viewer = {
        scrollTo: vi.fn(),
        getInstance: () => ({ getRenderedItems: () => [] }),
      } as unknown as CodeViewHandle<undefined>;
      const items: CodeViewItem[] = [
        { id: "file", type: "file", file: { name: "file.ts", contents: "needle needle" } },
      ];
      function Surface() {
        const search = useDiffSearch(items, viewer);
        return <div onKeyDown={search.onKeyDown}>{search.searchBar}</div>;
      }
      await act(async () => {
        renderer = create(<Surface />);
      });
      const dispatch = async (path: SearchElement[]) => {
        const nativeEvent = Object.assign(new Event("keydown", { cancelable: true }), {
          key,
          ctrlKey: modifier === "ctrlKey",
          metaKey: modifier === "metaKey",
          altKey: false,
          shiftKey: false,
          composedPath: () => path,
        });
        await act(async () => {
          window.dispatchEvent(nativeEvent);
          if (!nativeEvent.defaultPrevented)
            renderer!.root.findAllByType("div")[0]!.props.onKeyDown({
              key,
              nativeEvent,
              preventDefault: () => nativeEvent.preventDefault(),
              stopPropagation: () => nativeEvent.stopPropagation(),
            });
        });
        return nativeEvent;
      };
      const scope = new SearchElement(true);
      expect((await dispatch([scope])).defaultPrevented).toBe(true);
      expect(togglePanel).not.toHaveBeenCalled();
      expect(renderer!.root.findByType("input").props.value).toBe("needle");
      expect(viewer.scrollTo).toHaveBeenCalled();
      const editable = new SearchElement();
      editable.isContentEditable = true;
      expect((await dispatch([editable, scope])).defaultPrevented).toBe(false);
      expect(togglePanel).not.toHaveBeenCalled();
      expect((await dispatch([new SearchElement()])).defaultPrevented).toBe(true);
      expect(togglePanel).toHaveBeenCalledOnce();
    },
  );
});
