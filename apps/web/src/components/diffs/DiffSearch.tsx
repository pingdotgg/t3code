import type { CodeViewItem } from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";
import { ArrowDownIcon, ArrowUpIcon, XIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  findDiffSearchMatches,
  isDiffSearchShortcut,
  revealDiffSearchMatch,
  type DiffSearchMatch,
} from "./DiffSearch.logic";

function matchLine(element: HTMLElement, match: DiffSearchMatch) {
  const root = element.shadowRoot;
  return root?.querySelector<HTMLElement>(
    `[data-code][data-${match.side}] [data-line="${match.lineNumber}"], ` +
      `[data-code][data-unified] [data-line="${match.lineNumber}"]${
        match.side === "deletions"
          ? '[data-line-type="change-deletion"]'
          : ':not([data-line-type="change-deletion"])'
      }, [data-file] [data-line="${match.lineNumber}"]`,
  );
}

function matchRange(line: HTMLElement, match: DiffSearchMatch) {
  const document = line.ownerDocument;
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let offset = 0;
  let started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const end = offset + (node.textContent?.length ?? 0);
    if (!started && match.character < end) {
      range.setStart(node, match.character - offset);
      started = true;
    }
    if (started && match.character + match.length <= end) {
      range.setEnd(node, match.character + match.length - offset);
      return range;
    }
    offset = end;
  }
}

export function useDiffSearch<LAnnotation>(
  items: readonly CodeViewItem<LAnnotation>[],
  viewer: CodeViewHandle<LAnnotation> | null,
) {
  const highlightName = `diff-search-${useId().replace(/[^\w-]/g, "")}`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const focusInput = useRef(false);
  const selectNext = useRef(false);
  const { matches, limited } = useMemo(
    () => findDiffSearchMatches(items, open ? query : ""),
    [items, open, query],
  );
  const match = matches[index % (matches.length || 1)];
  const visibleItems = useMemo(() => revealDiffSearchMatch(items, match), [items, match]);
  const decorate = useCallback(
    (element: HTMLElement, id: string) => {
      element.shadowRoot?.querySelectorAll("[data-search-match]").forEach((line) => {
        line.removeAttribute("data-search-match");
      });
      if (!match || match.id !== id) return;
      const line = matchLine(element, match);
      line?.setAttribute("data-search-match", "");
      const range = line && matchRange(line, match);
      if (
        range &&
        typeof CSS !== "undefined" &&
        CSS.highlights &&
        typeof Highlight !== "undefined"
      ) {
        CSS.highlights.set(highlightName, new Highlight(range));
      }
      if (range && selectNext.current) {
        selectNext.current = false;
        const selection = line.ownerDocument.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    },
    [highlightName, match],
  );
  useEffect(() => {
    if (open && focusInput.current) input.current?.select();
  }, [open]);
  useEffect(() => {
    if (typeof CSS !== "undefined") CSS.highlights?.delete(highlightName);
    if (match) viewer?.scrollTo({ type: "line", ...match, align: "center" });
    for (const item of viewer?.getInstance()?.getRenderedItems() ?? []) {
      decorate(item.element, item.id);
    }
    return () => {
      if (typeof CSS !== "undefined") CSS.highlights?.delete(highlightName);
    };
  }, [decorate, highlightName, match, viewer]);

  const move = (direction: number) => {
    setIndex((current) => (current + direction + matches.length) % (matches.length || 1));
  };
  const close = () => {
    selectNext.current = false;
    setOpen(false);
    viewer?.getInstance()?.getContainerElement()?.focus({ preventScroll: true });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || !isDiffSearchShortcut(event.nativeEvent)) return;
    const key = event.key.toLowerCase();
    if (
      event.nativeEvent
        .composedPath()
        .some(
          (node) =>
            node instanceof HTMLElement &&
            (node.isContentEditable ||
              node instanceof HTMLInputElement ||
              node instanceof HTMLTextAreaElement),
        )
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    const selection = window.getSelection();
    const selectedText = selection?.toString() ?? "";
    if (key === "f") {
      selectNext.current = false;
      focusInput.current = true;
      if (selectedText && !selectedText.includes("\n")) setQuery(selectedText);
      setOpen(true);
      setIndex(0);
      input.current?.select();
      return;
    }
    if (!selectedText || selectedText.includes("\n")) return;
    const { matches: nextMatches } = findDiffSearchMatches(items, selectedText);
    const rendered = viewer?.getInstance()?.getRenderedItems() ?? [];
    const selectedRange =
      selection?.getComposedRanges?.({
        shadowRoots: rendered.flatMap((item) =>
          item.element.shadowRoot ? [item.element.shadowRoot] : [],
        ),
      })[0] ?? (selection?.rangeCount ? selection.getRangeAt(0) : undefined);
    const anchor = selectedRange?.startContainer;
    const line = (anchor instanceof Element ? anchor : anchor?.parentElement)?.closest<HTMLElement>(
      "[data-line]",
    );
    const current = nextMatches.findIndex((candidate) => {
      const item = rendered.find((item) => item.id === candidate.id);
      if (!line || !item || matchLine(item.element, candidate) !== line || !selectedRange)
        return false;
      const range = line.ownerDocument.createRange();
      range.selectNodeContents(line);
      range.setEnd(selectedRange.startContainer, selectedRange.startOffset);
      return candidate.character === range.toString().length;
    });
    selectNext.current = true;
    focusInput.current = false;
    setQuery(selectedText);
    setOpen(true);
    setIndex((current + 1) % (nextMatches.length || 1));
  };

  const searchBar = open ? (
    <div
      role="search"
      aria-label="Find in changes"
      className="absolute top-2 right-3 z-20 flex max-w-[calc(100%-1.5rem)] items-center gap-1 rounded-lg border bg-popover p-1 shadow-md"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
        } else if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          move(event.shiftKey ? -1 : 1);
        } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
          event.preventDefault();
          event.stopPropagation();
          input.current?.select();
        }
      }}
    >
      <Input
        ref={input}
        size="compact"
        className="w-44"
        aria-label="Find in changes"
        placeholder="Find in changes"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setIndex(0);
        }}
      />
      <span
        className="min-w-10 text-center text-xs text-muted-foreground"
        aria-live="polite"
        aria-label={
          limited
            ? `Match ${(index % matches.length) + 1} of more than 10,000. Refine your search for fewer results.`
            : undefined
        }
      >
        {matches.length
          ? `${(index % matches.length) + 1}/${matches.length}${limited ? "+" : ""}`
          : query
            ? "0/0"
            : ""}
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Previous match"
        disabled={!matches.length}
        onClick={() => move(-1)}
      >
        <ArrowUpIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Next match"
        disabled={!matches.length}
        onClick={() => move(1)}
      >
        <ArrowDownIcon />
      </Button>
      <Button variant="ghost" size="icon-xs" aria-label="Close find" onClick={close}>
        <XIcon />
      </Button>
    </div>
  ) : null;
  return {
    searchBar,
    onKeyDown,
    items: visibleItems,
    decorate,
    active: match !== undefined,
    highlightCSS: `::highlight(${highlightName}) { background-color: #facc15; color: #171717; }`,
  };
}
