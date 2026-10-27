import { type EnvironmentId, type MessageId, type ThreadId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { type Dispatch, type SetStateAction, useEffect } from "react";
import { selectHandoffImageResources } from "../../session-logic";
import type { useQuietThreadVisibleTurnItems } from "../../state/entities";
import { useAssetUrls } from "../../assets/assetUrls";
import {
  dropOptimisticHandoff,
  loadedHandoffMessageIdsAtom,
  type OptimisticBlobPreviews,
  type OptimisticUserMessages,
} from "./optimisticUserMessages";

interface AttachmentPreviewHandoffInput {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly serverVisibleTurnItems: ReturnType<typeof useQuietThreadVisibleTurnItems>;
  /** Blob previews of acknowledged messages, by message id; they stand in for the server's copy. */
  readonly handoff: OptimisticUserMessages["handoff"];
  readonly blobPreviews: OptimisticBlobPreviews;
  readonly setOptimisticUserMessages: Dispatch<SetStateAction<OptimisticUserMessages>>;
}

/**
 * A sent image keeps showing its local blob preview until the server's copy has loaded, so the
 * timeline does not flash an empty frame. The handoff ends, and its blobs are revoked, once the
 * server previews load.
 */
export function useAttachmentPreviewHandoff(input: AttachmentPreviewHandoffInput) {
  const {
    environmentId,
    threadId,
    serverVisibleTurnItems,
    blobPreviews,
    setOptimisticUserMessages,
  } = input;
  const handoffByMessageId = input.handoff;

  // Blob URLs are a browser resource owned per thread; leaving the thread or the view ends them.
  useEffect(() => () => blobPreviews.revokeThread(threadId), [blobPreviews, threadId]);

  const serverAttachmentResources = selectHandoffImageResources(
    Object.keys(handoffByMessageId).length === 0
      ? undefined
      : serverVisibleTurnItems.flatMap(({ item }) =>
          item.type === "user_message"
            ? [{ id: item.messageId, role: "user" as const, attachments: item.attachments }]
            : [],
        ),
    handoffByMessageId,
  );
  const serverAttachmentUrls = useAssetUrls(environmentId, serverAttachmentResources);
  const serverAttachmentUrlById = new Map(
    serverAttachmentResources.flatMap((resource, index) => {
      const url = serverAttachmentUrls[index];
      return url ? [[resource.attachmentId, url] as const] : [];
    }),
  );

  // Each handoff whose server previews are all minted, as [messageId, serverUrls, blobUrls].
  const pendingPreloads: Array<readonly [MessageId, ReadonlyArray<string>, ReadonlyArray<string>]> =
    [];
  for (const row of serverVisibleTurnItems) {
    if (row.item.type !== "user_message") continue;
    const handoffUrls = handoffByMessageId[row.item.messageId];
    if (handoffUrls === undefined || row.item.attachments.length === 0) continue;
    const serverPreviewUrls = row.item.attachments.flatMap((attachment) => {
      if (attachment.type !== "image") return [];
      const url = serverAttachmentUrlById.get(attachment.id);
      return url === undefined ? [] : [url];
    });
    if (
      serverPreviewUrls.length === 0 ||
      serverPreviewUrls.length !== handoffUrls.length ||
      serverPreviewUrls.some((previewUrl) => previewUrl.startsWith("blob:"))
    ) {
      continue;
    }
    pendingPreloads.push([row.item.messageId, serverPreviewUrls, handoffUrls]);
  }
  const loadedHandoffMessageIds = useAtomValue(
    loadedHandoffMessageIdsAtom(JSON.stringify(pendingPreloads)),
  );
  // The handoff is state of the rendering ChatView, so dropping a loaded one here is React's
  // adjust-state-while-rendering pattern; the preload atom has already revoked its blobs.
  if (loadedHandoffMessageIds.length > 0) {
    setOptimisticUserMessages((state) =>
      loadedHandoffMessageIds.reduce(
        (next, messageId) => dropOptimisticHandoff(next, threadId, messageId),
        state,
      ),
    );
  }

  const timelineAttachmentUrlById = (() => {
    const urls = new Map(serverAttachmentUrlById);
    for (const row of serverVisibleTurnItems) {
      if (row.item.type !== "user_message") continue;
      const handoffUrls = handoffByMessageId[row.item.messageId];
      if (handoffUrls === undefined) continue;
      let imageIndex = 0;
      for (const attachment of row.item.attachments) {
        if (attachment.type !== "image") continue;
        const handoffUrl = handoffUrls[imageIndex];
        imageIndex += 1;
        if (handoffUrl !== undefined) urls.set(attachment.id, handoffUrl);
      }
    }
    return urls;
  })();
  return { timelineAttachmentUrlById };
}
