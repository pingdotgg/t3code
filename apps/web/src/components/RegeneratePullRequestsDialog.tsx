import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { ScrollArea } from "~/components/ui/scroll-area";
import type { RegeneratePullRequestCandidate } from "./GitActionsControl.logic";

export function RegeneratePullRequestsDialog({
  candidates,
  shortLabel,
  canRegenerate,
  isRegenerating,
  onRegenerate,
  onClose,
}: {
  readonly candidates: ReadonlyArray<RegeneratePullRequestCandidate>;
  readonly shortLabel: string;
  readonly canRegenerate: boolean;
  readonly isRegenerating: boolean;
  readonly onRegenerate: (
    selected: ReadonlyArray<RegeneratePullRequestCandidate>,
  ) => Promise<ReadonlyArray<{ readonly url: string; readonly message: string }>>;
  readonly onClose: () => void;
}) {
  const [selectedUrls, setSelectedUrls] = useState<ReadonlySet<string>>(new Set());
  const [failures, setFailures] = useState<ReadonlyArray<string>>([]);
  const allSelected = selectedUrls.size === candidates.length;
  const submit = async () => {
    const failed = await onRegenerate(
      candidates.filter((candidate) => selectedUrls.has(candidate.url)),
    );
    if (failed.length === 0) {
      onClose();
    } else {
      setSelectedUrls(new Set(failed.map((failure) => failure.url)));
      setFailures(failed.map((failure) => failure.message));
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !isRegenerating) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Regenerate {shortLabel} titles and descriptions</DialogTitle>
          <DialogDescription>
            Choose which requests to update. Generate a new title and description from each selected
            request&apos;s changes.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="overflow-hidden rounded-md border border-input bg-background">
            <div className="flex items-center justify-between border-b border-input bg-muted/40 px-3 py-2 text-xs">
              <label className="flex items-center gap-2 font-medium">
                <Checkbox
                  aria-label={`Select all ${shortLabel}s`}
                  disabled={isRegenerating}
                  checked={allSelected}
                  indeterminate={selectedUrls.size > 0 && !allSelected}
                  onCheckedChange={() =>
                    setSelectedUrls(
                      allSelected
                        ? new Set()
                        : new Set(candidates.map((candidate) => candidate.url)),
                    )
                  }
                />
                {shortLabel}s
              </label>
              <span className="text-muted-foreground">
                {selectedUrls.size} of {candidates.length} selected
              </span>
            </div>
            <ScrollArea className="h-72">
              <div className="divide-y divide-input">
                {candidates.map((candidate) => (
                  <label
                    key={candidate.url}
                    className="flex cursor-pointer items-start gap-3 px-3 py-2.5 transition-colors hover:bg-accent/50"
                  >
                    <Checkbox
                      aria-label={`Regenerate ${shortLabel} #${candidate.number}: ${candidate.title}`}
                      checked={selectedUrls.has(candidate.url)}
                      disabled={isRegenerating}
                      onCheckedChange={(checked) =>
                        setSelectedUrls((previous) => {
                          const next = new Set(previous);
                          if (checked) next.add(candidate.url);
                          else next.delete(candidate.url);
                          return next;
                        })
                      }
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{candidate.title}</span>
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {candidate.repository} #{candidate.number}
                        {candidate.headBranch && candidate.baseBranch
                          ? ` · ${candidate.headBranch} → ${candidate.baseBranch}`
                          : ""}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </ScrollArea>
          </div>
          {failures.length > 0 ? (
            <p role="alert" className="mt-3 whitespace-pre-line text-xs text-destructive">
              {failures.join("\n")}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" disabled={isRegenerating} onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!canRegenerate || isRegenerating || selectedUrls.size === 0}
            onClick={() => void submit()}
          >
            {isRegenerating ? "Regenerating..." : `Regenerate ${selectedUrls.size || ""}`.trim()}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
