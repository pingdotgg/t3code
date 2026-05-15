import { SearchIcon, Undo2Icon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { MessageId } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";

import { formatTimestamp } from "../../timestampFormat";
import { cn } from "~/lib/utils";
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
import { Input } from "../ui/input";
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";
import type { RewindCheckpointCandidate } from "./MessagesTimeline.logic";
import {
  checkpointRewindLabel,
  filterRewindCheckpointCandidates,
  isRewindRestoreDisabled,
  promptPreview,
} from "./RewindCheckpointDialog.logic";

interface RewindCheckpointDialogProps {
  open: boolean;
  candidates: ReadonlyArray<RewindCheckpointCandidate>;
  selectedUserMessageId?: MessageId | null;
  disabledReason?: string | null;
  isReverting: boolean;
  timestampFormat: TimestampFormat;
  onOpenChange: (open: boolean) => void;
  onRestore: (candidate: RewindCheckpointCandidate) => void;
}

export function RewindCheckpointDialog({
  open,
  candidates,
  selectedUserMessageId = null,
  disabledReason = null,
  isReverting,
  timestampFormat,
  onOpenChange,
  onRestore,
}: RewindCheckpointDialogProps) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<MessageId | null>(selectedUserMessageId);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    if (wasOpenRef.current) {
      return;
    }
    wasOpenRef.current = true;
    setQuery("");
    setSelectedId(selectedUserMessageId ?? candidates[0]?.userMessageId ?? null);
  }, [candidates, open, selectedUserMessageId]);

  useEffect(() => {
    if (!open || !selectedUserMessageId) {
      return;
    }
    setSelectedId(selectedUserMessageId);
  }, [open, selectedUserMessageId]);

  const filteredCandidates = useMemo(() => {
    return filterRewindCheckpointCandidates(candidates, query);
  }, [candidates, query]);

  useEffect(() => {
    if (!open) {
      return;
    }
    if (filteredCandidates.some((candidate) => candidate.userMessageId === selectedId)) {
      return;
    }
    setSelectedId(filteredCandidates[0]?.userMessageId ?? null);
  }, [filteredCandidates, open, selectedId]);

  const selectedCandidate =
    filteredCandidates.find((candidate) => candidate.userMessageId === selectedId) ?? null;
  const restoreDisabled = isRewindRestoreDisabled({
    isReverting,
    disabledReason,
    selected: selectedCandidate,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Rewind checkpoint</DialogTitle>
          <DialogDescription>Restore code and conversation to an earlier prompt.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/65" />
            <Input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search prompts"
              className="pl-9"
            />
          </div>
          {disabledReason && (
            <div className="rounded-md border border-border/70 bg-muted/45 px-3 py-2 text-xs text-muted-foreground">
              {disabledReason}
            </div>
          )}
          {candidates.length === 0 ? (
            <div className="flex min-h-40 items-center justify-center rounded-md border border-dashed border-border/70 px-4 text-center text-sm text-muted-foreground">
              No checkpoints yet.
            </div>
          ) : filteredCandidates.length === 0 ? (
            <div className="flex min-h-40 items-center justify-center rounded-md border border-dashed border-border/70 px-4 text-center text-sm text-muted-foreground">
              No matching checkpoints.
            </div>
          ) : (
            <div className="max-h-80 space-y-1 overflow-y-auto pr-1">
              {filteredCandidates.map((candidate) => {
                const selected = candidate.userMessageId === selectedId;
                const hasStats = hasNonZeroStat({
                  additions: candidate.additions,
                  deletions: candidate.deletions,
                });
                return (
                  <button
                    key={candidate.userMessageId}
                    type="button"
                    className={cn(
                      "flex w-full min-w-0 items-start gap-3 rounded-md border px-3 py-2 text-left transition-colors",
                      selected
                        ? "border-border bg-accent text-accent-foreground"
                        : "border-border/70 bg-background/70 hover:border-border hover:bg-accent/45",
                    )}
                    onClick={() => setSelectedId(candidate.userMessageId)}
                  >
                    <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background/60 text-muted-foreground">
                      <Undo2Icon className="size-3.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {promptPreview(candidate.prompt)}
                      </span>
                      <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                        <span>{checkpointRewindLabel(candidate.turnCount)}</span>
                        <span>{formatTimestamp(candidate.createdAt, timestampFormat)}</span>
                        {candidate.changedFileCount > 0 && (
                          <span>
                            {candidate.changedFileCount}{" "}
                            {candidate.changedFileCount === 1 ? "file" : "files"}
                          </span>
                        )}
                        {hasStats && (
                          <DiffStatLabel
                            additions={candidate.additions}
                            deletions={candidate.deletions}
                          />
                        )}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          <div className="mr-auto self-center text-xs text-muted-foreground">
            Code and conversation
          </div>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={restoreDisabled}
            onClick={() => {
              if (!selectedCandidate) {
                return;
              }
              onRestore(selectedCandidate);
            }}
          >
            Restore
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
