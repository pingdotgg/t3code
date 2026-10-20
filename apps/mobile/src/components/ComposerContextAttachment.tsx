import { Button } from "./ui/Button";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import * as Dialog from "./ui/Dialog";
import type { ComposerContextRecord, EnvironmentId } from "@t3tools/contracts";
import { Pressable, View } from "react-native";
import { Image } from "expo-image";
import { useEffect, useId, useState } from "react";
import type { DraftComposerAttachment } from "../lib/composerImages";
import { composerAttachmentInlineUri, isFileBackedComposerAttachment } from "../lib/composerImages";
import { loadLocalAttachmentPreview } from "../lib/localAttachmentPreview";
import { downloadAndShareAttachment } from "../lib/attachmentDownload";
import { assetImageSource } from "../lib/assetImageSource";
import { useAssetUrlState, useRefreshAssetUrl } from "../state/assets";
import { AppText as Text } from "./ui/AppText";
import { FilePreviewModal } from "./FilePreviewModal";
import { PresentationSource } from "./ui/NativePresentation";

export function ComposerContextAttachment(props: {
  record: Extract<ComposerContextRecord, { attachmentId: string }>;
  environmentId?: EnvironmentId;
  attachment?: DraftComposerAttachment;
}) {
  const { record, attachment } = props;
  const shareSourceIdentifier = useId();
  const resource = {
    _tag: "attachment" as const,
    attachmentId: record.attachmentId,
    fileName: record.name,
  };
  const local = attachment?.fileUri
    ? (attachment as DraftComposerAttachment & { fileUri: string })
    : undefined;
  const inlineUri = composerAttachmentInlineUri(attachment);
  const remoteEnvironmentId = local || inlineUri ? null : (props.environmentId ?? null);
  const asset = useAssetUrlState(remoteEnvironmentId, resource);
  const refresh = useRefreshAssetUrl(remoteEnvironmentId, resource);
  const [localUri, setLocalUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  useEffect(() => {
    if (!local) return;
    const controller = new AbortController();
    let dispose: (() => void) | undefined;
    void loadLocalAttachmentPreview(local, controller.signal)
      .then((preview) => {
        if (!preview) return;
        if (controller.signal.aborted) return preview.dispose();
        dispose = preview.dispose;
        setLocalUri(preview.uri);
        setError(null);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError("The local file is unavailable. Attach it again.");
      });
    return () => {
      controller.abort();
      dispose?.();
    };
  }, [local]);
  const uri = local ? localUri : (inlineUri ?? (asset._tag === "Success" ? asset.url : null));
  const share = async () => {
    if (sharing) return;
    setSharing(true);
    const controller = new AbortController();
    const result = await settlePromise(async () => {
      if (local) {
        const preview = await loadLocalAttachmentPreview(local, controller.signal);
        if (!preview) return;
        const shared = await settlePromise(() =>
          preview.share(controller.signal, shareSourceIdentifier),
        );
        preview.dispose();
        if (AsyncResult.isFailure(shared)) throw squashAtomCommandFailure(shared);
        return;
      }
      const url = await refresh();
      if (!url) throw new Error("Reconnect to the environment and try again.");
      await downloadAndShareAttachment({
        url,
        attachment: record,
        signal: controller.signal,
        sourceIdentifier: shareSourceIdentifier,
      });
    });
    setSharing(false);
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      Dialog.alert(
        "Could not open attachment",
        cause instanceof Error ? cause.message : "Try again.",
      );
    }
  };
  return (
    <View className="gap-3">
      {record.kind === "image" && uri ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Preview ${record.name}`}
          onPress={() => setPreviewOpen(true)}
        >
          <Image
            source={
              remoteEnvironmentId === null
                ? { uri }
                : assetImageSource(remoteEnvironmentId, resource, uri)
            }
            style={{ width: "100%", height: 280 }}
            contentFit="contain"
            accessibilityLabel={record.name}
          />
        </Pressable>
      ) : null}
      {error || (!local && asset._tag === "Failure") ? (
        <Text className="text-foreground-muted">
          {error ?? "Attachment unavailable. Reconnect and try again."}
        </Text>
      ) : null}
      <PresentationSource identifier={shareSourceIdentifier}>
        <Button
          label={sharing ? "Opening attachment…" : "Open or share attachment"}
          tone="secondary"
          disabled={sharing}
          onPress={() => void share()}
          fullWidth
          loading={sharing}
        />
      </PresentationSource>
      {previewOpen && record.kind === "image" && uri ? (
        <FilePreviewModal
          source={{
            kind: "image",
            name: record.name,
            uri,
            actionsSource: {
              name: record.name,
              mimeType: record.mimeType,
              ...(attachment && isFileBackedComposerAttachment(attachment)
                ? { attachment }
                : inlineUri === undefined && props.environmentId
                  ? { environmentId: props.environmentId, resource }
                  : { uri }),
            },
          }}
          onRequestClose={() => setPreviewOpen(false)}
        />
      ) : null}
    </View>
  );
}
