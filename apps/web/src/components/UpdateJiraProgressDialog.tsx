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
import { Textarea } from "~/components/ui/textarea";
import {
  jiraAddCommentMutationOptions,
  jiraGenerateProgressCommentMutationOptions,
} from "~/lib/jiraReactQuery";

interface UpdateJiraProgressDialogProps {
  ticket: LinkedJiraTicket;
  onClose: () => void;
}

export function UpdateJiraProgressDialog({
  ticket,
  onClose,
}: UpdateJiraProgressDialogProps) {
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);

  const queryClient = useQueryClient();
  const addCommentMutation = useMutation(jiraAddCommentMutationOptions({ queryClient }));
  const generateMutation = useMutation(jiraGenerateProgressCommentMutationOptions());

  const handleGenerate = useCallback(async () => {
    try {
      const result = await generateMutation.mutateAsync({
        ticketKey: ticket.key,
        ticketTitle: ticket.title,
        recentConversation: "Recent conversation context",
      });
      setComment(result.comment);
    } catch {
      // Silently fail generation
    }
  }, [ticket.key, ticket.title, generateMutation]);

  const handleSubmit = useCallback(async () => {
    if (!comment.trim()) return;
    setError(null);
    try {
      await addCommentMutation.mutateAsync({
        key: ticket.key,
        comment: comment.trim(),
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to post comment.");
    }
  }, [ticket.key, comment, addCommentMutation, onClose]);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Update Progress</DialogTitle>
        <DialogDescription>
          Post a progress comment to {ticket.key}: {ticket.title}
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-3">
        <Textarea
          placeholder="Write a progress update..."
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={6}
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
        <Button
          onClick={handleSubmit}
          disabled={!comment.trim() || addCommentMutation.isPending}
        >
          {addCommentMutation.isPending ? "Posting..." : "Post Comment"}
        </Button>
      </DialogFooter>
    </>
  );
}
