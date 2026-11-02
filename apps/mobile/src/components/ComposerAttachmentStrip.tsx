import { FilePreviewGallery, useFilePreviewGallery } from "./FilePreviewGallery";
import { composerImageGallery } from "../lib/composerImageGallery";
import { SymbolView } from "./ui/AppSymbol";
import { imageMimeType } from "@t3tools/shared/image";
import { videoMimeType } from "@t3tools/shared/video";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";
import { Paths } from "expo-file-system";
import { Image, Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "./ui/AppText";
import { MaterializedPreviewKey, materializedPreviewAtom } from "../lib/composerImagePreview";
import { PierreEntryIcon } from "./PierreEntryIcon";
import {
  isFileBackedComposerAttachment,
  type DraftComposerAttachment,
  type DraftComposerFileAttachment,
  type DraftComposerImageAttachment,
} from "../lib/composerImages";
import { resolveOwnedComposerAttachmentFileUri } from "../lib/composerAttachmentFiles";
import { VideoAttachmentTile } from "./VideoAttachmentTile";
import { type MediaActionsSource } from "../lib/mediaActionsSource";
import { PresentationSource } from "./ui/NativePresentation";
import type { FilePreviewSource } from "./FilePreviewModal";
import { isPdfFile } from "../lib/filePreview";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  retryComposerAttachmentUpload,
  useComposerAttachmentUploadState,
} from "../state/composer-attachment-uploads";

export interface ComposerAttachmentStripProps {
  readonly environmentId?: EnvironmentId;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly onRemove: (imageId: string) => void;
  readonly onPressPreview?: (source: FilePreviewSource) => void;
  readonly onPressVideo?: (
    attachment: DraftComposerFileAttachment,
    sourceIdentifier: string,
  ) => void;
  readonly onPressDocument?: (attachment: DraftComposerFileAttachment) => void;
  readonly imageSize?: number;
  readonly imageBorderRadius?: number;
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
  readonly onPressDocument?: (attachment: DraftComposerFileAttachment) => void;
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

/** Fabric re-parses URLs each layout; large data URLs can stall and abort commits. */
const INLINE_PREVIEW_FALLBACK_MAX_CHARS = 256_000;

const noMaterializedPreview = Atom.make(AsyncResult.initial<string | null>()).pipe(
  Atom.withLabel("composer-image-preview:none"),
);

function useComposerImagePreviewUri(attachment: DraftComposerImageAttachment): string | null {
  const { fileUri, previewUri } = attachment;
  const inlinePreview = fileUri === undefined && previewUri.startsWith("data:");
  const materialized = useAtomValue(
    inlinePreview
      ? materializedPreviewAtom(new MaterializedPreviewKey(attachment))
      : noMaterializedPreview,
  );
  if (fileUri !== undefined) {
    // Reinstalls move the app container, so a stored file URI may point at the old one.
    const owned = resolveOwnedComposerAttachmentFileUri(fileUri, Paths.document.uri);
    if (owned !== null) return owned;
    return previewUri.startsWith("data:") ? fileUri : previewUri;
  }
  if (inlinePreview) {
    if (!AsyncResult.isSuccess(materialized)) return null;
    return (
      materialized.value ??
      (previewUri.length <= INLINE_PREVIEW_FALLBACK_MAX_CHARS ? previewUri : null)
    );
  }
  return previewUri;
}

function ComposerImageAttachment(
  props: ComposerAttachmentThumbnailProps & { readonly attachment: DraftComposerImageAttachment },
) {
  const { attachment } = props;
  const withGallery = useFilePreviewGallery();
  const style = { width: props.size, height: props.size, borderRadius: props.borderRadius };
  const previewUri = useComposerImagePreviewUri(attachment);
  const sourceIdentifier = `draft-image:${attachment.id}`;
  return (
    <PresentationSource identifier={sourceIdentifier}>
      <Pressable
        accessibilityRole="imagebutton"
        accessibilityLabel={`Open ${attachment.name}`}
        disabled={!props.onPressPreview}
        onPress={() =>
          props.onPressPreview?.(
            withGallery(
              isFileBackedComposerAttachment(attachment)
                ? { kind: "image", attachment, name: attachment.name, sourceIdentifier }
                : {
                    kind: "image",
                    uri: attachment.dataUrl ?? attachment.previewUri,
                    name: attachment.name,
                    sourceIdentifier,
                  },
            ),
          )
        }
      >
        <Image
          source={previewUri === null ? undefined : { uri: previewUri }}
          style={style}
          className="bg-subtle"
          resizeMode="cover"
        />
      </Pressable>
    </PresentationSource>
  );
}

function ComposerAttachmentContent(props: ComposerAttachmentThumbnailProps) {
  const { attachment } = props;
  // The document picker types every pick as a plain file, so a picture arrives here as one.
  if (attachment.type === "image" || imageMimeType(attachment) !== null) {
    const { source: _droppedSource, ...rest } = attachment;
    return (
      <ComposerImageAttachment
        {...props}
        attachment={
          attachment.type === "image"
            ? attachment
            : { ...rest, type: "image", previewUri: attachment.fileUri }
        }
      />
    );
  }
  const onPressVideo = props.onPressVideo;
  if (onPressVideo && videoMimeType(attachment) !== null) {
    return (
      <ComposerVideoAttachment {...props} attachment={attachment} onPressVideo={onPressVideo} />
    );
  }
  return <ComposerFileAttachment {...props} attachment={attachment} />;
}

function ComposerFileAttachment(
  props: ComposerAttachmentThumbnailProps & { readonly attachment: DraftComposerFileAttachment },
) {
  const { attachment } = props;
  const style = { width: props.size, height: props.size, borderRadius: props.borderRadius };
  const canPreview = isPdfFile(attachment) && props.onPressPreview !== undefined;
  const sourceIdentifier = `draft-file:${attachment.id}`;
  const onPressDocument = props.onPressDocument;
  return (
    <>
      <PresentationSource identifier={sourceIdentifier}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${attachment.name}`}
          disabled={!canPreview && onPressDocument === undefined}
          onPress={() =>
            canPreview
              ? props.onPressPreview?.({
                  kind: "pdf",
                  name: attachment.name,
                  attachment,
                  sourceIdentifier,
                })
              : onPressDocument?.(attachment)
          }
          className={
            props.compact
              ? "items-center justify-center bg-subtle"
              : "items-center justify-center gap-1 bg-subtle px-2"
          }
          style={style}
        >
          <PierreEntryIcon path={attachment.name} kind="file" size={props.compact ? 15 : 22} />
          {!props.compact ? (
            <Text className="w-full text-center text-2xs text-foreground" numberOfLines={1}>
              {attachment.name}
            </Text>
          ) : null}
        </Pressable>
      </PresentationSource>
    </>
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
  const actionsSource: MediaActionsSource = {
    name: attachment.name,
    mimeType: videoMimeType(attachment) ?? attachment.mimeType,
    sourceIdentifier,
    attachment,
  };

  return (
    <VideoAttachmentTile
      name={attachment.name}
      sourceIdentifier={sourceIdentifier}
      thumbnailSource={attachment}
      compact={props.compact}
      onPress={() => props.onPressVideo(attachment, sourceIdentifier)}
      actionsSource={actionsSource}
      style={style}
    />
  );
}

export function ComposerAttachmentStrip(props: ComposerAttachmentStripProps) {
  const gallery = composerImageGallery(props.attachments);
  const size = props.imageSize ?? 72;
  const radius = props.imageBorderRadius ?? 16;
  const removeButtonPlacement = props.removeButtonPlacement ?? "overlay";
  const removeButtonGutter = removeButtonPlacement === "gutter" ? 10 : 0;

  if (props.attachments.length === 0) {
    return null;
  }

  return (
    <FilePreviewGallery value={gallery}>
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
                onPressDocument={props.onPressDocument}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Remove ${attachment.name}`}
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
    </FilePreviewGallery>
  );
}
