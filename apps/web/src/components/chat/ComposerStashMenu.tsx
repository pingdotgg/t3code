import { CornerDownLeftIcon, FileIcon, XIcon } from "lucide-react";
import { memo, use, useEffect, useEffectEvent, useRef, useState, type RefObject } from "react";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";

import { RelativeTime } from "../RelativeTime";
import { cn, isMacPlatform } from "~/lib/utils";
import { useLayoutPaneFocusedRef } from "../../layout/layoutPaneContext";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { type PromptStashEntry } from "../../promptStashStore";
import { BackgroundThreadContext } from "./backgroundThread";

const SNIPPET_MAX_CHARS = 90;

function missingImageCount(entry: PromptStashEntry): number {
  return entry.droppedImageNames.length + (entry.unreadableImageNames?.length ?? 0);
}

function stashEntrySnippet(entry: PromptStashEntry): string {
  const trimmed = assistantCitationsToPlainText(entry.prompt).trim().replace(/\s+/g, " ");
  if (trimmed.length > 0) {
    return trimmed.length > SNIPPET_MAX_CHARS ? `${trimmed.slice(0, SNIPPET_MAX_CHARS)}…` : trimmed;
  }
  const imageCount = entry.attachments.length + entry.droppedImageNames.length;
  const fileCount = entry.files?.length ?? 0;
  const attachmentCount = imageCount + fileCount;
  if (attachmentCount === 0) {
    return "(empty)";
  }
  const label = imageCount > 0 && fileCount > 0 ? "attachment" : fileCount > 0 ? "file" : "image";
  return `(${attachmentCount} ${label}${attachmentCount === 1 ? "" : "s"})`;
}

/** Window capture gives the focused pane's open menu priority over composer key handlers. */
export const ComposerStashMenu = memo(function ComposerStashMenu(props: {
  entries: ReadonlyArray<PromptStashEntry>;
  stashShortcutLabel: string | null;
  composerFormRef: RefObject<HTMLFormElement | null>;
  onRestore: (entry: PromptStashEntry) => void;
  onDelete: (entry: PromptStashEntry) => void;
  onClose: () => void;
}) {
  const { entries, stashShortcutLabel, composerFormRef, onRestore, onDelete, onClose } = props;
  const backgroundThread = use(BackgroundThreadContext);
  const [highlightedId, setHighlightedId] = useState<string | null>(entries[0]?.id ?? null);
  const paneFocusedRef = useLayoutPaneFocusedRef();

  const highlightedEntry = entries.find((entry) => entry.id === highlightedId) ?? entries[0];
  const drawerRef = useRef<HTMLDivElement>(null);

  // Both listeners read entries, highlight and callbacks at event time, so they subscribe
  // once for the menu's lifetime instead of on every highlight change.
  const closeOnOutsidePointer = useEffectEvent((event: PointerEvent) => {
    const drawer = drawerRef.current;
    if (
      (drawer && event.composedPath().includes(drawer)) ||
      (event.target instanceof Element && event.target.closest('[data-prompt-stash-badge="true"]'))
    ) {
      return;
    }
    onClose();
  });

  const handleKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (backgroundThread || !paneFocusedRef.current) return;
    const drawer = drawerRef.current;
    if (!drawer) return;
    const target = event.target;
    if (
      !(target instanceof Node) ||
      (target !== document.body &&
        !(target instanceof Element && target.closest('[data-prompt-stash-badge="true"]')) &&
        !drawer.contains(target) &&
        !composerFormRef.current?.querySelector('textarea, [role="textbox"]')?.contains(target))
    ) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (entries.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const currentIndex = entries.findIndex((entry) => entry.id === highlightedEntry?.id);
      const offset = event.key === "ArrowDown" ? 1 : -1;
      const normalizedIndex = currentIndex >= 0 ? currentIndex : offset === 1 ? -1 : 0;
      const nextIndex = (normalizedIndex + offset + entries.length) % entries.length;
      setHighlightedId(entries[nextIndex]?.id ?? null);
      const nextButton =
        drawer.querySelectorAll<HTMLButtonElement>("[data-stash-restore]")[nextIndex];
      nextButton?.scrollIntoView({ block: "nearest" });
      if (drawer.contains(document.activeElement)) {
        nextButton?.focus({ preventScroll: true });
      }
      return;
    }
    if (event.key === "Enter") {
      // Let the delete button handle Enter instead of restoring its row.
      if (event.target instanceof HTMLElement && event.target.closest("button[aria-label]")) {
        return;
      }
      if (!highlightedEntry) return;
      event.preventDefault();
      event.stopPropagation();
      onRestore(highlightedEntry);
      return;
    }
    if (event.key === "Backspace" && (event.metaKey || event.ctrlKey)) {
      if (!highlightedEntry) return;
      event.preventDefault();
      event.stopPropagation();
      onDelete(highlightedEntry);
    }
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes capture-phase pointerdown and keydown listeners for outside close and keyboard navigation
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => closeOnOutsidePointer(event);
    const onKeyDown = (event: KeyboardEvent) => handleKeyDown(event);
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);

  const deleteKey = isMacPlatform(navigator.platform) ? "⌘⌫" : "Ctrl ⌫";

  return (
    <div
      ref={drawerRef}
      data-composer-stash-drawer="true"
      className="relative isolate flex w-full min-w-0 flex-col gap-px rounded-card p-1.5 kbd-in-popover before:pointer-events-none before:absolute before:inset-0 before:-z-1 before:rounded-card before:surface-popover"
    >
      <div className="flex items-center px-2.5 py-1.5 text-meta">
        <span className="text-foreground">Stash</span>
        <span className="flex-1" />
        <span className="text-dim-foreground">
          {entries.length} prompt{entries.length === 1 ? "" : "s"}
        </span>
      </div>
      <ul
        role="list"
        aria-label="Stashed prompts"
        className="flex max-h-72 flex-col gap-px overflow-y-auto"
      >
        {entries.length === 0 ? (
          <li className="px-2.5 py-2 text-body text-muted-foreground">
            Nothing stashed yet.
            {stashShortcutLabel
              ? ` Press ${stashShortcutLabel} with a prompt in the composer to stash it.`
              : null}
          </li>
        ) : (
          entries.map((entry) => {
            const highlighted = highlightedEntry?.id === entry.id;
            return (
              <li
                key={entry.id}
                data-stash-entry={entry.id}
                data-highlighted={highlighted || undefined}
                className={cn(
                  "relative flex h-8.5 min-w-0 shrink-0 items-center gap-2.5 rounded-control px-2.5 text-body",
                  highlighted && "surface-selected",
                )}
                onMouseMove={() => {
                  if (highlightedId !== entry.id) setHighlightedId(entry.id);
                }}
                onFocus={() => setHighlightedId(entry.id)}
              >
                <CornerDownLeftIcon
                  aria-hidden
                  className={cn(
                    "size-3.75 shrink-0",
                    highlighted ? "text-foreground" : "text-muted-foreground",
                  )}
                />
                <button
                  type="button"
                  className={cn(
                    "min-w-0 flex-1 cursor-pointer truncate text-left text-label outline-none before:absolute before:inset-0 before:rounded-control focus-visible:before:ring-2 focus-visible:before:ring-inset focus-visible:before:ring-ring",
                    highlighted ? "text-strong-foreground" : "text-foreground",
                  )}
                  data-stash-restore={entry.id}
                  aria-label={`Restore stashed prompt: ${stashEntrySnippet(entry)}`}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => onRestore(entry)}
                >
                  {stashEntrySnippet(entry)}
                </button>
                {entry.pendingImageCount ? (
                  <span className="shrink-0 text-meta text-muted-foreground">
                    saving {entry.pendingImageCount} image
                    {entry.pendingImageCount === 1 ? "" : "s"}…
                  </span>
                ) : missingImageCount(entry) > 0 ? (
                  <span className="shrink-0 text-meta text-warning-foreground">
                    {missingImageCount(entry)} image
                    {missingImageCount(entry) === 1 ? "" : "s"} dropped
                  </span>
                ) : null}
                {entry.attachments.length > 0 ? (
                  <span className="flex shrink-0 items-center -space-x-1.5">
                    {entry.attachments.slice(0, 3).map((attachment) => (
                      <img
                        key={attachment.id}
                        src={attachment.dataUrl}
                        alt=""
                        aria-hidden="true"
                        className="size-4 rounded border border-border/70 object-cover"
                      />
                    ))}
                  </span>
                ) : null}
                {(entry.files?.length ?? 0) > 0 ? (
                  <span className="flex shrink-0 items-center gap-1 text-meta text-muted-foreground">
                    <FileIcon className="size-3" aria-hidden />
                    {entry.files!.length}
                  </span>
                ) : null}
                <time
                  dateTime={entry.createdAt}
                  className="shrink-0 text-meta text-dim-foreground tabular-nums max-sm:hidden"
                >
                  <RelativeTime timestamp={entry.createdAt} />
                </time>
                <Button
                  variant="ghost-muted"
                  size="icon-micro"
                  className="relative z-10"
                  aria-label="Delete stashed prompt"
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => onDelete(entry)}
                >
                  <XIcon aria-hidden />
                </Button>
              </li>
            );
          })
        )}
      </ul>
      <div className="flex items-center gap-3 border-t border-(--chat-composer-outline) px-2.5 pt-2 pb-1 text-caption text-dim-foreground">
        <span className="flex items-center gap-1.25">
          <Kbd>⏎</Kbd>Restore
        </span>
        <span className="flex items-center gap-1.25">
          <Kbd>{deleteKey}</Kbd>Delete
        </span>
        <span className="flex items-center gap-1.25">
          <Kbd>esc</Kbd>Close
        </span>
      </div>
    </div>
  );
});
