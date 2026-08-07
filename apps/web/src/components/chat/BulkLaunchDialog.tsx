import { useEffect, useMemo, useState } from "react";

import {
  expandBulkPrompts,
  MAX_BULK_THREADS,
  parseBulkPlaceholders,
  splitBulkValues,
  type BulkPromptRow,
} from "~/lib/bulkPrompt";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Textarea } from "../ui/textarea";

export interface BulkLaunchSummaryItem {
  readonly label: string;
  readonly value: string;
}

interface BulkLaunchDialogProps {
  readonly open: boolean;
  readonly prompt: string;
  readonly summary: ReadonlyArray<BulkLaunchSummaryItem>;
  /** Non-null while threads are being started, so the dialog can report progress. */
  readonly progress: { readonly completed: number; readonly total: number } | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: (rows: ReadonlyArray<BulkPromptRow>) => void;
  readonly onCancelLaunch: () => void;
}

function describeExpansionError(
  expansion: Exclude<ReturnType<typeof expandBulkPrompts>, { ok: true }>,
): string | null {
  switch (expansion.reason) {
    case "no-placeholders":
      return "This prompt has no {placeholder} to fill.";
    case "missing-values":
      // The empty field is the obvious next action, so this stays quiet.
      return null;
    case "length-mismatch":
      return `{${expansion.placeholder}} has ${expansion.actual} values but ${expansion.expected} threads are being started. Use one value per thread, or a single value for all of them.`;
  }
}

export function BulkLaunchDialog({
  open,
  prompt,
  summary,
  progress,
  onOpenChange,
  onConfirm,
  onCancelLaunch,
}: BulkLaunchDialogProps) {
  const placeholders = useMemo(() => parseBulkPlaceholders(prompt), [prompt]);
  const [rawValues, setRawValues] = useState<Record<string, string>>({});

  // Each send starts from empty fields; keeping the previous batch's values
  // around would silently re-launch them.
  useEffect(() => {
    if (open) {
      setRawValues({});
    }
  }, [open]);

  const expansion = useMemo(
    () =>
      expandBulkPrompts({
        text: prompt,
        valuesByPlaceholder: Object.fromEntries(
          placeholders.map((placeholder) => [
            placeholder.name,
            splitBulkValues(rawValues[placeholder.name] ?? ""),
          ]),
        ),
      }),
    [placeholders, prompt, rawValues],
  );

  const rows = expansion.ok ? expansion.rows : [];
  const overLimit = rows.length > MAX_BULK_THREADS;
  const errorMessage = expansion.ok
    ? overLimit
      ? `${rows.length} threads is over the limit of ${MAX_BULK_THREADS} per bulk send.`
      : null
    : describeExpansionError(expansion);
  const isLaunching = progress !== null;
  const canConfirm = expansion.ok && rows.length > 0 && !overLimit && !isLaunching;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isLaunching) {
          onOpenChange(nextOpen);
        }
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Start bulk threads</DialogTitle>
          <DialogDescription>
            Every thread runs the same prompt and settings, with one value filled in per thread.
            They start one after another so the worktrees and setup scripts do not pile up.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="rounded-xl border border-border/70 bg-muted/24 p-3">
            <p className="whitespace-pre-wrap break-words font-mono text-xs">{prompt}</p>
          </div>

          {placeholders.map((placeholder) => (
            <label className="grid gap-1.5" key={placeholder.name}>
              <span className="font-medium text-foreground text-xs">{`{${placeholder.name}}`}</span>
              <Textarea
                autoFocus={placeholder === placeholders[0]}
                disabled={isLaunching}
                onChange={(event) =>
                  setRawValues((current) => ({
                    ...current,
                    [placeholder.name]: event.target.value,
                  }))
                }
                placeholder="FE-101, FE-102, FE-103"
                rows={2}
                value={rawValues[placeholder.name] ?? ""}
              />
            </label>
          ))}

          {summary.length > 0 ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted-foreground text-xs">
              {summary.map((item) => (
                <div className="contents" key={item.label}>
                  <dt>{item.label}</dt>
                  <dd className="truncate text-foreground">{item.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}

          {errorMessage ? <p className="text-destructive text-xs">{errorMessage}</p> : null}

          {isLaunching ? (
            <p className="text-muted-foreground text-xs">
              Started {progress.completed} of {progress.total} threads...
            </p>
          ) : rows.length > 0 && !overLimit ? (
            <p className="text-muted-foreground text-xs">
              Starts {rows.length} {rows.length === 1 ? "thread" : "threads"}:{" "}
              <span className="text-foreground">{rows.map((row) => row.label).join(", ")}</span>
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            onClick={() => (isLaunching ? onCancelLaunch() : onOpenChange(false))}
            size="sm"
            type="button"
            variant="outline"
          >
            {isLaunching ? "Stop starting" : "Cancel"}
          </Button>
          <Button disabled={!canConfirm} onClick={() => onConfirm(rows)} size="sm" type="button">
            {isLaunching
              ? "Starting..."
              : `Start ${rows.length > 0 ? rows.length : ""} ${
                  rows.length === 1 ? "thread" : "threads"
                }`.replace(/\s+/g, " ")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
