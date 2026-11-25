import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type EnvironmentId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { useRef, useState } from "react";
import { View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { downloadAttachmentForPreview } from "../../lib/attachmentDownload";
import {
  removePersistedComposerAttachmentFile,
  persistComposerAttachmentFile,
  type DraftComposerImageAttachment,
} from "../../lib/composerImages";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { refreshAssetUrl } from "../../state/assets";
import {
  appendComposerDraftAttachments,
  appendComposerDraftText,
  getComposerDraftSnapshot,
} from "../../state/use-composer-drafts";

export function RecoveredProviderQueue(props: {
  readonly item: Extract<OrchestrationV2TurnItem, { type: "system_notice" }>;
  readonly environmentId: EnvironmentId;
  readonly canRestore: boolean;
}) {
  const gt = useGT();
  const { item, environmentId } = props;
  const [status, setStatus] = useState<"idle" | "restoring" | "restored">("idle");
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const queue = item.recoveredQueue;
  if (!queue) return null;
  const text = queue.entries
    .map((entry) => entry.text)
    .filter(Boolean)
    .join("\n\n");
  const attachments = queue.entries.flatMap((entry) => entry.attachments);
  const restore = async () => {
    if (busy.current || status !== "idle") return;
    busy.current = true;
    setStatus("restoring");
    setError(null);
    const images: DraftComposerImageAttachment[] = [];
    try {
      const signal = AbortSignal.timeout(30_000);
      for (const attachment of attachments) {
        const url = await refreshAssetUrl(
          environmentId,
          {
            _tag: "attachment",
            attachmentId: attachment.id,
            fileName: attachment.name,
            mimeType: attachment.mimeType,
          },
          signal,
        );
        if (!url) throw new Error();
        const cache = await downloadAttachmentForPreview({ url, attachment, signal });
        if (!cache) throw new Error();
        try {
          const uri = await persistComposerAttachmentFile(
            cache.uri,
            attachment.name,
            attachment.sizeBytes,
          );
          images.push({
            id: attachment.id,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            type: "image",
            fileUri: uri,
            previewUri: uri,
          });
        } finally {
          cache.dispose();
        }
      }
      const draftKey = scopedThreadKey(environmentId, item.threadId);
      const draft = getComposerDraftSnapshot(draftKey);
      if (draft.attachments.length + images.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
        setError(gt("Make room for the recovered attachments in the composer."));
        throw new Error();
      }
      if (text) appendComposerDraftText(draftKey, draft.text ? `\n\n${text}` : text);
      appendComposerDraftAttachments(draftKey, images, { restore: true });
      setStatus("restored");
    } catch {
      await Promise.allSettled(
        images.flatMap((image) =>
          image.fileUri ? [removePersistedComposerAttachmentFile(image.fileUri)] : [],
        ),
      );
      setError((current) => current ?? gt("Could not restore the queue."));
      setStatus("idle");
    } finally {
      busy.current = false;
    }
  };
  return (
    <View className="mb-3 gap-2 rounded-[20px] border border-border bg-card-alt p-3">
      <Text className="font-t3-medium text-sm text-foreground">
        {gt("Oh My Pi queue recovered")}
      </Text>
      {text ? (
        <Text numberOfLines={4} className="text-sm text-foreground-muted">
          {text}
        </Text>
      ) : null}
      {queue.truncated ? (
        <Text className="text-sm text-foreground-muted">
          {gt("Some queued messages could not be recovered.")}
        </Text>
      ) : null}
      {queue.imagesDropped ? (
        <Text className="text-sm text-foreground-muted">
          {gt("Some queued images could not be recovered.")}
        </Text>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
          {error}
        </Text>
      ) : null}
      {props.canRestore && (text || attachments.length > 0) ? (
        <Button
          tone="secondary"
          disabled={status !== "idle"}
          onPress={() => void restore()}
          label={
            status === "restored"
              ? gt("Restored to draft")
              : status === "restoring"
                ? gt("Restoring…")
                : gt("Restore to draft")
          }
        />
      ) : null}
    </View>
  );
}
