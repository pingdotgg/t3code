"use client";

import { CheckIcon, ChevronLeftIcon, MinusIcon, PlusIcon, SearchIcon, TagIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import {
  normalizeThreadLabelName,
  THREAD_LABEL_COLORS,
  THREAD_LABEL_NAME_MAX_LENGTH,
  type ThreadLabel,
} from "../threadLabels";
import { useUiStateStore } from "../uiStateStore";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";

const DEFAULT_THREAD_LABEL_COLOR = THREAD_LABEL_COLORS[0];

function ThreadLabelBadge({ label, compact = false }: { label: ThreadLabel; compact?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex min-w-0 shrink-0 items-center gap-1 rounded-full border font-medium text-foreground/85",
        compact ? "h-4 max-w-18 px-1 text-[9px]" : "h-5 max-w-24 px-1.5 text-[10px]",
      )}
      style={{
        backgroundColor: `${label.color}18`,
        borderColor: `${label.color}66`,
      }}
      title={label.name}
      data-testid={`thread-label-badge-${label.id}`}
    >
      <span
        aria-hidden
        className={cn("shrink-0 rounded-full", compact ? "size-1.5" : "size-2")}
        style={{ backgroundColor: label.color }}
      />
      <span className="truncate">{label.name}</span>
    </span>
  );
}

export function ThreadLabelBadgesForThread(props: {
  readonly threadKey: string;
  readonly compact?: boolean;
  readonly maxVisible?: number;
  readonly className?: string;
}) {
  const { compact = false, maxVisible = 2, threadKey } = props;
  const labels = useUiStateStore(
    useShallow((state) => {
      const assignedIds = state.threadLabelIdsByThreadKey[threadKey] ?? [];
      if (assignedIds.length === 0) return [];
      const assignedSet = new Set(assignedIds);
      return state.threadLabels.filter((label) => assignedSet.has(label.id));
    }),
  );
  if (labels.length === 0) {
    return null;
  }
  const visibleLabels = labels.slice(0, maxVisible);
  const hiddenCount = labels.length - visibleLabels.length;

  return (
    <span
      className={cn("inline-flex min-w-0 shrink-0 items-center gap-1", props.className)}
      aria-label={`Labels: ${labels.map((label) => label.name).join(", ")}`}
    >
      {visibleLabels.map((label) => (
        <ThreadLabelBadge key={label.id} label={label} compact={compact} />
      ))}
      {hiddenCount > 0 ? (
        <span
          className={cn(
            "inline-flex shrink-0 items-center justify-center rounded-full border border-border bg-background/70 font-medium text-muted-foreground",
            compact ? "h-4 min-w-4 px-1 text-[9px]" : "h-5 min-w-5 px-1 text-[10px]",
          )}
          title={labels
            .slice(visibleLabels.length)
            .map((label) => label.name)
            .join(", ")}
        >
          +{hiddenCount}
        </span>
      ) : null}
    </span>
  );
}

interface ThreadLabelPickerDialogProps {
  readonly open: boolean;
  readonly threadKeys: readonly string[];
  readonly targetLabel: string;
  readonly onOpenChange: (open: boolean) => void;
}

export function ThreadLabelPickerDialog({
  onOpenChange,
  open,
  targetLabel,
  threadKeys,
}: ThreadLabelPickerDialogProps) {
  const [mode, setMode] = useState<"pick" | "create">("pick");
  const [search, setSearch] = useState("");
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(DEFAULT_THREAD_LABEL_COLOR);
  const labels = useUiStateStore((state) => state.threadLabels);
  const threadLabelIdsByThreadKey = useUiStateStore((state) => state.threadLabelIdsByThreadKey);
  const createThreadLabel = useUiStateStore((state) => state.createThreadLabel);
  const setThreadLabelAssigned = useUiStateStore((state) => state.setThreadLabelAssigned);

  useEffect(() => {
    if (!open) return;
    setMode("pick");
    setSearch("");
    setName("");
    setColor(
      THREAD_LABEL_COLORS[labels.length % THREAD_LABEL_COLORS.length] ?? DEFAULT_THREAD_LABEL_COLOR,
    );
  }, [labels.length, open]);

  const filteredLabels = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return query.length === 0
      ? labels
      : labels.filter((label) => label.name.toLocaleLowerCase().includes(query));
  }, [labels, search]);
  const normalizedName = normalizeThreadLabelName(name);
  const duplicateLabel = labels.find(
    (label) => label.name.toLocaleLowerCase() === normalizedName.toLocaleLowerCase(),
  );

  const selectedCountForLabel = (labelId: string) =>
    threadKeys.reduce(
      (count, threadKey) =>
        count + (threadLabelIdsByThreadKey[threadKey]?.includes(labelId) ? 1 : 0),
      0,
    );

  const handleCreate = () => {
    if (!normalizedName) return;
    const labelId = createThreadLabel(normalizedName, color);
    if (!labelId) return;
    setThreadLabelAssigned(threadKeys, labelId, true);
    setMode("pick");
    setSearch(normalizedName);
    setName("");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md overflow-hidden" data-testid="thread-label-picker">
        <DialogHeader className="border-b border-border/70 pb-4">
          <DialogTitle>{mode === "create" ? "Create label" : "Add label"}</DialogTitle>
          <DialogDescription>
            {mode === "create"
              ? "Labels are reusable across chats in this browser."
              : `Choose labels for ${targetLabel}.`}
          </DialogDescription>
        </DialogHeader>

        {mode === "pick" ? (
          <>
            <DialogPanel className="space-y-3">
              <div className="relative">
                <SearchIcon
                  aria-hidden
                  className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-4 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search labels"
                  aria-label="Search labels"
                  className="[&_input]:pl-8"
                />
              </div>
              <div className="grid max-h-72 gap-1 overflow-y-auto" role="list">
                {filteredLabels.map((label) => {
                  const selectedCount = selectedCountForLabel(label.id);
                  const allSelected = threadKeys.length > 0 && selectedCount === threadKeys.length;
                  const partlySelected = selectedCount > 0 && !allSelected;
                  return (
                    <button
                      key={label.id}
                      type="button"
                      role="checkbox"
                      aria-checked={partlySelected ? "mixed" : allSelected}
                      className="group flex min-h-9 w-full cursor-pointer items-center gap-2 rounded-lg px-2 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => setThreadLabelAssigned(threadKeys, label.id, !allSelected)}
                      data-testid={`thread-label-option-${label.id}`}
                    >
                      <span
                        aria-hidden
                        className="size-3 shrink-0 rounded-full border border-black/10 dark:border-white/20"
                        style={{ backgroundColor: label.color }}
                      />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {label.name}
                      </span>
                      <span
                        className={cn(
                          "inline-flex size-5 shrink-0 items-center justify-center rounded border",
                          allSelected || partlySelected
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-input bg-background",
                        )}
                      >
                        {partlySelected ? (
                          <MinusIcon className="size-3" aria-hidden />
                        ) : allSelected ? (
                          <CheckIcon className="size-3" aria-hidden />
                        ) : null}
                      </span>
                    </button>
                  );
                })}
                {filteredLabels.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-muted-foreground">
                    <TagIcon className="size-5 opacity-60" aria-hidden />
                    <span>{labels.length === 0 ? "No labels yet" : "No matching labels"}</span>
                  </div>
                ) : null}
              </div>
              <Button
                type="button"
                variant="outline"
                className="w-full justify-start"
                onClick={() => {
                  setName(search);
                  setMode("create");
                }}
                data-testid="create-thread-label"
              >
                <PlusIcon />
                Create new label
              </Button>
            </DialogPanel>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogPanel className="space-y-5">
              <label className="grid gap-2">
                <span className="text-xs font-medium text-foreground">Label text</span>
                <Input
                  autoFocus
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && normalizedName) {
                      event.preventDefault();
                      handleCreate();
                    }
                  }}
                  maxLength={THREAD_LABEL_NAME_MAX_LENGTH}
                  placeholder="e.g. Research"
                  aria-label="Label text"
                  data-testid="thread-label-name"
                />
                <span className="text-[11px] text-muted-foreground">
                  {duplicateLabel
                    ? `“${duplicateLabel.name}” already exists and will be applied.`
                    : `${name.length}/${THREAD_LABEL_NAME_MAX_LENGTH} characters`}
                </span>
              </label>

              <div className="grid gap-2">
                <span className="text-xs font-medium text-foreground">Color</span>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <input
                    type="color"
                    value={color}
                    onChange={(event) => setColor(event.target.value.toLowerCase())}
                    aria-label="Custom label color"
                    className="h-8 w-10 cursor-pointer rounded-xl border border-input bg-background p-0.5"
                  />
                  <div className="flex flex-wrap gap-1.5">
                    {THREAD_LABEL_COLORS.map((swatch) => {
                      const selected = color === swatch;
                      return (
                        <button
                          key={swatch}
                          type="button"
                          className={cn(
                            "size-6 cursor-pointer rounded-full border transition",
                            selected
                              ? "scale-110 border-foreground ring-2 ring-ring ring-offset-1 ring-offset-background"
                              : "border-black/10 hover:scale-105 dark:border-white/20",
                          )}
                          style={{ backgroundColor: swatch }}
                          onClick={() => setColor(swatch)}
                          aria-label={`Use ${swatch} label color`}
                        />
                      );
                    })}
                  </div>
                </div>
              </div>

              <div className="grid gap-2">
                <span className="text-xs font-medium text-foreground">Preview</span>
                {normalizedName ? (
                  <ThreadLabelBadge label={{ id: "preview", name: normalizedName, color }} />
                ) : (
                  <span className="text-sm text-muted-foreground">Enter label text</span>
                )}
              </div>
            </DialogPanel>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setMode("pick");
                  setName("");
                }}
              >
                <ChevronLeftIcon />
                Back
              </Button>
              <Button disabled={!normalizedName} onClick={handleCreate}>
                {duplicateLabel ? "Apply label" : "Create and apply"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogPopup>
    </Dialog>
  );
}
