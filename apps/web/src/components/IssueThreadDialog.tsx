import type { EnvironmentId, GitResolvedIssue } from "@t3tools/contracts";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { CircleDotIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { readCachedIssueResolution, useIssueResolution } from "~/lib/sourceControlActions";
import { parseIssueReference } from "~/issueReference";
import { cn } from "~/lib/utils";
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
import { Spinner } from "./ui/spinner";

interface IssueThreadDialogProps {
  readonly open: boolean;
  readonly environmentId: EnvironmentId;
  readonly cwd: string | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onResolved: (issue: GitResolvedIssue) => Promise<boolean> | boolean;
}

export function IssueThreadDialog({
  open,
  environmentId,
  cwd,
  onOpenChange,
  onResolved,
}: IssueThreadDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [reference, setReference] = useState("");
  const [referenceDirty, setReferenceDirty] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [debouncedReference, referenceDebouncer] = useDebouncedValue(
    reference,
    { wait: 450 },
    (state) => ({ isPending: state.isPending }),
  );

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const parsedReference = parseIssueReference(reference);
  const parsedDebouncedReference = parseIssueReference(debouncedReference);
  const scope = useMemo(() => ({ environmentId, cwd }), [cwd, environmentId]);
  const resolution = useIssueResolution({
    ...scope,
    reference: open ? parsedDebouncedReference : null,
  });
  const cachedIssue = useMemo(
    () => readCachedIssueResolution({ ...scope, reference: parsedReference })?.issue ?? null,
    [parsedReference, scope],
  );
  const liveIssue =
    parsedReference !== null && parsedReference === parsedDebouncedReference
      ? (resolution.data?.issue ?? null)
      : null;
  const issue = liveIssue ?? cachedIssue;
  const isResolving =
    open &&
    parsedReference !== null &&
    issue === null &&
    (referenceDebouncer.state.isPending ||
      parsedReference !== parsedDebouncedReference ||
      resolution.isPending ||
      resolution.isFetching);

  const handleConfirm = async () => {
    if (!parsedReference) {
      setReferenceDirty(true);
      return;
    }
    if (!issue || isResolving || isCreating) return;
    setIsCreating(true);
    const didCreateThread = await onResolved(issue);
    setIsCreating(false);
    if (didCreateThread) onOpenChange(false);
  };

  const validationMessage = !referenceDirty
    ? null
    : reference.trim().length === 0
      ? "Paste a GitHub issue URL or enter 123 / #123."
      : parsedReference === null
        ? "Use a GitHub issue URL, 123, or #123."
        : null;
  const errorMessage =
    validationMessage ??
    (issue === null && resolution.error
      ? typeof resolution.error === "string"
        ? resolution.error
        : "Unable to resolve this issue."
      : null);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isCreating) onOpenChange(nextOpen);
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CircleDotIcon className="size-4" />
            Triage an issue
          </DialogTitle>
          <DialogDescription>
            Resolve a GitHub issue, then create a focused triage thread without sending it yet.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Issue</span>
            <Input
              ref={inputRef}
              placeholder="GitHub issue URL or #42"
              value={reference}
              onChange={(event) => {
                setReferenceDirty(true);
                setReference(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                void handleConfirm();
              }}
            />
          </label>

          {issue ? (
            <div className="rounded-xl border border-border/70 bg-muted/24 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{issue.title}</p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    #{issue.number}
                    {issue.labels.length > 0 ? ` · ${issue.labels.join(", ")}` : ""}
                  </p>
                </div>
                <span
                  className={cn(
                    "shrink-0 text-xs capitalize",
                    issue.state === "open"
                      ? "text-emerald-600 dark:text-emerald-300/90"
                      : "text-zinc-500 dark:text-zinc-400/80",
                  )}
                >
                  {issue.state}
                </span>
              </div>
            </div>
          ) : null}

          {isResolving ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner className="size-3.5" />
              Resolving issue...
            </div>
          ) : null}

          {errorMessage ? <p className="text-xs text-destructive">{errorMessage}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={isCreating}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void handleConfirm()}
            disabled={!issue || isResolving || isCreating}
          >
            {isCreating ? "Creating thread..." : "Create triage thread"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
