import { isMacPlatform } from "@t3tools/shared/keybindings";
import {
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { ThreadFindBar } from "~/components/chat/ThreadFindBar";
import { stepThreadFindIndex } from "~/components/chat/threadFind";
import { collectTextFindRanges } from "~/components/chat/threadFindHighlights";

const FILE_FIND_HIGHLIGHT_NAME = "t3-file-find";
const FILE_FIND_ACTIVE_HIGHLIGHT_NAME = "t3-file-find-active";

/** Chat shortcuts leave Cmd/Ctrl+F to a rendered file preview that owns its own find. */
export const FILE_FIND_SCOPE_SELECTOR = "[data-file-find]";

function useFileFindState() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [focusRequestId, setFocusRequestId] = useState(0);
  const show = () => {
    setOpen(true);
    setFocusRequestId((id) => id + 1);
  };
  return {
    open,
    setOpen,
    query,
    setQuery,
    activeIndex,
    setActiveIndex,
    focusRequestId,
    show,
    search: open ? query.trim() : "",
  };
}

function FileFindShell(props: {
  readonly find: ReturnType<typeof useFileFindState>;
  readonly matchCount: number;
  readonly contentRef?: RefObject<HTMLDivElement | null>;
  readonly children: ReactNode;
}) {
  const { find, matchCount, contentRef } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const close = () => {
    find.setOpen(false);
    rootRef.current?.focus({ preventScroll: true });
  };
  const step = (delta: number) =>
    find.setActiveIndex((index) => stepThreadFindIndex(index, matchCount, delta));

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.defaultPrevented) return;
    const mod = isMacPlatform(navigator.platform) ? event.metaKey : event.ctrlKey;
    if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      find.show();
    } else if (event.key === "Escape" && find.open) {
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
        open={find.open}
        label="Find in file"
        query={find.query}
        matchCount={matchCount}
        status={null}
        onRetry={() => undefined}
        activeIndex={find.activeIndex}
        focusRequestId={find.focusRequestId}
        onQueryChange={(next) => {
          find.setQuery(next);
          find.setActiveIndex(0);
        }}
        onNext={() => step(1)}
        onPrevious={() => step(-1)}
        onClose={close}
      />
    </div>
  );
}

/** Cmd/Ctrl+F searches rendered file content that the source view's find cannot reach. */
export function RenderedFileFind(props: { readonly children: ReactNode }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [ranges, setRanges] = useState<readonly Range[]>([]);
  const find = useFileFindState();
  const { search, activeIndex } = find;

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

  return (
    <FileFindShell find={find} matchCount={ranges.length} contentRef={contentRef}>
      {props.children}
    </FileFindShell>
  );
}

/** Must match the desktop shell's prefix, which only searches iframes it names. */
const FIND_FRAME_NAME_PREFIX = "t3-file-find-";

/**
 * Desktop find for an opaque-origin iframe the renderer cannot read: the shell
 * reports Cmd/Ctrl+F pressed inside it and runs the search there. Browsers have
 * their own page find, which already reaches the frame.
 */
export function FrameFileFind(props: {
  readonly children: (frameName: string | undefined) => ReactNode;
}) {
  const bridge = window.desktopBridge;
  const frameName = `${FIND_FRAME_NAME_PREFIX}${useId()}`;
  const [count, setCount] = useState(0);
  const find = useFileFindState();
  const { search, activeIndex, show } = find;
  const onFrameFindRequest = useEffectEvent((name: string) => {
    if (name === frameName) show();
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the desktop shell's in-frame find shortcut
  useEffect(() => bridge?.onFrameFindRequest?.(onFrameFindRequest), [bridge]);

  const searched = useRef(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- runs the search inside the iframe, which also clears it for an empty query
  useEffect(() => {
    if (!bridge?.findInFrame || (search.length === 0 && !searched.current)) return;
    searched.current = search.length > 0;
    let current = true;
    void bridge
      .findInFrame(frameName, search, activeIndex)
      .then((next) => {
        if (current) setCount(next);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [bridge, frameName, search, activeIndex]);

  if (!bridge?.findInFrame || !bridge.onFrameFindRequest) return props.children(undefined);
  return (
    <FileFindShell find={find} matchCount={count}>
      {props.children(frameName)}
    </FileFindShell>
  );
}
