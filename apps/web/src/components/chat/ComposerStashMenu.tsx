import { msg, T, useGT, useMessages, Var } from "gt-react";
import { BookmarkIcon, FileIcon, FileTextIcon } from "lucide-react";
import { memo, useEffect, useEffectEvent, useRef, useState, type RefObject } from "react";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { composerFileLinksToPlainText } from "@t3tools/shared/composerInlineTokens";

import { RelativeTime } from "../RelativeTime";
import { m, type MessageResolver } from "~/i18n/messages";
import { cn } from "~/lib/utils";
import { type PromptStashEntry } from "../../promptStashStore";
import { ComposerBanner } from "./ComposerBanner";

const SNIPPET_MAX_CHARS = 90;

function missingImageCount(entry: PromptStashEntry): number {
  return entry.droppedImageNames.length + (entry.unreadableImageNames?.length ?? 0);
}

export function stashEntrySnippet(entry: PromptStashEntry, resolve: MessageResolver = m): string {
  const trimmed = assistantCitationsToPlainText(
    composerFileLinksToPlainText(
      replaceComposerContextReferences(entry.prompt, (reference) => reference.label),
    ),
  )
    .trim()
    .replace(/\s+/g, " ");
  if (trimmed.length > 0) {
    if (trimmed.length <= SNIPPET_MAX_CHARS) return trimmed;
    // Never end on a lone high surrogate, the first half of an emoji.
    const last = trimmed.charCodeAt(SNIPPET_MAX_CHARS - 1);
    const end = last >= 0xd800 && last <= 0xdbff ? SNIPPET_MAX_CHARS - 1 : SNIPPET_MAX_CHARS;
    return `${trimmed.slice(0, end).trimEnd()}…`;
  }
  const imageCount =
    entry.attachments.length + missingImageCount(entry) + (entry.pendingImageCount ?? 0);
  const fileCount = entry.files?.length ?? 0;
  const attachmentCount = imageCount + fileCount;
  if (attachmentCount === 0) {
    return resolve(msg("(empty)"));
  }
  if (imageCount > 0 && fileCount > 0) {
    return resolve(
      msg("{count, plural, one {({count} attachment)} other {({count} attachments)}}", {
        count: attachmentCount,
      }),
    );
  }
  return fileCount > 0
    ? resolve(
        msg("{count, plural, one {({count} file)} other {({count} files)}}", {
          count: attachmentCount,
        }),
      )
    : resolve(
        msg("{count, plural, one {({count} image)} other {({count} images)}}", {
          count: attachmentCount,
        }),
      );
}

/** Window capture gives the open menu priority over composer key handlers. */
export const ComposerStashMenu = memo(function ComposerStashMenu(props: {
  entries: ReadonlyArray<PromptStashEntry>;
  stashShortcutLabel: string | null;
  composerFormRef: RefObject<HTMLFormElement | null>;
  onRestore: (entry: PromptStashEntry) => void;
  onDelete: (entry: PromptStashEntry) => void;
  onClose: () => void;
}) {
  const { entries, stashShortcutLabel, composerFormRef, onRestore, onDelete, onClose } = props;
  const gt = useGT();
  const m = useMessages();
  const [highlightedId, setHighlightedId] = useState<string | null>(entries[0]?.id ?? null);

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
    if (event.isComposing || event.keyCode === 229) return;
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

  return (
    <ComposerBanner.Root
      ref={drawerRef}
      className="flex min-h-0 flex-col after:shrink-0"
      data-composer-stash-drawer="true"
    >
      <ComposerBanner.Row
        render={<button type="button" />}
        aria-label={gt("Close stash")}
        aria-expanded="true"
        onPointerDown={(event) => event.preventDefault()}
        onClick={onClose}
      >
        <ComposerBanner.Icon>
          <BookmarkIcon />
        </ComposerBanner.Icon>
        <ComposerBanner.Content className="text-muted-foreground">
          {gt("Stash", { $context: "noun, saved prompts set aside for later" })}
        </ComposerBanner.Content>
        <ComposerBanner.Actions>
          <ComposerBanner.Count>{entries.length}</ComposerBanner.Count>
          <ComposerBanner.ToggleIcon expanded />
        </ComposerBanner.Actions>
      </ComposerBanner.Row>
      <ComposerBanner.Scroll className="flex flex-col">
        <ComposerBanner.Children render={<ul role="list" />} aria-label={gt("Stashed prompts")}>
          {entries.length === 0 ? (
            <ComposerBanner.Row render={<li />}>
              <ComposerBanner.Icon />
              <ComposerBanner.Content className="text-muted-foreground">
                <T>Nothing stashed yet.</T>
                {stashShortcutLabel ? (
                  <>
                    {" "}
                    <T>
                      Press <Var>{stashShortcutLabel}</Var> with a prompt in the composer to stash
                      it.
                    </T>
                  </>
                ) : null}
              </ComposerBanner.Content>
            </ComposerBanner.Row>
          ) : (
            entries.map((entry) => (
              <ComposerBanner.Row
                render={<li />}
                key={entry.id}
                data-stash-entry={entry.id}
                data-highlighted={highlightedEntry?.id === entry.id || undefined}
                className={cn(
                  "relative rounded-sm",
                  highlightedEntry?.id === entry.id && "bg-accent text-accent-foreground",
                )}
                onMouseMove={() => {
                  if (highlightedId !== entry.id) setHighlightedId(entry.id);
                }}
                onFocus={() => setHighlightedId(entry.id)}
              >
                <ComposerBanner.Icon>
                  <FileTextIcon />
                </ComposerBanner.Icon>
                <ComposerBanner.Content>
                  <button
                    type="button"
                    className="min-w-0 flex-1 cursor-pointer truncate text-left text-foreground/80 outline-none before:absolute before:inset-0 before:rounded-sm focus-visible:before:ring-2 focus-visible:before:ring-inset focus-visible:before:ring-ring"
                    data-stash-restore={entry.id}
                    aria-label={gt("Restore stashed prompt: {snippet}", {
                      snippet: stashEntrySnippet(entry, m),
                    })}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => onRestore(entry)}
                  >
                    {stashEntrySnippet(entry, m)}
                  </button>
                </ComposerBanner.Content>
                <ComposerBanner.Actions>
                  {entry.pendingImageCount ? (
                    <span className="shrink-0 text-muted-foreground">
                      {gt(
                        "{count, plural, one {saving {count} image…} other {saving {count} images…}}",
                        { count: entry.pendingImageCount },
                      )}
                    </span>
                  ) : missingImageCount(entry) > 0 ? (
                    <span className="shrink-0 text-warning-foreground">
                      {gt(
                        "{count, plural, one {{count} image dropped} other {{count} images dropped}}",
                        { count: missingImageCount(entry) },
                      )}
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
                    <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
                      <FileIcon className="size-3" aria-hidden />
                      {entry.files!.length}
                    </span>
                  ) : null}
                  <time
                    dateTime={entry.createdAt}
                    className="shrink-0 text-muted-foreground tabular-nums max-sm:hidden"
                  >
                    <RelativeTime timestamp={entry.createdAt} />
                  </time>
                  <ComposerBanner.Dismiss
                    className="z-10"
                    aria-label={gt("Delete stashed prompt")}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => onDelete(entry)}
                  />
                </ComposerBanner.Actions>
              </ComposerBanner.Row>
            ))
          )}
        </ComposerBanner.Children>
      </ComposerBanner.Scroll>
    </ComposerBanner.Root>
  );
});
