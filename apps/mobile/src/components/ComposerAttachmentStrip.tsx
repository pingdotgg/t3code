import { SymbolView } from "../components/AppSymbol";
import { videoMimeType } from "@t3tools/shared/video";
import { useEffect, useRef, useState } from "react";
import { Alert, Image, Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "./AppText";
import type { DraftComposerAttachment, DraftComposerFileAttachment } from "../lib/composerImages";
import { VideoAttachmentTile } from "./VideoAttachmentTile";
import { loadLocalAttachmentPreview } from "../lib/localAttachmentPreview";
import { PresentationSource } from "./NativePresentation";
import type { FilePreviewSource } from "./FilePreviewModal";
import { isPdfFile } from "../lib/filePreview";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  retryComposerAttachmentUpload,
  useComposerAttachmentUploadState,
} from "../state/composer-attachment-uploads";

export interface ComposerAttachmentStripProps {
  readonly environmentId?: EnvironmentId;
  /** Attachments to display. */
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  /** Called when the user removes an attachment. */
  readonly onRemove: (imageId: string) => void;
  /** Called when the user taps an image or PDF to preview it. */
  readonly onPressPreview?: (source: FilePreviewSource) => void;
  readonly onPressVideo?: (
    attachment: DraftComposerFileAttachment,
    sourceIdentifier: string,
  ) => void;
  /** Image thumbnail size in points.  Defaults to 72. */
  readonly imageSize?: number;
  /** Border radius of each image thumbnail.  Defaults to 16. */
  readonly imageBorderRadius?: number;
  /** Whether the remove button should sit in its own gutter instead of overlapping the image. */
  readonly removeButtonPlacement?: "overlay" | "gutter";
}

type ComposerAttachmentThumbnailProps = {
  readonly environmentId?: EnvironmentId;
  readonly attachment: DraftComposerAttachment;
  readonly size: number;
  readonly borderRadius: number;
  readonly compact?: boolean;
  readonly onPressPreview?: (source: FilePreviewSource) => void;
  readonly onPressVideo?: (
    attachment: DraftComposerFileAttachment,
    sourceIdentifier: string,
  ) => void;
};

export function ComposerAttachmentThumbnail(props: ComposerAttachmentThumbnailProps) {
  const upload = useComposerAttachmentUploadState(props.environmentId, props.attachment.id);
  return (
    <View style={{ width: props.size, height: props.size }}>
      <ComposerAttachmentContent {...props} />
      {upload && upload.status !== "ready" ? (
        <Pressable
          accessibilityRole={upload.status === "failed" ? "button" : "text"}
          accessibilityLabel={
            upload.status === "failed"
              ? `Retry uploading ${props.attachment.name}`
              : `Uploading ${props.attachment.name}, ${Math.floor(upload.progress * 100)}%`
          }
          accessibilityHint={upload.status === "failed" ? upload.reason : undefined}
          disabled={upload.status !== "failed"}
          onPress={() =>
            props.environmentId &&
            retryComposerAttachmentUpload(props.environmentId, props.attachment.id)
          }
          className="absolute bottom-0.5 left-0.5 flex-row items-center gap-0.5 rounded-full bg-black/70 px-1 py-0.5"
        >
          <SymbolView
            name={upload.status === "failed" ? "arrow.clockwise" : "arrow.up"}
            size={props.compact ? 8 : 10}
            tintColor="#ffffff"
            type="monochrome"
          />
          {!props.compact ? (
            <Text className="text-2xs text-white">
              {upload.status === "failed" ? "Retry" : `${Math.floor(upload.progress * 100)}%`}
            </Text>
          ) : null}
        </Pressable>
      ) : null}
    </View>
  );
}

function ComposerAttachmentContent(props: ComposerAttachmentThumbnailProps) {
  const { attachment } = props;
  const style = { width: props.size, height: props.size, borderRadius: props.borderRadius };
  if (attachment.type === "image") {
    const sourceIdentifier = `draft-image:${attachment.id}`;
    return (
      <PresentationSource identifier={sourceIdentifier}>
        <Pressable
          accessibilityRole="imagebutton"
          accessibilityLabel={`Open ${attachment.name}`}
          disabled={!props.onPressPreview}
          onPress={() =>
            props.onPressPreview?.({
              kind: "image",
              uri: attachment.dataUrl,
              name: attachment.name,
              sourceIdentifier,
            })
          }
        >
          <Image
            source={{ uri: attachment.previewUri }}
            style={style}
            className="bg-subtle"
            resizeMode="cover"
          />
        </Pressable>
      </PresentationSource>
    );
  }
  const onPressVideo = props.onPressVideo;
  if (onPressVideo && videoMimeType(attachment) !== null) {
    return (
      <ComposerVideoAttachment {...props} attachment={attachment} onPressVideo={onPressVideo} />
    );
  }
  const canPreview = isPdfFile(attachment) && props.onPressPreview !== undefined;
  const sourceIdentifier = `draft-file:${attachment.id}`;
  return (
    <PresentationSource identifier={sourceIdentifier}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${attachment.name}`}
        disabled={!canPreview}
        onPress={() =>
          props.onPressPreview?.({
            kind: "pdf",
            name: attachment.name,
            attachment,
            sourceIdentifier,
          })
        }
        className={
          props.compact
            ? "items-center justify-center bg-subtle"
            : "items-center justify-center gap-1 bg-subtle px-2"
        }
        style={style}
      >
        <SymbolView
          name="doc.text"
          size={props.compact ? 15 : 22}
          tintColor="#a3a3a3"
          type="monochrome"
        />
        {!props.compact ? (
          <Text className="w-full text-center text-2xs text-foreground" numberOfLines={1}>
            {attachment.name}
          </Text>
        ) : null}
      </Pressable>
    </PresentationSource>
  );
}

function ComposerVideoAttachment(props: {
  readonly attachment: DraftComposerFileAttachment;
  readonly size: number;
  readonly borderRadius: number;
  readonly compact?: boolean;
  readonly onPressVideo: (
    attachment: DraftComposerFileAttachment,
    sourceIdentifier: string,
  ) => void;
}) {
  const { attachment } = props;
  const sourceIdentifier = `draft:${attachment.id}`;
  const style = { width: props.size, height: props.size, borderRadius: props.borderRadius };
  const shareRef = useRef<AbortController | null>(null);
  const [sharing, setSharing] = useState(false);
  useEffect(
    () => () => {
      shareRef.current?.abort();
      shareRef.current = null;
    },
    [],
  );

  const onShare = () => {
    if (shareRef.current) return;
    const controller = new AbortController();
    shareRef.current = controller;
    setSharing(true);
    void (async () => {
      const preview = await loadLocalAttachmentPreview(attachment, controller.signal);
      if (!preview) return;
      try {
        await preview.share(controller.signal, sourceIdentifier);
      } finally {
        preview.dispose();
      }
    })()
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          Alert.alert(
            "Could not share video",
            error instanceof Error ? error.message : "Try again.",
          );
        }
      })
      .finally(() => {
        if (shareRef.current === controller) {
          shareRef.current = null;
          setSharing(false);
        }
      });
  };

  return (
    <VideoAttachmentTile
      name={attachment.name}
      sourceIdentifier={sourceIdentifier}
      thumbnailSource={attachment}
      compact={props.compact}
      onPress={() => props.onPressVideo(attachment, sourceIdentifier)}
      onShare={onShare}
      disabled={sharing}
      style={style}
    />
  );
}

/**
 * Attachment thumbnails used by the thread composer and the new-task draft screen.
 */
export function ComposerAttachmentStrip(props: ComposerAttachmentStripProps) {
  const size = props.imageSize ?? 72;
  const radius = props.imageBorderRadius ?? 16;
  const removeButtonPlacement = props.removeButtonPlacement ?? "overlay";
  const removeButtonGutter = removeButtonPlacement === "gutter" ? 10 : 0;

  if (props.attachments.length === 0) {
    return null;
  }

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="always"
      className="grow-0"
    >
      <View className="flex-row gap-2.5">
        {props.attachments.map((attachment) => (
          <View
            key={attachment.id}
            className="relative"
            style={{
              paddingTop: removeButtonGutter,
              paddingRight: removeButtonGutter,
            }}
          >
            <ComposerAttachmentThumbnail
              environmentId={props.environmentId}
              attachment={attachment}
              size={size}
              borderRadius={radius}
              onPressPreview={props.onPressPreview}
              onPressVideo={props.onPressVideo}
            />
            <Pressable
              className="absolute h-[22px] w-[22px] items-center justify-center rounded-[11px] bg-black/55"
              style={{
                top: removeButtonPlacement === "gutter" ? 0 : 4,
                right: removeButtonPlacement === "gutter" ? 0 : 4,
              }}
              hitSlop={6}
              onPress={() => props.onRemove(attachment.id)}
            >
              <SymbolView
                name="xmark"
                size={9}
                tintColor="#ffffff"
                type="monochrome"
                weight="bold"
              />
            </Pressable>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}
