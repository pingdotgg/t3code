import { isMacPlatform } from "@t3tools/shared/keybindings";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { ThreadFindBar } from "~/components/chat/ThreadFindBar";
import { stepThreadFindIndex } from "~/components/chat/threadFind";
import { collectTextFindRanges } from "~/components/chat/threadFindHighlights";

const FILE_FIND_HIGHLIGHT_NAME = "t3-file-find";
const FILE_FIND_ACTIVE_HIGHLIGHT_NAME = "t3-file-find-active";

/** Chat shortcuts leave Cmd/Ctrl+F to a rendered file preview that owns its own find. */
export const FILE_FIND_SCOPE_SELECTOR = "[data-file-find]";

/** Cmd/Ctrl+F searches rendered file content that the source view's find cannot reach. */
export function RenderedFileFind(props: { readonly children: ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [ranges, setRanges] = useState<readonly Range[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [focusRequestId, setFocusRequestId] = useState(0);
  const search = open ? query.trim() : "";

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- collects DOM text ranges for the query and recollects when the rendered content changes
  useEffect(() => {
    const content = contentRef.current;
    if (content === null || search.length === 0) {
      setRanges([]);
      return;
    }
    const collect = () => setRanges(collectTextFindRanges(content, search));
    collect();
    let frame: number | null = null;
    const observer = new MutationObserver(() => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        collect();
      });
    });
    observer.observe(content, { subtree: true, childList: true, characterData: true });
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [search]);

  const activeRange = ranges[Math.min(activeIndex, ranges.length - 1)] ?? null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- paints CSS Highlight ranges and scrolls the active match into view
  useEffect(() => {
    if (typeof CSS === "undefined" || !CSS.highlights || typeof Highlight === "undefined") return;
    if (ranges.length === 0) return;
    CSS.highlights.set(
      FILE_FIND_HIGHLIGHT_NAME,
      new Highlight(...ranges.filter((range) => range !== activeRange)),
    );
    if (activeRange) {
      CSS.highlights.set(FILE_FIND_ACTIVE_HIGHLIGHT_NAME, new Highlight(activeRange));
      activeRange.startContainer.parentElement?.scrollIntoView({ block: "nearest" });
    }
    return () => {
      CSS.highlights.delete(FILE_FIND_HIGHLIGHT_NAME);
      CSS.highlights.delete(FILE_FIND_ACTIVE_HIGHLIGHT_NAME);
    };
  }, [activeRange, ranges]);

  const close = () => {
    setOpen(false);
    rootRef.current?.focus({ preventScroll: true });
  };
  const step = (delta: number) =>
    setActiveIndex((index) => stepThreadFindIndex(index, ranges.length, delta));

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.defaultPrevented) return;
    const mod = isMacPlatform(navigator.platform) ? event.metaKey : event.ctrlKey;
    if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      setOpen(true);
      setFocusRequestId((id) => id + 1);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      close();
    }
  };

  return (
    <div
      ref={rootRef}
      data-file-find
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="relative flex min-h-0 flex-1 flex-col outline-none"
    >
      <div ref={contentRef} className="flex min-h-0 flex-1 flex-col">
        {props.children}
      </div>
      <ThreadFindBar
        open={open}
        label="Find in file"
        query={query}
        matchCount={ranges.length}
        status={null}
        onRetry={() => undefined}
        activeIndex={activeIndex}
        focusRequestId={focusRequestId}
        onQueryChange={(next) => {
          setQuery(next);
          setActiveIndex(0);
        }}
        onNext={() => step(1)}
        onPrevious={() => step(-1)}
        onClose={close}
      />
    </div>
  );
}
