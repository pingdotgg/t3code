import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  offlineMessages,
  useOfflineMessages,
  deliverOfflineMessages,
  cancelOfflineMessage,
} from "../../state/offlineMessages";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

export function OfflineMessages({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const messages = useOfflineMessages().filter(
    (message) => message.environmentId === environmentId && message.input.threadId === threadId,
  );
  if (messages.length === 0) return null;
  const report = (error: unknown) =>
    toastManager.add({
      type: "error",
      title: "Could not update offline queue",
      description: error instanceof Error ? error.message : undefined,
    });
  return (
    <section
      aria-label="Offline messages"
      className="chat-content-lane max-h-64 space-y-2 overflow-y-auto py-2"
    >
      <p className="text-xs text-muted-foreground">
        {messages.length} queued offline · Sends automatically when connected
      </p>
      {messages.map((message) => {
        const id = message.input.message.messageId;
        const sending = offlineMessages.isSending(id);
        return (
          <div key={id} className="flex items-center gap-2 rounded-lg border p-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">
                {replaceComposerContextReferences(
                  message.input.message.text,
                  (reference) => reference.label,
                )}
              </p>
              {message.attachments.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {message.attachments.length}{" "}
                  {message.attachments.length === 1 ? "attachment" : "attachments"}
                </p>
              )}
              {message.error && (
                <p role="alert" className="text-xs text-destructive">
                  {message.error}
                </p>
              )}
              {sending && <p className="text-xs text-muted-foreground">Sending…</p>}
            </div>
            {message.error && (
              <Button
                size="sm"
                variant="ghost"
                disabled={sending}
                onClick={() => {
                  void offlineMessages.retry(id).then(deliverOfflineMessages).catch(report);
                }}
              >
                Retry
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={sending}
              onClick={() => {
                void cancelOfflineMessage(id).then(deliverOfflineMessages).catch(report);
              }}
            >
              Cancel
            </Button>
          </div>
        );
      })}
    </section>
  );
}
