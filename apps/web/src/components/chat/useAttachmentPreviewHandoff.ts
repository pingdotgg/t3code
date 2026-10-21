import { useStableCallback } from "../../hooks/useStableCallback";
import { type EnvironmentId, type MessageId } from "@t3tools/contracts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { selectHandoffImageResources } from "../../session-logic";
import { type ChatMessage } from "../../types";
import type { useThreadVisibleTurnItems } from "../../state/entities";
import { revokeBlobPreviewUrl, revokeUserMessagePreviewUrls } from "../ChatView.logic";
import { useAssetUrls } from "../../assets/assetUrls";
interface AttachmentPreviewHandoffInput {
  readonly environmentId: EnvironmentId;
  readonly serverVisibleTurnItems: ReturnType<typeof useThreadVisibleTurnItems>;
  readonly optimisticUserMessages: ReadonlyArray<ChatMessage>;
}

/**
 * A sent image keeps showing its local blob preview until the server's copy has loaded, so the
 * timeline does not flash an empty frame. Returns the attachment URLs the timeline renders and
 * the handoff for a message whose optimistic row was replaced by the server's.
 */
export function useAttachmentPreviewHandoff(input: AttachmentPreviewHandoffInput) {
  const { environmentId, serverVisibleTurnItems, optimisticUserMessages } = input;

  const optimisticUserMessagesRef = useRef(optimisticUserMessages);
  useLayoutEffect(() => {
    optimisticUserMessagesRef.current = optimisticUserMessages;
  });
  const [attachmentPreviewHandoffByMessageId, setAttachmentPreviewHandoffByMessageId] = useState<
    Record<string, string[]>
  >({});
  const attachmentPreviewHandoffByMessageIdRef = useRef<Record<string, string[]>>({});
  const attachmentPreviewPromotionInFlightByMessageIdRef = useRef<Record<string, true>>({});
  useEffect(() => {
    attachmentPreviewHandoffByMessageIdRef.current = attachmentPreviewHandoffByMessageId;
  }, [attachmentPreviewHandoffByMessageId]);
  const clearAttachmentPreviewHandoff = (
    messageId: MessageId,
    previewUrls?: ReadonlyArray<string>,
  ) => {
    delete attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId];
    const currentPreviewUrls =
      previewUrls ?? attachmentPreviewHandoffByMessageIdRef.current[messageId] ?? [];
    setAttachmentPreviewHandoffByMessageId((existing) => {
      if (!(messageId in existing)) {
        return existing;
      }
      const next = { ...existing };
      delete next[messageId];
      attachmentPreviewHandoffByMessageIdRef.current = next;
      return next;
    });
    for (const previewUrl of currentPreviewUrls) {
      revokeBlobPreviewUrl(previewUrl);
    }
  };
  const clearAttachmentPreviewHandoffStable = useStableCallback(clearAttachmentPreviewHandoff);
  const clearAttachmentPreviewHandoffs = () => {
    attachmentPreviewPromotionInFlightByMessageIdRef.current = {};
    for (const previewUrls of Object.values(attachmentPreviewHandoffByMessageIdRef.current)) {
      for (const previewUrl of previewUrls) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    attachmentPreviewHandoffByMessageIdRef.current = {};
    setAttachmentPreviewHandoffByMessageId({});
  };
  const clearAttachmentPreviewHandoffsStable = useStableCallback(clearAttachmentPreviewHandoffs);
  useEffect(() => {
    return () => {
      clearAttachmentPreviewHandoffsStable();
      for (const message of optimisticUserMessagesRef.current) {
        revokeUserMessagePreviewUrls(message);
      }
    };
  }, [clearAttachmentPreviewHandoffsStable]);
  const handoffAttachmentPreviews = (messageId: MessageId, previewUrls: string[]) => {
    if (previewUrls.length === 0) return;

    const previousPreviewUrls = attachmentPreviewHandoffByMessageIdRef.current[messageId] ?? [];
    const nextPreviewUrlSet = new Set(previewUrls);
    for (const previewUrl of previousPreviewUrls) {
      if (!nextPreviewUrlSet.has(previewUrl)) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    setAttachmentPreviewHandoffByMessageId((existing) => {
      const next = {
        ...existing,
        [messageId]: previewUrls,
      };
      attachmentPreviewHandoffByMessageIdRef.current = next;
      return next;
    });
  };
  const handoffAttachmentPreviewsStable = useStableCallback(handoffAttachmentPreviews);
  const serverAttachmentResources = selectHandoffImageResources(
    Object.keys(attachmentPreviewHandoffByMessageId).length === 0
      ? undefined
      : serverVisibleTurnItems.flatMap(({ item }) =>
          item.type === "user_message"
            ? [{ id: item.messageId, role: "user" as const, attachments: item.attachments }]
            : [],
        ),
    attachmentPreviewHandoffByMessageId,
  );
  const serverAttachmentUrls = useAssetUrls(environmentId, serverAttachmentResources);
  const serverAttachmentUrlById = new Map(
    serverAttachmentResources.flatMap((resource, index) => {
      const url = serverAttachmentUrls[index];
      return url ? [[resource.attachmentId, url] as const] : [];
    }),
  );
  useEffect(() => {
    if (typeof Image === "undefined" || serverVisibleTurnItems.length === 0) {
      return;
    }

    const cleanups: Array<() => void> = [];
    const userMessagesById = new Map(
      serverVisibleTurnItems.flatMap((row) =>
        row.item.type === "user_message" ? [[String(row.item.messageId), row.item] as const] : [],
      ),
    );

    for (const [messageId, handoffPreviewUrls] of Object.entries(
      attachmentPreviewHandoffByMessageId,
    )) {
      if (attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId]) {
        continue;
      }

      const serverMessage = userMessagesById.get(messageId);
      if (serverMessage === undefined || serverMessage.attachments.length === 0) {
        continue;
      }

      const serverPreviewUrls = serverMessage.attachments.flatMap((attachment) =>
        attachment.type === "image"
          ? [serverAttachmentUrlById.get(attachment.id)].filter(
              (previewUrl): previewUrl is string => previewUrl !== undefined,
            )
          : [],
      );
      if (
        serverPreviewUrls.length === 0 ||
        serverPreviewUrls.length !== handoffPreviewUrls.length ||
        serverPreviewUrls.some((previewUrl) => previewUrl.startsWith("blob:"))
      ) {
        continue;
      }

      attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId] = true;

      let cancelled = false;
      const imageInstances: HTMLImageElement[] = [];

      const preloadServerPreviews = Promise.all(
        serverPreviewUrls.map(
          (previewUrl) =>
            new Promise<void>((resolve, reject) => {
              const image = new Image();
              imageInstances.push(image);
              const handleLoad = () => resolve();
              const handleError = () =>
                reject(new Error(`Failed to load server preview for ${messageId}.`));
              image.addEventListener("load", handleLoad, { once: true });
              image.addEventListener("error", handleError, { once: true });
              image.src = previewUrl;
            }),
        ),
      );

      void preloadServerPreviews
        .then(() => {
          if (cancelled) {
            return;
          }
          clearAttachmentPreviewHandoffStable(messageId as MessageId, handoffPreviewUrls);
        })
        .catch(() => {
          if (!cancelled) {
            delete attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId];
          }
        });

      cleanups.push(() => {
        cancelled = true;
        delete attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId];
        for (const image of imageInstances) {
          image.src = "";
        }
      });
    }

    return () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  }, [
    attachmentPreviewHandoffByMessageId,
    clearAttachmentPreviewHandoffStable,
    serverAttachmentUrlById,
    serverVisibleTurnItems,
  ]);
  const timelineAttachmentUrlById = (() => {
    const urls = new Map(serverAttachmentUrlById);
    for (const row of serverVisibleTurnItems) {
      if (row.item.type !== "user_message") continue;
      const handoffUrls = attachmentPreviewHandoffByMessageId[row.item.messageId];
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
  return {
    handoffAttachmentPreviewsStable,
    timelineAttachmentUrlById,
  };
}
