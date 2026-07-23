"use client";

import {
  CheckIcon,
  ChevronLeftIcon,
  MinusIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  TagIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
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
  const [mode, setMode] = useState<"pick" | "create" | "edit">("pick");
  const [search, setSearch] = useState("");
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(DEFAULT_THREAD_LABEL_COLOR);
  const [editingLabelId, setEditingLabelId] = useState<string | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const wasOpenRef = useRef(false);
  const labels = useUiStateStore((state) => state.threadLabels);
  const threadLabelIdsByThreadKey = useUiStateStore((state) => state.threadLabelIdsByThreadKey);
  const createThreadLabel = useUiStateStore((state) => state.createThreadLabel);
  const updateThreadLabel = useUiStateStore((state) => state.updateThreadLabel);
  const deleteThreadLabel = useUiStateStore((state) => state.deleteThreadLabel);
  const setThreadLabelAssigned = useUiStateStore((state) => state.setThreadLabelAssigned);

  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (!justOpened) return;
    setMode("pick");
    setSearch("");
    setName("");
    setEditingLabelId(null);
    setDeleteConfirmOpen(false);
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
  const editingLabel = labels.find((label) => label.id === editingLabelId) ?? null;
  const normalizedName = normalizeThreadLabelName(name);
  const duplicateLabel = labels.find(
    (label) =>
      label.id !== editingLabelId &&
      label.name.toLocaleLowerCase() === normalizedName.toLocaleLowerCase(),
  );
  const hasEditorChanges =
    editingLabel !== null &&
    (editingLabel.name !== normalizedName || editingLabel.color !== color.toLocaleLowerCase());

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

  const handleSave = () => {
    if (!editingLabelId || !normalizedName || duplicateLabel || !hasEditorChanges) return;
    if (!updateThreadLabel(editingLabelId, normalizedName, color)) return;
    setMode("pick");
    setEditingLabelId(null);
    setName("");
  };

  const handleDelete = () => {
    if (!editingLabelId) return;
    deleteThreadLabel(editingLabelId);
    setDeleteConfirmOpen(false);
    setMode("pick");
    setEditingLabelId(null);
    setName("");
  };

  const startCreate = () => {
    setEditingLabelId(null);
    setName(search);
    setColor(
      THREAD_LABEL_COLORS[labels.length % THREAD_LABEL_COLORS.length] ?? DEFAULT_THREAD_LABEL_COLOR,
    );
    setMode("create");
  };

  const startEdit = (label: ThreadLabel) => {
    setEditingLabelId(label.id);
    setName(label.name);
    setColor(label.color);
    setMode("edit");
  };

  const returnToPicker = () => {
    setMode("pick");
    setEditingLabelId(null);
    setName("");
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setDeleteConfirmOpen(false);
    }
    onOpenChange(nextOpen);
  };

  const isEditing = mode === "edit";

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogPopup className="max-w-sm overflow-hidden" data-testid="thread-label-picker">
          <DialogHeader className="gap-1 px-4 pt-4 pr-12 pb-2">
            <DialogTitle className="text-base leading-5">
              {mode === "pick" ? "Add label" : isEditing ? "Edit label" : "Create label"}
            </DialogTitle>
            <DialogDescription className="truncate text-xs" title={targetLabel}>
              {mode === "pick"
                ? `Choose labels for ${targetLabel}.`
                : isEditing
                  ? "Rename the label or change its color."
                  : "Create a reusable label for your chats."}
            </DialogDescription>
          </DialogHeader>

          {mode === "pick" ? (
            <>
              <DialogPanel className="space-y-2 px-3 pt-1 pb-3" scrollFade={false}>
                <div className="relative">
                  <SearchIcon
                    aria-hidden
                    className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-muted-foreground"
                  />
                  <Input
                    type="search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search labels"
                    aria-label="Search labels"
                    size="sm"
                    className="[&_input]:pl-8"
                  />
                </div>
                <div className="grid max-h-64 gap-0.5 overflow-y-auto" role="list">
                  {filteredLabels.map((label) => {
                    const selectedCount = selectedCountForLabel(label.id);
                    const allSelected =
                      threadKeys.length > 0 && selectedCount === threadKeys.length;
                    const partlySelected = selectedCount > 0 && !allSelected;
                    return (
                      <div
                        key={label.id}
                        className="group flex min-h-8 items-center rounded-md transition-colors hover:bg-accent focus-within:bg-accent"
                      >
                        <button
                          type="button"
                          role="checkbox"
                          aria-checked={partlySelected ? "mixed" : allSelected}
                          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 self-stretch rounded-md px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={() => setThreadLabelAssigned(threadKeys, label.id, !allSelected)}
                          data-testid={`thread-label-option-${label.id}`}
                        >
                          <span
                            aria-hidden
                            className="size-2.5 shrink-0 rounded-full border border-black/10 dark:border-white/20"
                            style={{ backgroundColor: label.color }}
                          />
                          <span className="min-w-0 flex-1 truncate text-sm">{label.name}</span>
                          <span
                            className={cn(
                              "inline-flex size-4 shrink-0 items-center justify-center rounded-[5px] border",
                              allSelected || partlySelected
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-input bg-background/80",
                            )}
                          >
                            {partlySelected ? (
                              <MinusIcon className="size-2.5" aria-hidden />
                            ) : allSelected ? (
                              <CheckIcon className="size-2.5" aria-hidden />
                            ) : null}
                          </span>
                        </button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          className="mr-1 opacity-55 group-hover:opacity-100 focus-visible:opacity-100"
                          onClick={() => startEdit(label)}
                          aria-label={`Edit label ${label.name}`}
                          title={`Edit ${label.name}`}
                          data-testid={`edit-thread-label-${label.id}`}
                        >
                          <PencilIcon />
                        </Button>
                      </div>
                    );
                  })}
                  {filteredLabels.length === 0 ? (
                    <div className="flex items-center justify-center gap-2 py-5 text-center text-xs text-muted-foreground">
                      <TagIcon className="size-4 opacity-60" aria-hidden />
                      <span>{labels.length === 0 ? "No labels yet" : "No matching labels"}</span>
                    </div>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-md border-t border-border/60 px-2 pt-1.5 text-left text-sm outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={startCreate}
                  data-testid="create-thread-label"
                >
                  <PlusIcon className="size-4 text-muted-foreground" />
                  Create label
                </button>
              </DialogPanel>
              <DialogFooter className="flex-row justify-end px-3 py-2">
                <Button size="sm" onClick={() => handleOpenChange(false)}>
                  Done
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogPanel className="space-y-3 px-4 pt-1 pb-4" scrollFade={false}>
                <label className="grid gap-1.5">
                  <span className="text-xs font-medium text-foreground">Label text</span>
                  <Input
                    autoFocus
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    onKeyDown={(event) => {
                      if (
                        event.key === "Enter" &&
                        normalizedName &&
                        (!isEditing || (!duplicateLabel && hasEditorChanges))
                      ) {
                        event.preventDefault();
                        if (isEditing) {
                          handleSave();
                        } else {
                          handleCreate();
                        }
                      }
                    }}
                    size="sm"
                    maxLength={THREAD_LABEL_NAME_MAX_LENGTH}
                    placeholder="e.g. Research"
                    aria-label="Label text"
                    data-testid="thread-label-name"
                  />
                  <span
                    className={cn(
                      "text-[11px]",
                      duplicateLabel ? "text-destructive" : "text-muted-foreground",
                    )}
                  >
                    {duplicateLabel
                      ? isEditing
                        ? `“${duplicateLabel.name}” already exists.`
                        : `“${duplicateLabel.name}” already exists and will be applied.`
                      : `${name.length}/${THREAD_LABEL_NAME_MAX_LENGTH} characters`}
                  </span>
                </label>

                <div className="grid gap-1.5">
                  <span className="text-xs font-medium text-foreground">Color</span>
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <input
                      type="color"
                      value={color}
                      onChange={(event) => setColor(event.target.value.toLowerCase())}
                      aria-label="Custom label color"
                      className="size-7 cursor-pointer rounded-md border border-input bg-background p-0.5"
                    />
                    <div className="flex flex-wrap gap-1">
                      {THREAD_LABEL_COLORS.map((swatch) => {
                        const selected = color === swatch;
                        return (
                          <button
                            key={swatch}
                            type="button"
                            className={cn(
                              "size-5 cursor-pointer rounded-full border transition-shadow",
                              selected
                                ? "border-foreground ring-2 ring-ring ring-offset-1 ring-offset-background"
                                : "border-black/10 hover:ring-2 hover:ring-ring/40 dark:border-white/20",
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

                <div className="flex min-h-6 items-center justify-between gap-3 border-t border-border/60 pt-3">
                  <span className="text-xs font-medium text-foreground">Preview</span>
                  {normalizedName ? (
                    <ThreadLabelBadge label={{ id: "preview", name: normalizedName, color }} />
                  ) : (
                    <span className="text-xs text-muted-foreground">Enter label text</span>
                  )}
                </div>
              </DialogPanel>
              <DialogFooter className="flex-row items-center px-3 py-2">
                {isEditing ? (
                  <Button
                    size="sm"
                    variant="destructive-outline"
                    className="mr-auto"
                    onClick={() => setDeleteConfirmOpen(true)}
                    data-testid="delete-thread-label"
                  >
                    <Trash2Icon />
                    Delete
                  </Button>
                ) : null}
                <Button size="sm" variant="outline" onClick={returnToPicker}>
                  <ChevronLeftIcon />
                  Back
                </Button>
                <Button
                  size="sm"
                  disabled={
                    !normalizedName ||
                    (isEditing ? Boolean(duplicateLabel) || !hasEditorChanges : false)
                  }
                  onClick={isEditing ? handleSave : handleCreate}
                  data-testid={isEditing ? "save-thread-label" : "submit-thread-label"}
                >
                  {isEditing ? "Save" : duplicateLabel ? "Apply" : "Create & apply"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogPopup>
      </Dialog>

      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogPopup className="max-w-sm">
          <AlertDialogHeader className="gap-1 px-4 py-4">
            <AlertDialogTitle className="text-base leading-5">
              Delete “{editingLabel?.name ?? "label"}”?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-xs">
              This removes the label from every chat. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-row justify-end px-4 py-3">
            <AlertDialogClose render={<Button size="sm" variant="outline" />}>
              Cancel
            </AlertDialogClose>
            <Button
              size="sm"
              variant="destructive"
              onClick={handleDelete}
              data-testid="confirm-delete-thread-label"
            >
              Delete label
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
