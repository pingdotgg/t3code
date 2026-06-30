import type {
  EnvironmentApi,
  OrchestrationMessage,
  OrchestrationThreadActivity,
  OrchestrationThreadStreamItem,
  ThreadId,
} from "@t3tools/contracts";
import { MessagesSquareIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { cn } from "~/lib/utils";

interface SessionState {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
}

/**
 * Upsert by id, preserving first-seen order. A streaming message is re-emitted
 * under the same id as it grows, so replace in place; genuinely new messages
 * (or activities) append. Mirrors StepActivityFeed's dedup-by-id behaviour.
 */
function upsertById<T extends { readonly id: unknown }>(
  current: ReadonlyArray<T>,
  incoming: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const next = [...current];
  for (const item of incoming) {
    const index = next.findIndex((existing) => existing.id === item.id);
    if (index === -1) {
      next.push(item);
    } else {
      next[index] = item;
    }
  }
  return next;
}

/**
 * Read-only view of the hidden orchestration thread behind an agent step —
 * the full conversation (instruction, assistant replies) plus the activity
 * log. Total transparency into what the agent actually did.
 */
export function AgentSessionDialog({
  api,
  threadId,
  stepKey,
}: {
  readonly api: EnvironmentApi | null | undefined;
  readonly threadId: ThreadId;
  readonly stepKey: string;
}) {
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState<SessionState | null>(null);

  useEffect(() => {
    if (!open || !api) {
      return;
    }
    setSession(null);
    return api.orchestration.subscribeThread(
      { threadId },
      (item: OrchestrationThreadStreamItem) => {
        if (item.kind === "snapshot") {
          setSession({
            messages: item.snapshot.thread.messages,
            activities: item.snapshot.thread.activities,
          });
          return;
        }
        // After the initial snapshot only incremental events arrive (the server
        // never re-snapshots). Fold message/activity events into the transcript
        // so a still-running step's session stays live instead of frozen.
        if (item.event.type === "thread.message-sent") {
          const { messageId, role, text, attachments, turnId, streaming, createdAt, updatedAt } =
            item.event.payload;
          const message: OrchestrationMessage = {
            id: messageId,
            role,
            text,
            ...(attachments === undefined ? {} : { attachments }),
            turnId,
            streaming,
            createdAt,
            updatedAt,
          };
          setSession((current) =>
            current === null
              ? current
              : { ...current, messages: upsertById(current.messages, [message]) },
          );
          return;
        }
        if (item.event.type === "thread.activity-appended") {
          const { activity } = item.event.payload;
          setSession((current) =>
            current === null
              ? current
              : { ...current, activities: upsertById(current.activities, [activity]) },
          );
        }
      },
    );
  }, [api, open, threadId]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={!api}
        title="View the agent's full session for this step"
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
      >
        <MessagesSquareIcon className="size-3.5" />
        View agent session
      </Button>
      <DialogPopup className="max-h-[calc(100dvh-2rem)] max-w-3xl overflow-hidden">
        <div className="flex min-h-0 flex-col">
          <DialogHeader>
            <DialogTitle>Agent session · {stepKey}</DialogTitle>
            <DialogDescription>
              Read-only transcript of the agent run behind this step.
            </DialogDescription>
          </DialogHeader>
          <div
            className="min-h-0 flex-1 space-y-3 overflow-y-auto px-6 pt-1 pb-4"
            data-testid="agent-session-transcript"
          >
            {session === null ? (
              <p className="text-sm text-muted-foreground">Loading session…</p>
            ) : (
              <>
                {session.messages.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No messages recorded.</p>
                ) : (
                  <ol className="space-y-2">
                    {session.messages.map((message) => (
                      <li
                        key={message.id as string}
                        className={cn(
                          "rounded-md border border-border/60 p-2.5",
                          message.role === "user" ? "bg-accent/20" : "bg-background/70",
                        )}
                      >
                        <div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                          <span className="font-medium uppercase tracking-wide">
                            {message.role === "user" ? "Instruction" : "Agent"}
                          </span>
                          <time dateTime={message.createdAt}>
                            {new Date(message.createdAt).toLocaleTimeString()}
                          </time>
                        </div>
                        <p className="whitespace-pre-wrap text-xs leading-5 text-foreground">
                          {message.text}
                        </p>
                      </li>
                    ))}
                  </ol>
                )}
                {session.activities.length > 0 ? (
                  <details>
                    <summary className="cursor-pointer text-xs text-muted-foreground select-none">
                      Activity log ({session.activities.length})
                    </summary>
                    <ol className="mt-2 space-y-1">
                      {session.activities.map((activity) => (
                        <li
                          key={activity.id as string}
                          className="flex items-baseline gap-2 text-[11px] text-muted-foreground"
                        >
                          <span className="shrink-0 font-medium">{activity.kind}</span>
                          <span className="truncate">{activity.summary}</span>
                        </li>
                      ))}
                    </ol>
                  </details>
                ) : null}
              </>
            )}
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
