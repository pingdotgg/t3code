import { HistoryIcon } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { ComposerBanner } from "./ComposerBanner";
import { DiffStatLabel } from "./DiffStatLabel";
import { type RevertPickerOption } from "./revertPicker.logic";

function isSelectable(option: RevertPickerOption): boolean {
  return option.turnCount !== null;
}

function nextSelectableIndex(
  options: ReadonlyArray<RevertPickerOption>,
  fromIndex: number,
  offset: number,
): number | null {
  for (let step = 1; step <= options.length; step += 1) {
    const index = (fromIndex + offset * step + options.length * step) % options.length;
    const option = options[index];
    if (option && isSelectable(option)) return index;
  }
  return null;
}

export const ComposerRevertMenu = memo(function ComposerRevertMenu(props: {
  options: ReadonlyArray<RevertPickerOption>;
  onHighlight: (option: RevertPickerOption | null) => void;
  onRevert: (option: RevertPickerOption) => void;
  onClose: () => void;
}) {
  const { options, onHighlight, onRevert, onClose } = props;
  const drawerRef = useRef<HTMLDivElement>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(
    options.find(isSelectable)?.messageId ?? null,
  );

  const highlightedOption =
    options.find((option) => option.messageId === highlightedId) ?? options.find(isSelectable);

  useEffect(() => {
    onHighlight(highlightedOption ?? null);
  }, [highlightedOption, onHighlight]);
  useEffect(() => () => onHighlight(null), [onHighlight]);

  useEffect(() => {
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const drawer = drawerRef.current;
      if (drawer && event.composedPath().includes(drawer)) return;
      onClose();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
  }, [onClose]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (options.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        const currentIndex = options.findIndex(
          (option) => option.messageId === highlightedOption?.messageId,
        );
        const offset = event.key === "ArrowDown" ? 1 : -1;
        const nextIndex = nextSelectableIndex(
          options,
          currentIndex >= 0 ? currentIndex : offset === 1 ? -1 : 0,
          offset,
        );
        if (nextIndex === null) return;
        setHighlightedId(options[nextIndex]?.messageId ?? null);
        const nextRow =
          drawerRef.current?.querySelectorAll<HTMLElement>("[data-revert-option]")[nextIndex];
        nextRow?.scrollIntoView({ block: "nearest" });
        return;
      }
      if (event.key === "Enter") {
        if (!highlightedOption || !isSelectable(highlightedOption)) return;
        event.preventDefault();
        event.stopPropagation();
        onRevert(highlightedOption);
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [highlightedOption, onClose, onRevert, options]);

  return (
    <ComposerBanner.Root ref={drawerRef} data-composer-revert-drawer="true">
      <ComposerBanner.Row
        render={<button type="button" />}
        aria-label="Close revert picker"
        aria-expanded="true"
        onPointerDown={(event) => event.preventDefault()}
        onClick={onClose}
      >
        <ComposerBanner.Icon>
          <HistoryIcon />
        </ComposerBanner.Icon>
        <ComposerBanner.Content className="text-muted-foreground">Revert to</ComposerBanner.Content>
        <ComposerBanner.Actions>
          <ComposerBanner.ToggleIcon expanded />
        </ComposerBanner.Actions>
      </ComposerBanner.Row>
      <ComposerBanner.Scroll>
        <ComposerBanner.Children render={<ul role="list" />} aria-label="Revert targets">
          {options.map((option) => {
            const selectable = isSelectable(option);
            const highlighted = highlightedOption?.messageId === option.messageId;
            return (
              <ComposerBanner.Row
                render={<li />}
                key={option.messageId}
                data-revert-option={option.messageId}
                data-revert-option-disabled={selectable ? undefined : "true"}
                data-highlighted={highlighted || undefined}
                className={cn(
                  "relative rounded-sm",
                  highlighted && "bg-accent text-accent-foreground",
                )}
                onMouseMove={() => {
                  if (selectable && highlightedId !== option.messageId) {
                    setHighlightedId(option.messageId);
                  }
                }}
              >
                <ComposerBanner.Icon className="justify-end pe-1 tabular-nums">
                  {option.turnLabel ?? "·"}
                </ComposerBanner.Icon>
                <ComposerBanner.Content>
                  {selectable ? (
                    <button
                      type="button"
                      className="min-w-0 flex-1 cursor-pointer truncate text-left text-foreground/80 outline-none before:absolute before:inset-0 before:rounded-sm focus-visible:before:ring-2 focus-visible:before:ring-ring"
                      aria-label={`Revert to before: ${option.snippet}`}
                      onPointerDown={(event) => event.preventDefault()}
                      onClick={() => onRevert(option)}
                    >
                      {option.snippet}
                    </button>
                  ) : (
                    <span className="min-w-0 flex-1 truncate text-muted-foreground/70">
                      {option.snippet}
                    </span>
                  )}
                </ComposerBanner.Content>
                <ComposerBanner.Actions>
                  {!selectable ? (
                    <span className="shrink-0 text-muted-foreground/70">
                      {option.unavailableReason === "pending"
                        ? "no checkpoint"
                        : "checkpoint expired"}
                    </span>
                  ) : option.filesChanged === 0 ? (
                    <span className="shrink-0 text-muted-foreground">no changes</span>
                  ) : (
                    <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
                      <span className="tabular-nums">
                        {option.filesChanged} file{option.filesChanged === 1 ? "" : "s"}
                      </span>
                      <DiffStatLabel
                        additions={option.additions}
                        deletions={option.deletions}
                        layout="inline"
                      />
                    </span>
                  )}
                  <time
                    dateTime={option.createdAt}
                    className="shrink-0 text-muted-foreground tabular-nums max-sm:hidden"
                  >
                    {formatRelativeTimeLabel(option.createdAt)}
                  </time>
                </ComposerBanner.Actions>
              </ComposerBanner.Row>
            );
          })}
        </ComposerBanner.Children>
      </ComposerBanner.Scroll>
      <ComposerBanner.Row>
        <ComposerBanner.Icon />
        <ComposerBanner.Content className="text-muted-foreground/70">
          ↑↓ select · ⏎ revert · esc cancel
        </ComposerBanner.Content>
      </ComposerBanner.Row>
    </ComposerBanner.Root>
  );
});
