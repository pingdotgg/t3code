import type { EnvironmentApi } from "@t3tools/contracts";
import type {
  ImportableWorkItemView,
  ListImportableWorkItemsResult,
} from "@t3tools/contracts/workSource";
import { BoardId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { toastManager } from "~/components/ui/toast";
import {
  applyPickerFilters,
  defaultChecked,
  groupSelectedBySource,
  selectionKey,
  type FilterState,
} from "~/workflow/importPicker";

// ─── Sub-components ──────────────────────────────────────────────────────────

function ItemRow({
  row,
  checked,
  onToggle,
}: {
  readonly row: ImportableWorkItemView;
  readonly checked: boolean;
  readonly onToggle: () => void;
}) {
  const isMapped = row.mappedTicketId !== null;
  const isClosed = row.lifecycle === "closed";
  const isDeleted = row.lifecycle === "deleted";
  const disabled = isMapped || isDeleted;

  return (
    <li className="flex items-start gap-3 rounded-md border border-border/60 bg-card/30 px-3 py-2">
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={disabled ? undefined : () => onToggle()}
        aria-label={`Select ${row.title}`}
        className="mt-0.5 shrink-0"
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-medium text-muted-foreground">{row.displayRef}</span>
          <span className="truncate text-xs font-medium text-foreground">{row.title}</span>
          {isMapped && row.mappedLane !== null ? (
            <Badge variant="info" size="sm">
              On board · {row.mappedLane}
            </Badge>
          ) : null}
          {isClosed ? (
            <Badge variant="secondary" size="sm">
              closed
            </Badge>
          ) : null}
          {isDeleted ? (
            <Badge variant="warning" size="sm">
              deleted
            </Badge>
          ) : null}
        </div>
        {row.container || row.assignees.length > 0 ? (
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {row.container}
            {row.container && row.assignees.length > 0 ? " · " : ""}
            {row.assignees.join(", ")}
          </p>
        ) : null}
      </div>
    </li>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function AddFromIssuesDialog(props: {
  readonly boardId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onImported: () => void;
  readonly api: EnvironmentApi | null | undefined;
}) {
  const { boardId, open, onOpenChange, onImported, api } = props;

  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [result, setResult] = useState<ListImportableWorkItemsResult | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<FilterState>({
    search: "",
    assignedToMe: false,
    hideTasked: false,
  });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Guards an in-flight submit against the dialog closing / unmounting mid-flight,
  // mirroring the load effect's `cancelled` flag. `reset()` flips `aborted` so a
  // late-resolving import never writes state into a torn-down/reopened dialog.
  const submitGuardRef = useRef<{ aborted: boolean }>({ aborted: false });

  // Load items when the dialog opens (or boardId changes while open)
  useEffect(() => {
    if (!open || !api) {
      return;
    }

    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setResult(null);
    setChecked(new Set());
    setFilter({ search: "", assignedToMe: false, hideTasked: false });
    setSubmitError(null);

    void api.workflow
      .listImportableWorkItems({ boardId: BoardId.make(boardId) })
      .then((res) => {
        if (cancelled) return;
        const initialChecked = new Set<string>();
        for (const item of res.items) {
          if (defaultChecked(item)) {
            initialChecked.add(selectionKey(item));
          }
        }
        setResult(res);
        setChecked(initialChecked);
      })
      .catch((cause) => {
        if (cancelled) return;
        setLoadError(cause instanceof Error ? cause.message : "Failed to load work items.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, boardId, api]);

  const reset = () => {
    submitGuardRef.current.aborted = true;
    setLoading(false);
    setLoadError(null);
    setResult(null);
    setChecked(new Set());
    setFilter({ search: "", assignedToMe: false, hideTasked: false });
    setSubmitting(false);
    setSubmitError(null);
  };

  const handleAdd = async () => {
    if (!api || checked.size === 0 || submitting) return;

    const guard = { aborted: false };
    submitGuardRef.current = guard;
    setSubmitting(true);
    setSubmitError(null);

    const groups = groupSelectedBySource(checked);
    let importedTotal = 0;
    let skippedTotal = 0;
    const failures: string[] = [];

    // Each source imports independently: a later source throwing must not discard
    // the tickets an earlier source already created. We accumulate across all
    // sources, then decide the outcome from the totals + collected failures.
    for (const [sourceId, externalIds] of Object.entries(groups)) {
      try {
        const res = await api.workflow.importWorkItems({
          boardId: BoardId.make(boardId),
          sourceId,
          externalIds,
        });
        importedTotal += res.imported.length;
        skippedTotal += res.skipped.length;
      } catch (cause) {
        const label = sourceById.get(sourceId)?.container ?? sourceId;
        const detail = cause instanceof Error ? cause.message : "Import failed.";
        failures.push(`${label}: ${detail}`);
      }
    }

    if (guard.aborted) return;

    // Partial success still refreshes the board so the tickets that landed show up.
    if (importedTotal > 0) {
      onImported();
      toastManager.add({
        type: "success",
        title: `Added ${importedTotal} item${importedTotal === 1 ? "" : "s"}${
          skippedTotal > 0 ? ` (${skippedTotal} already on board or out of scope)` : ""
        }`,
      });
    }

    if (failures.length > 0) {
      // Keep the dialog open so the user sees which source(s) failed.
      setSubmitError(failures.join(" "));
      setSubmitting(false);
      return;
    }

    setSubmitting(false);
    handleOpenChange(false);
  };

  const toggleItem = (key: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const visibleItems =
    result !== null ? applyPickerFilters(result.items, filter, result.viewer) : [];

  const sources = result?.sources ?? [];
  const truncated = result?.truncated ?? {};
  const sourceErrors = result?.sourceErrors ?? {};

  // Lookup so per-source notices (and submit failures) can name the source by its
  // container (e.g. "owner/repo") rather than an opaque source id.
  const sourceById = new Map(sources.map((s) => [s.sourceId, s]));

  const checkedCount = checked.size;
  const addDisabled = checkedCount === 0 || submitting;

  // Single close path: forwards to the parent and resets local state (which also
  // aborts any in-flight submit). The Cancel button and the Dialog's own close
  // affordances (Esc / backdrop) both route through here so reset runs exactly once.
  const handleOpenChange = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen) {
      reset();
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPopup className="max-h-[calc(100dvh-2rem)] max-w-2xl overflow-hidden">
        <div className="flex min-h-0 flex-col">
          <DialogHeader>
            <DialogTitle>Add from issues</DialogTitle>
          </DialogHeader>

          <div
            className="min-h-0 flex-1 space-y-3 overflow-y-auto px-6 pt-1 pb-3"
            data-slot="dialog-panel"
          >
            {/* Search / filter bar */}
            {!loading && !loadError && result !== null && sources.length > 0 ? (
              <div className="space-y-2">
                <Input
                  value={filter.search}
                  onChange={(e) => {
                    const value = e.currentTarget.value;
                    setFilter((f) => ({ ...f, search: value }));
                  }}
                  placeholder="Search or paste a URL…"
                  aria-label="Search or paste a URL"
                />
                <div className="flex flex-wrap items-center gap-3 text-xs">
                  <label className="flex cursor-pointer items-center gap-1.5 text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={filter.assignedToMe}
                      onChange={(e) => {
                        const checked = e.currentTarget.checked;
                        setFilter((f) => ({ ...f, assignedToMe: checked }));
                      }}
                      className="size-3.5 rounded border-input"
                    />
                    Assigned to me
                  </label>
                  <label className="flex cursor-pointer items-center gap-1.5 text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={filter.hideTasked}
                      onChange={(e) => {
                        const checked = e.currentTarget.checked;
                        setFilter((f) => ({ ...f, hideTasked: checked }));
                      }}
                      className="size-3.5 rounded border-input"
                    />
                    Hide already on board
                  </label>
                </div>
              </div>
            ) : null}

            {/* Loading state */}
            {loading ? <p className="text-xs text-muted-foreground">Loading…</p> : null}

            {/* Load error state */}
            {!loading && loadError !== null ? (
              <p className="text-xs text-destructive-foreground" role="alert">
                {loadError}
              </p>
            ) : null}

            {/* No sources configured */}
            {!loading && loadError === null && result !== null && sources.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                This board has no configured work sources.
              </p>
            ) : null}

            {/* Items list */}
            {!loading && loadError === null && result !== null && sources.length > 0 ? (
              <>
                {/* Per-source errors */}
                {Object.entries(sourceErrors).map(([sourceId, msg]) =>
                  msg ? (
                    <p key={sourceId} className="text-xs text-destructive-foreground" role="alert">
                      {sourceById.get(sourceId)?.container ?? sourceId}: {msg}
                    </p>
                  ) : null,
                )}

                {/* Per-source truncated notices */}
                {Object.entries(truncated).map(([sourceId, isTruncated]) =>
                  isTruncated ? (
                    <p key={sourceId} className="text-xs text-muted-foreground">
                      {sourceById.get(sourceId)?.container ?? sourceId}: showing first results only
                      — refine your filters to see more.
                    </p>
                  ) : null,
                )}

                {visibleItems.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No importable items found.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {visibleItems.map((row) => {
                      const key = selectionKey(row);
                      return (
                        <ItemRow
                          key={key}
                          row={row}
                          checked={checked.has(key)}
                          onToggle={() => toggleItem(key)}
                        />
                      );
                    })}
                  </ul>
                )}
              </>
            ) : null}

            {/* Submit error */}
            {submitError !== null ? (
              <p className="text-xs text-destructive-foreground" role="alert">
                {submitError}
              </p>
            ) : null}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                handleOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={addDisabled}
              onClick={() => {
                void handleAdd();
              }}
            >
              {submitting
                ? "Adding…"
                : checkedCount > 0
                  ? `Add ${checkedCount} item${checkedCount === 1 ? "" : "s"}`
                  : "Add"}
            </Button>
          </DialogFooter>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
