import { useCallback, useState } from "react";
import type { LinkedJiraTicket } from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
  jiraCreateIssueMutationOptions,
  jiraViewIssueQueryOptions,
  jiraGenerateTicketContentMutationOptions,
} from "~/lib/jiraReactQuery";
import { readNativeApi } from "~/nativeApi";
import { newCommandId } from "~/lib/utils";

interface CreateJiraTicketDialogProps {
  threadId: string;
  onClose: () => void;
  onTicketLinked: (ticket: LinkedJiraTicket) => void;
}

type Mode = "link" | "create";

export function CreateJiraTicketDialog({
  threadId,
  onClose,
  onTicketLinked,
}: CreateJiraTicketDialogProps) {
  const [mode, setMode] = useState<Mode>("link");
  const [keyInput, setKeyInput] = useState("");
  const [projectKey, setProjectKey] = useState("");
  const [issueType, setIssueType] = useState("Task");
  const [priority, setPriority] = useState("Medium");
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);

  const queryClient = useQueryClient();
  const createMutation = useMutation(jiraCreateIssueMutationOptions({ queryClient }));
  const generateMutation = useMutation(jiraGenerateTicketContentMutationOptions());

  const parsedKey = extractJiraKey(keyInput.trim());
  const issueQuery = useQuery(jiraViewIssueQueryOptions(parsedKey));

  const dispatchLink = useCallback(
    (ticket: LinkedJiraTicket) => {
      const api = readNativeApi();
      if (api) {
        void api.orchestration
          .dispatchCommand({
            type: "thread.meta.update",
            commandId: newCommandId(),
            threadId: threadId as any,
            linkedJiraTicket: ticket,
          })
          .catch(() => undefined);
      }
      onTicketLinked(ticket);
      onClose();
    },
    [threadId, onTicketLinked, onClose],
  );

  const linkExistingTicket = useCallback(() => {
    if (!issueQuery.data) return;
    dispatchLink({
      key: issueQuery.data.key,
      url: issueQuery.data.url,
      title: issueQuery.data.summary,
      status: "active",
      linkedAt: new Date().toISOString(),
    });
  }, [issueQuery.data, dispatchLink]);

  const handleCreate = useCallback(async () => {
    if (!projectKey || !summary) return;
    setError(null);
    try {
      const result = await createMutation.mutateAsync({
        projectKey,
        type: issueType,
        priority,
        summary,
        description,
      });
      dispatchLink({
        key: result.key,
        url: result.url,
        title: summary,
        status: "active",
        linkedAt: new Date().toISOString(),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create issue.");
    }
  }, [projectKey, issueType, priority, summary, description, createMutation, dispatchLink]);

  const handleGenerate = useCallback(async () => {
    if (!projectKey) return;
    try {
      const result = await generateMutation.mutateAsync({
        conversationContext: "Current conversation context",
        projectKey,
      });
      setSummary(result.summary);
      setDescription(result.description);
    } catch {
      // Silently fail generation
    }
  }, [projectKey, generateMutation]);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Link Jira Ticket</DialogTitle>
        <DialogDescription>Link an existing ticket or create a new one.</DialogDescription>
      </DialogHeader>

      <div className="flex gap-2 mb-4">
        <Button
          variant={mode === "link" ? "default" : "ghost"}
          size="sm"
          onClick={() => setMode("link")}
        >
          Link Existing
        </Button>
        <Button
          variant={mode === "create" ? "default" : "ghost"}
          size="sm"
          onClick={() => setMode("create")}
        >
          Create New
        </Button>
      </div>

      {mode === "link" ? (
        <div className="space-y-3">
          <Input
            placeholder="PROJ-123 or Jira URL"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
          />
          {issueQuery.isLoading && (
            <p className="text-xs text-muted-foreground">Looking up issue...</p>
          )}
          {issueQuery.data && (
            <div className="rounded border p-3 text-sm">
              <p className="font-medium">
                {issueQuery.data.key}: {issueQuery.data.summary}
              </p>
              <p className="text-muted-foreground text-xs mt-1">
                {issueQuery.data.type} &middot; {issueQuery.data.status} &middot;{" "}
                {issueQuery.data.priority}
              </p>
            </div>
          )}
          {issueQuery.isError && (
            <p className="text-xs text-destructive">Could not find issue.</p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex gap-2">
            <Input
              placeholder="Project Key (e.g. PROJ)"
              value={projectKey}
              onChange={(e) => setProjectKey(e.target.value.toUpperCase())}
              className="flex-1"
            />
            <Input
              placeholder="Type"
              value={issueType}
              onChange={(e) => setIssueType(e.target.value)}
              className="w-24"
            />
            <Input
              placeholder="Priority"
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
              className="w-24"
            />
          </div>
          <Input
            placeholder="Summary"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
          />
          <Textarea
            placeholder="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={handleGenerate}
            disabled={!projectKey || generateMutation.isPending}
          >
            {generateMutation.isPending ? "Generating..." : "Generate with AI"}
          </Button>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      )}

      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        {mode === "link" ? (
          <Button onClick={linkExistingTicket} disabled={!issueQuery.data}>
            Link Ticket
          </Button>
        ) : (
          <Button
            onClick={handleCreate}
            disabled={!projectKey || !summary || createMutation.isPending}
          >
            {createMutation.isPending ? "Creating..." : "Create & Link"}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

function extractJiraKey(input: string): string | null {
  if (!input) return null;
  const keyMatch = /([A-Z][A-Z0-9]+-\d+)/.exec(input);
  return keyMatch?.[1] ?? null;
}
