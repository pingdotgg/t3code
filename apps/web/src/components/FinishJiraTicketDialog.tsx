import { useCallback, useState } from "react";
import type { LinkedJiraTicket } from "@t3tools/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import {
  jiraMoveIssueMutationOptions,
  jiraAddCommentMutationOptions,
  jiraGenerateCompletionSummaryMutationOptions,
} from "~/lib/jiraReactQuery";
import { readNativeApi } from "~/nativeApi";
import { newCommandId } from "~/lib/utils";

interface FinishJiraTicketDialogProps {
  ticket: LinkedJiraTicket;
  threadId: string;
  onClose: () => void;
  onTicketUpdated: (ticket: LinkedJiraTicket) => void;
}

export function FinishJiraTicketDialog({
  ticket,
  threadId,
  onClose,
  onTicketUpdated,
}: FinishJiraTicketDialogProps) {
  const [targetStatus, setTargetStatus] = useState("Done");
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);

  const queryClient = useQueryClient();
  const moveMutation = useMutation(jiraMoveIssueMutationOptions({ queryClient }));
  const addCommentMutation = useMutation(jiraAddCommentMutationOptions({ queryClient }));
  const generateMutation = useMutation(jiraGenerateCompletionSummaryMutationOptions());

  const isPending = moveMutation.isPending || addCommentMutation.isPending;

  const handleGenerate = useCallback(async () => {
    try {
      const result = await generateMutation.mutateAsync({
        ticketKey: ticket.key,
        ticketTitle: ticket.title,
        fullConversation: "Full conversation context",
      });
      setComment(result.comment);
    } catch {
      // Silently fail generation
    }
  }, [ticket.key, ticket.title, generateMutation]);

  const handleFinish = useCallback(async () => {
    if (!targetStatus) return;
    setError(null);
    try {
      await moveMutation.mutateAsync({
        key: ticket.key,
        targetStatus,
      });

      if (comment.trim()) {
        await addCommentMutation.mutateAsync({
          key: ticket.key,
          comment: comment.trim(),
        });
      }

      const completedAt = new Date().toISOString();
      const updatedTicket: LinkedJiraTicket = {
        ...ticket,
        status: "completed",
        completedAt,
      };

      const api = readNativeApi();
      if (api) {
        void api.orchestration
          .dispatchCommand({
            type: "thread.meta.update",
            commandId: newCommandId(),
            threadId: threadId as any,
            linkedJiraTicket: updatedTicket,
          })
          .catch(() => undefined);
      }

      onTicketUpdated(updatedTicket);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to finish ticket.");
    }
  }, [
    ticket,
    threadId,
    targetStatus,
    comment,
    moveMutation,
    addCommentMutation,
    onTicketUpdated,
    onClose,
  ]);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Finish Ticket</DialogTitle>
        <DialogDescription>
          Transition {ticket.key} to done and post a final summary.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-3">
        <div className="rounded border p-3 text-sm">
          <p className="font-medium">
            {ticket.key}: {ticket.title}
          </p>
        </div>

        <Input
          placeholder="Target status (e.g. Done)"
          value={targetStatus}
          onChange={(e) => setTargetStatus(e.target.value)}
        />

        <Textarea
          placeholder="Final summary comment (optional)"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={4}
        />
        <Button
          variant="ghost"
          size="sm"
          onClick={handleGenerate}
          disabled={generateMutation.isPending}
        >
          {generateMutation.isPending ? "Generating..." : "Generate with AI"}
        </Button>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={handleFinish} disabled={!targetStatus || isPending}>
          {isPending ? "Finishing..." : "Finish Ticket"}
        </Button>
      </DialogFooter>
    </>
  );
}
