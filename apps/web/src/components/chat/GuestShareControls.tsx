import {
  AuthOrchestrationOperateScope,
  type ChatAttachment,
  type GuestMessageId,
  type ScopedThreadRef,
  type ThreadGuestShare,
} from "@t3tools/contracts";
import { UserIcon } from "lucide-react";
import { useState } from "react";

import { useQuietThreadProjection } from "~/state/entities";
import { useEnvironmentScope } from "~/state/session";
import { threadEnvironment } from "~/state/threads";
import { cn } from "~/lib/utils";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { Button } from "../ui/button";
import { useAssetUrls } from "~/assets/assetUrls";
import { type ChatFileAttachment, isImageAttachment } from "../../types";
import { buildExpandedImagePreview, type ExpandedImagePreview } from "./ExpandedImagePreview";
import { GuestMessageAttachments } from "./GuestMessageAttachments";
import { GuestMessageName, guestBubbleClassName } from "./guestMessageStyle";

function useThreadGuestShare(threadRef: ScopedThreadRef | null): ThreadGuestShare | null {
  return useQuietThreadProjection(threadRef)?.projection.thread.guestShare ?? null;
}

/** A stored guest link. Guest links were removed, so the owner can only clear it. */
export function GuestShareIndicator({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const share = useThreadGuestShare(threadRef);
  const closeGuestShare = useOrchestrationCommand(threadEnvironment.closeGuestShare, {
    label: "stop guest share",
  });
  const [closing, setClosing] = useState(false);
  if (share === null) return null;
  return (
    <div className="flex shrink-0 items-center gap-1 text-muted-foreground text-xs">
      <UserIcon aria-hidden className="size-3.5" />
      <span>
        {share.guestName !== null ? `${share.guestName} was a guest` : "Inactive guest link"}
      </span>
      <Button
        size="xs"
        variant="ghost-muted"
        disabled={closing}
        onClick={async () => {
          setClosing(true);
          await closeGuestShare({
            environmentId: threadRef.environmentId,
            input: { threadId: threadRef.threadId },
          });
          setClosing(false);
        }}
      >
        Clear
      </Button>
    </div>
  );
}

/**
 * A guest's messages wait at the end of the timeline until the owner sends or dismisses each one.
 * Sent ones then show in the timeline as normal user messages with the guest's name.
 */
export function GuestPendingMessages({
  threadRef,
  onImageExpand,
  onFileOpen,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly onImageExpand: (preview: ExpandedImagePreview) => void;
  readonly onFileOpen: (attachment: ChatFileAttachment) => void;
}) {
  const share = useThreadGuestShare(threadRef);
  const canOperate = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope);
  const resolveGuestMessage = useOrchestrationCommand(threadEnvironment.resolveGuestMessage, {
    label: "resolve guest message",
  });
  const [busyIds, setBusyIds] = useState<ReadonlySet<GuestMessageId>>(new Set());
  const pending = share?.messages.filter((message) => message.status === "pending") ?? [];
  // The files are the thread's attachments, which the owner's environment serves like any other.
  const images = pending.flatMap((message) => message.attachments ?? []).filter(isImageAttachment);
  const imageUrls = useAssetUrls(
    threadRef.environmentId,
    images.map((image) => ({ _tag: "attachment" as const, attachmentId: image.id })),
  );
  const imageUrlById = new Map(
    images.flatMap((image, index) => {
      const url = imageUrls[index];
      return url ? [[image.id, url] as const] : [];
    }),
  );
  if (share === null || pending.length === 0) return null;
  const guestName = share.guestName ?? "Guest";
  const openImage = (attachment: ChatAttachment) => {
    const preview = buildExpandedImagePreview(
      images.map((image) => ({ ...image, previewUrl: imageUrlById.get(image.id) ?? "" })),
      attachment.id,
    );
    if (preview) onImageExpand(preview);
  };

  const resolve = async (guestMessageId: GuestMessageId, decision: "send" | "dismiss") => {
    setBusyIds((ids) => new Set(ids).add(guestMessageId));
    await resolveGuestMessage({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, guestMessageId, decision },
    });
    setBusyIds((ids) => {
      const next = new Set(ids);
      next.delete(guestMessageId);
      return next;
    });
  };

  return (
    <ol
      className="chat-content-lane flex flex-col gap-4 pb-4"
      aria-label={`${pending.length} guest message${pending.length === 1 ? "" : "s"} waiting`}
      aria-live="polite"
    >
      {pending.map((message) => {
        const busy = busyIds.has(message.id);
        return (
          <li key={message.id} className="flex flex-col items-end gap-1">
            <GuestMessageName name={guestName} />
            <div
              className={cn(
                "flex min-w-0 max-w-[80%] flex-col gap-2 rounded-2xl p-3 text-foreground",
                guestBubbleClassName(true),
              )}
            >
              <GuestMessageAttachments
                attachments={message.attachments ?? []}
                imageUrl={(attachment) => imageUrlById.get(attachment.id)}
                onOpenImage={openImage}
                onOpenFile={onFileOpen}
              />
              {message.text ? (
                <p className="text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {message.text}
                </p>
              ) : null}
            </div>
            {canOperate ? (
              <div className="flex items-center gap-1 pe-1">
                <Button
                  size="xs"
                  variant="ghost-muted"
                  disabled={busy}
                  aria-label={`Dismiss message from ${guestName}`}
                  onClick={() => void resolve(message.id, "dismiss")}
                >
                  Dismiss
                </Button>
                <Button
                  size="xs"
                  disabled={busy}
                  aria-label={`Send message from ${guestName}`}
                  onClick={() => void resolve(message.id, "send")}
                >
                  Send
                </Button>
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
