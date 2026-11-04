import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";

import { ThreadFindBar } from "../chat/ThreadFindBar";
import { MarkdownFindContext } from "../chat/markdownFindContext";
import { ScrollArea } from "../ui/scroll-area";
import { createMarkdownFind } from "./markdownFind";
import { MARKDOWN_FIND_OPEN_EVENT } from "./markdownFindActionBus";

export function SearchableMarkdownPreview({ children }: { readonly children: ReactNode }) {
  const [preview, setPreview] = useState<HTMLDivElement | null>(null);
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [focusRequestId, setFocusRequestId] = useState(0);
  const [result, setResult] = useState({ matchCount: 0, activeIndex: 0 });
  const find = useRef<ReturnType<typeof createMarkdownFind> | null>(null);
  const close = () => {
    setOpen(false);
    setQuery("");
    setResult({ matchCount: 0, activeIndex: 0 });
    preview?.focus({ preventScroll: true });
  };
  const readQuery = useEffectEvent(() => query);
  const updateResult = useEffectEvent((next: typeof result) => {
    setResult((current) =>
      current.matchCount === next.matchCount && current.activeIndex === next.activeIndex
        ? current
        : next,
    );
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens for the file find command on this preview's DOM node
  useEffect(() => {
    if (!preview) return;
    const show = (event: Event) => {
      if (!CSS.highlights || typeof Highlight === "undefined") return;
      event.preventDefault();
      setOpen(true);
      setFocusRequestId((value) => value + 1);
    };
    preview.addEventListener(MARKDOWN_FIND_OPEN_EVENT, show);
    return () => preview.removeEventListener(MARKDOWN_FIND_OPEN_EVENT, show);
  }, [preview]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the DOM text index, mutation observer, and CSS highlights only while find is open
  useEffect(() => {
    if (!content || !open) return;
    const controller = createMarkdownFind(content, updateResult);
    find.current = controller;
    controller.search(readQuery());
    return () => {
      controller.dispose();
      find.current = null;
    };
  }, [content, open]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- updates the DOM search controller after the query and folded Markdown commit
  useEffect(() => {
    find.current?.search(query);
  }, [query]);

  return (
    <div
      ref={setPreview}
      data-markdown-preview
      tabIndex={-1}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col outline-none"
      onPointerDownCapture={(event) => {
        const interactive =
          event.target instanceof Element
            ? event.target.closest(
                "a, button, input, textarea, select, [tabindex], [contenteditable]",
              )
            : null;
        if (!interactive || interactive === preview) preview?.focus({ preventScroll: true });
      }}
      onKeyDown={(event) => {
        if (
          open &&
          event.key === "Escape" &&
          !event.nativeEvent.isComposing &&
          event.nativeEvent.keyCode !== 229
        ) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      <ThreadFindBar
        label="Find in file"
        open={open}
        query={query}
        matchCount={result.matchCount}
        activeIndex={result.activeIndex}
        status={null}
        focusRequestId={focusRequestId}
        onRetry={() => {}}
        onQueryChange={(value) => {
          setQuery(value);
          setResult({ matchCount: 0, activeIndex: 0 });
        }}
        onNext={() => find.current?.step(1)}
        onPrevious={() => find.current?.step(-1)}
        onClose={close}
      />
      <ScrollArea className="min-h-0 flex-1">
        <div ref={setContent}>
          <MarkdownFindContext value={open && query.trim().length > 0}>
            {children}
          </MarkdownFindContext>
        </div>
      </ScrollArea>
    </div>
  );
}
