import { type ModelSelection, type OrchestrationThread } from "@t3tools/contracts";
import { buildThreadHandoffMarkdown } from "@t3tools/client-runtime/handoff";
import { ArrowRightIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { Spinner } from "../ui/spinner";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import type { ProviderInstanceEntry } from "../../providerInstances";

export interface ThreadHandoffContentProps {
  readonly sourceThread: OrchestrationThread;
  readonly targetModelSelection: ModelSelection;
  readonly providerInstanceEntries?: ReadonlyArray<ProviderInstanceEntry> | undefined;
  readonly isSubmitting?: boolean | undefined;
  readonly onCancel?: (() => void) | undefined;
  readonly onConfirmHandoff: (
    handoffMarkdown: string,
    targetModelSelection: ModelSelection,
  ) => Promise<void> | void;
}

export function ThreadHandoffContent({
  sourceThread,
  targetModelSelection,
  providerInstanceEntries,
  isSubmitting = false,
  onCancel,
  onConfirmHandoff,
}: ThreadHandoffContentProps) {
  const [handoffText, setHandoffText] = useState(() =>
    buildThreadHandoffMarkdown({
      thread: sourceThread,
      targetModelSelection,
    }),
  );

  const isUserDirtyRef = useRef(false);
  const targetKeyRef = useRef(`${targetModelSelection.instanceId}:${targetModelSelection.model}`);

  const sourceEntry = useMemo(() => {
    const instanceId = sourceThread.modelSelection?.instanceId;
    return providerInstanceEntries?.find((entry) => entry.instanceId === instanceId) ?? null;
  }, [providerInstanceEntries, sourceThread.modelSelection?.instanceId]);

  const targetEntry = useMemo(() => {
    return (
      providerInstanceEntries?.find(
        (entry) => entry.instanceId === targetModelSelection.instanceId,
      ) ?? null
    );
  }, [providerInstanceEntries, targetModelSelection]);

  useEffect(() => {
    const currentTargetKey = `${targetModelSelection.instanceId}:${targetModelSelection.model}`;
    if (targetKeyRef.current !== currentTargetKey || !isUserDirtyRef.current) {
      targetKeyRef.current = currentTargetKey;
      const generated = buildThreadHandoffMarkdown({
        thread: sourceThread,
        targetModelSelection,
      });
      setHandoffText(generated);
    }
  }, [sourceThread, targetModelSelection]);

  const handleConfirm = useCallback(() => {
    return onConfirmHandoff(handoffText, targetModelSelection);
  }, [handoffText, onConfirmHandoff, targetModelSelection]);

  const sourceModelLabel = sourceThread.modelSelection?.model ?? "Current model";
  const targetModelLabel = targetModelSelection.model;

  return (
    <>
      <DialogHeader>
        <DialogTitle>Continue in new thread</DialogTitle>
        <DialogDescription>
          Switch to a different model with a structured handoff of your current progress. The
          original thread remains untouched.
        </DialogDescription>
      </DialogHeader>

      <DialogPanel className="space-y-4">
        <div className="flex items-center justify-between rounded-lg border bg-muted/40 p-3">
          <div className="flex items-center gap-2.5">
            {sourceEntry && (
              <ProviderInstanceIcon
                driverKind={sourceEntry.driverKind}
                displayName={sourceEntry.displayName}
                className="size-5 shrink-0"
              />
            )}
            <div className="flex flex-col">
              <span className="text-xs font-medium text-muted-foreground">From</span>
              <span className="text-sm font-semibold">{sourceModelLabel}</span>
            </div>
          </div>

          <ArrowRightIcon className="size-4 text-muted-foreground" />

          <div className="flex items-center gap-2.5">
            {targetEntry && (
              <ProviderInstanceIcon
                driverKind={targetEntry.driverKind}
                displayName={targetEntry.displayName}
                className="size-5 shrink-0"
              />
            )}
            <div className="flex flex-col items-end">
              <span className="text-xs font-medium text-muted-foreground">To</span>
              <span className="text-sm font-semibold text-primary">{targetModelLabel}</span>
            </div>
          </div>
        </div>

        <div className="space-y-1.5">
          <label
            htmlFor="handoff-context-textarea"
            className="text-xs font-medium text-muted-foreground"
          >
            Handoff context (editable)
          </label>
          <Textarea
            id="handoff-context-textarea"
            value={handoffText}
            onChange={(e) => {
              isUserDirtyRef.current = true;
              setHandoffText(e.target.value);
            }}
            rows={12}
            className="font-mono text-xs leading-relaxed"
            placeholder="Structured context to be sent to the new model..."
          />
        </div>
      </DialogPanel>

      <DialogFooter>
        <Button variant="outline" disabled={isSubmitting} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="default"
          disabled={isSubmitting || handoffText.trim().length === 0}
          onClick={handleConfirm}
        >
          {isSubmitting ? (
            <>
              <Spinner className="mr-2 size-4" />
              Starting thread...
            </>
          ) : (
            `Continue with ${targetModelLabel}`
          )}
        </Button>
      </DialogFooter>
    </>
  );
}

export interface ThreadHandoffDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly sourceThread: OrchestrationThread;
  readonly targetModelSelection: ModelSelection | null;
  readonly providerInstanceEntries?: ReadonlyArray<ProviderInstanceEntry> | undefined;
  readonly onConfirmHandoff: (
    handoffMarkdown: string,
    targetModelSelection: ModelSelection,
  ) => Promise<void> | void;
}

export function ThreadHandoffDialog({
  open,
  onOpenChange,
  sourceThread,
  targetModelSelection,
  providerInstanceEntries,
  onConfirmHandoff,
}: ThreadHandoffDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleConfirm = useCallback(
    async (handoffMarkdown: string, selection: ModelSelection) => {
      if (isSubmitting) return;
      setIsSubmitting(true);
      try {
        await onConfirmHandoff(handoffMarkdown, selection);
        onOpenChange(false);
      } finally {
        setIsSubmitting(false);
      }
    },
    [isSubmitting, onConfirmHandoff, onOpenChange],
  );

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (isSubmitting) return;
      onOpenChange(nextOpen);
    },
    [isSubmitting, onOpenChange],
  );

  if (!targetModelSelection) {
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPopup className="max-w-2xl" showCloseButton={!isSubmitting}>
        <ThreadHandoffContent
          sourceThread={sourceThread}
          targetModelSelection={targetModelSelection}
          providerInstanceEntries={providerInstanceEntries}
          isSubmitting={isSubmitting}
          onCancel={() => handleOpenChange(false)}
          onConfirmHandoff={handleConfirm}
        />
      </DialogPopup>
    </Dialog>
  );
}
