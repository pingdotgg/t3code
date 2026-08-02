import type { ScopedThreadRef, ServerProviderSkill } from "@t3tools/contracts";

import { deriveDisplayedUserMessageState } from "~/lib/terminalContext";
import type { ChatMessage } from "~/types";
import ChatMarkdown from "../ChatMarkdown";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import { MessageImageAttachments } from "./MessageImageAttachments";

export function MessageSurface({
  message,
  threadRef,
  cwd,
  skills,
  onImageExpand,
}: {
  message: ChatMessage | null;
  threadRef: ScopedThreadRef;
  cwd: string | undefined;
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  onImageExpand: (preview: ExpandedImagePreview) => void;
}) {
  if (!message) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6" data-message-surface>
        <div className="text-center">
          <p className="text-sm font-medium text-foreground">Message unavailable</p>
          <p className="mt-1 text-xs text-muted-foreground">
            This message is no longer in the thread.
          </p>
        </div>
      </div>
    );
  }

  const text =
    message.role === "user"
      ? deriveDisplayedUserMessageState(message.text).visibleText
      : message.text;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-message-surface>
      <div className="mx-auto w-full max-w-3xl px-5 py-5">
        <MessageImageAttachments
          images={message.attachments ?? []}
          onImageExpand={onImageExpand}
          className="mb-4"
        />
        <ChatMarkdown text={text} cwd={cwd} threadRef={threadRef} skills={skills} />
      </div>
    </div>
  );
}
