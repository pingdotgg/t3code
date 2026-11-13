/**
 * Thread feed media: attachments, inline images and media visibility plumbing.
 */
import { ThreadMarkdownVideo, ThreadMediaVisibleContext } from "../ThreadMarkdownVideo";
import { AppActivityIndicator } from "../../../components/ui/AppActivityIndicator";
import { useViewabilityAmount, type LegendListRef } from "@legendapp/list/react-native";
import {
  AuthFilesystemReadScope,
  idleCompactionOf,
  type OrchestrationMessageContext,
  ThreadId,
  type ChatAttachment,
  type ChatFileAttachment,
  type ChatImageAttachment,
  type EnvironmentId,
  type MessageId,
  type OrchestrationV2ProjectedTurnItem,
  type RunId,
  type ScheduledTaskId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { imageMimeType } from "@t3tools/shared/image";
import { videoMimeType } from "@t3tools/shared/video";
import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  useId,
  type ComponentPropsWithRef,
  type ComponentRef,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import {
  Image,
  Platform,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  StyleSheet,
  type ColorValue,
  useWindowDimensions,
  View,
} from "react-native";
import { Image as ExpoImage } from "expo-image";
import { useResolveClassNames } from "uniwind";
import { useFilePreviewGallery, FilePreviewGallery } from "../../../components/FilePreviewGallery";
import { assetImageSource } from "../../../lib/assetImageSource";
import { composerImageGallery } from "../../../lib/composerImageGallery";
import { isFileBackedComposerAttachment } from "../../../lib/composerImages";
import { useLocalAttachmentPreview } from "../../../lib/localAttachmentPreview";
import { messageImageGallery } from "../messageImageGallery";
import { MARKDOWN_IMAGE_MAX_WIDTH, resolveMarkdownImageDisplaySize } from "../markdownImageSize";
import { FilePreviewModal, type FilePreviewSource } from "../../../components/FilePreviewModal";
import { PresentationSource } from "../../../components/ui/NativePresentation";
import { NativeScrollViewMarker } from "../../../native/NativeScrollViewMarker";
import Animated, { FadeIn, FadeInDown, type SharedValue } from "react-native-reanimated";
import { AppText as Text } from "../../../components/ui/AppText";
import { attachmentVideoPreviewSource } from "../../../lib/videoPreviewSource";
import { PierreEntryIcon } from "../../../components/PierreEntryIcon";
import {
  createThreadFeedCache,
  threadFeedCompactionLabels,
  failedFeedRunIds,
  deriveThreadFeedPresentation,
  threadFeedRunIsUnsettled,
  isContextCompactionActivityGroup,
  isContextHandoffActivityGroup,
  isLinkRequestActivityGroup,
  isSecretRequestActivityGroup,
  type ThreadFeedEntry,
  type ThreadFeedLatestRun,
  messageFoldRunId,
} from "../../../lib/threadActivity";
import {
  appendGuestPendingMessages,
  appendPendingThreadMessages,
  createThreadFeedGrouping,
  isCompactionCommandFeedEntry,
  type GroupedThreadFeedRow,
  type ThreadFeedRow,
} from "../pending-thread-feed";
import type { QueuedThreadMessage } from "../../../state/thread-outbox-model";
import { assetEnvironment, useAssetUrl, useRefreshAssetUrl } from "../../../state/assets";
import { MessageAttachmentFile } from "../ThreadFeedParts";

export function MessageImage(props: {
  readonly source: ComponentPropsWithRef<typeof ExpoImage>["source"];
  readonly className: string;
  readonly maxWidth?: number;
  readonly height?: number;
  readonly onLoad?: () => void;
  readonly onError?: () => void;
}) {
  const imageStyle = useResolveClassNames(props.className);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const displaySize =
    props.maxWidth !== undefined && size !== null
      ? resolveMarkdownImageDisplaySize({
          sourceWidth: size.width,
          sourceHeight: size.height,
          availableWidth: props.maxWidth,
        })
      : null;
  return (
    <ExpoImage
      source={props.source}
      cachePolicy="memory-disk"
      style={[
        imageStyle,
        props.maxWidth !== undefined
          ? (displaySize ?? {
              width: Math.min(props.maxWidth, MARKDOWN_IMAGE_MAX_WIDTH),
              aspectRatio: 1.3,
            })
          : props.height !== undefined
            ? { height: props.height }
            : undefined,
      ]}
      contentFit={props.maxWidth === undefined ? "cover" : "contain"}
      onLoad={(event) => {
        if (props.maxWidth !== undefined) setSize(event.source);
        props.onLoad?.();
      }}
      onError={props.onError}
    />
  );
}

export function MessageAttachmentImage(props: {
  readonly environmentId: EnvironmentId;
  readonly attachmentId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly className: string;
  readonly maxWidth?: number;
  readonly height?: number;
  readonly onPressPreview: (source: FilePreviewSource) => void;
}) {
  const withGallery = useFilePreviewGallery();
  const sourceIdentifier = useId();
  const resource = {
    _tag: "attachment" as const,
    attachmentId: props.attachmentId,
    fileName: props.name,
    mimeType: props.mimeType,
  };
  const uri = useAssetUrl(props.environmentId, resource);
  const refreshAssetUrl = useRefreshAssetUrl(props.environmentId, resource);
  const retriedImage = useRef(false);

  if (uri === null) {
    return (
      <View
        className={`${props.className} items-center justify-center`}
        style={
          props.maxWidth !== undefined
            ? { width: Math.min(props.maxWidth, MARKDOWN_IMAGE_MAX_WIDTH), aspectRatio: 1.3 }
            : props.height !== undefined
              ? { height: props.height }
              : undefined
        }
      >
        <AppActivityIndicator />
      </View>
    );
  }

  return (
    <PresentationSource identifier={sourceIdentifier}>
      <Pressable
        accessibilityRole="imagebutton"
        accessibilityLabel={`Open ${props.name}`}
        onPress={() =>
          props.onPressPreview(
            withGallery({
              kind: "image",
              environmentId: props.environmentId,
              resource,
              name: props.name,
              sourceIdentifier,
              actionsSource: {
                name: props.name,
                mimeType: props.mimeType,
                environmentId: props.environmentId,
                resource,
              },
            }),
          )
        }
      >
        <MessageImage
          source={assetImageSource(props.environmentId, resource, uri)}
          className={props.className}
          maxWidth={props.maxWidth}
          height={props.height}
          onLoad={() => {
            retriedImage.current = false;
          }}
          onError={() => {
            if (retriedImage.current) return;
            retriedImage.current = true;
            void refreshAssetUrl();
          }}
        />
      </Pressable>
    </PresentationSource>
  );
}

export function isImageAttachment(attachment: ChatAttachment): attachment is ChatImageAttachment {
  return attachment.type === "image" || imageMimeType(attachment) !== null;
}

export function isFileAttachment(attachment: ChatAttachment): attachment is ChatFileAttachment {
  return attachment.type === "file";
}

export function isMediaAttachment(attachment: ChatAttachment): boolean {
  return (
    isImageAttachment(attachment) ||
    (isFileAttachment(attachment) && videoMimeType(attachment) !== null)
  );
}

export function UserMessageMedia(props: {
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly pendingAttachments: QueuedThreadMessage["attachments"];
  readonly environmentId: EnvironmentId;
  readonly maxWidth: number;
  readonly onPressPreview: (source: FilePreviewSource) => void;
  readonly onPlaybackStart: () => void;
}) {
  const attachments = [...props.pendingAttachments, ...props.attachments];
  const collage = attachments.length > 1 && attachments.every(isImageAttachment);
  const imageProps = (index: number) => ({
    className: "w-full bg-user-bubble-foreground/15",
    maxWidth: collage ? undefined : props.maxWidth,
    height: !collage
      ? undefined
      : attachments.length === 2 || (attachments.length === 3 && index === 0)
        ? 192
        : attachments.length === 3
          ? (192 - StyleSheet.hairlineWidth) / 2
          : 96,
  });
  const media = [
    ...props.pendingAttachments.map((attachment, index) => {
      const image = isImageAttachment(attachment);
      return {
        id: attachment.id,
        image,
        content:
          image && attachment.uploadedAttachmentId ? (
            <MessageAttachmentImage
              environmentId={props.environmentId}
              attachmentId={attachment.uploadedAttachmentId}
              name={attachment.name}
              mimeType={attachment.mimeType}
              {...imageProps(index)}
              onPressPreview={props.onPressPreview}
            />
          ) : !image && attachment.uploadedAttachmentId ? (
            <ThreadMarkdownVideo
              source={attachmentVideoPreviewSource(props.environmentId, {
                ...attachment,
                type: "file",
                id: attachment.uploadedAttachmentId,
              })}
              onPlaybackStart={props.onPlaybackStart}
              borderRadius={20}
            />
          ) : (
            <PendingMessageMedia
              attachment={attachment}
              {...imageProps(index)}
              onPressPreview={props.onPressPreview}
              onPlaybackStart={props.onPlaybackStart}
            />
          ),
      };
    }),
    ...props.attachments.map((attachment, index) => ({
      id: attachment.id,
      image: isImageAttachment(attachment),
      content: isImageAttachment(attachment) ? (
        <MessageAttachmentImage
          environmentId={props.environmentId}
          attachmentId={attachment.id}
          name={attachment.name}
          mimeType={attachment.mimeType}
          {...imageProps(props.pendingAttachments.length + index)}
          onPressPreview={props.onPressPreview}
        />
      ) : isFileAttachment(attachment) ? (
        <MessageAttachmentFile
          environmentId={props.environmentId}
          attachment={attachment}
          onPressPreview={props.onPressPreview}
          onPlaybackStart={props.onPlaybackStart}
          standaloneMedia
        />
      ) : null,
    })),
  ];
  return collage ? (
    <View
      className="overflow-hidden rounded-[20px] bg-border"
      style={{ width: 320, maxWidth: "100%", alignSelf: "flex-end", gap: StyleSheet.hairlineWidth }}
    >
      {media.length === 3 ? (
        <View className="flex-row" style={{ gap: StyleSheet.hairlineWidth }}>
          <View className="min-w-0" style={{ flex: 3 }}>
            {media[0]!.content}
          </View>
          <View className="min-w-0" style={{ flex: 2, gap: StyleSheet.hairlineWidth }}>
            {media[1]!.content}
            {media[2]!.content}
          </View>
        </View>
      ) : (
        media
          .filter((_, index) => index % 2 === 0)
          .map((item, index) => (
            <View key={item.id} className="flex-row" style={{ gap: StyleSheet.hairlineWidth }}>
              <View className="min-w-0 flex-1">{item.content}</View>
              {media[index * 2 + 1] ? (
                <View className="min-w-0 flex-1">{media[index * 2 + 1]!.content}</View>
              ) : null}
            </View>
          ))
      )}
      <View pointerEvents="none" className="absolute inset-0 rounded-[20px] border border-border" />
    </View>
  ) : (
    <View className="items-end gap-2">
      {media.map((item) => (
        <View
          key={item.id}
          className="overflow-hidden rounded-[20px]"
          style={{ width: item.image ? undefined : 320, maxWidth: "100%" }}
        >
          {item.content}
          <View
            pointerEvents="none"
            className="absolute inset-0 rounded-[20px] border border-border"
          />
        </View>
      ))}
    </View>
  );
}

export function PendingMessageMedia(props: {
  readonly attachment: QueuedThreadMessage["attachments"][number];
  readonly className: string;
  readonly maxWidth?: number;
  readonly height?: number;
  readonly onPressPreview: (source: FilePreviewSource) => void;
  readonly onPlaybackStart: () => void;
}) {
  const withGallery = useFilePreviewGallery();
  const { attachment } = props;
  const fileBacked = isFileBackedComposerAttachment(attachment);
  const preview = useLocalAttachmentPreview(fileBacked ? attachment : null);
  if (isImageAttachment(attachment)) {
    const uri = fileBacked ? preview.uri : (attachment.dataUrl ?? attachment.previewUri);
    return (
      <Pressable
        accessibilityRole="imagebutton"
        accessibilityLabel={`Open ${attachment.name}`}
        onPress={() => {
          const source = composerImageGallery([attachment])[0];
          if (source) props.onPressPreview(withGallery(source));
        }}
      >
        <MessageImage
          source={uri === null ? undefined : { uri }}
          className={props.className}
          maxWidth={props.maxWidth}
          height={props.height}
        />
      </Pressable>
    );
  }
  if (preview.uri === null) {
    return (
      <View className="aspect-video items-center justify-center bg-black">
        {preview.error ? (
          <Text className="p-3 text-center text-xs text-white/70">{preview.error.message}</Text>
        ) : (
          <AppActivityIndicator />
        )}
      </View>
    );
  }
  return (
    <ThreadMarkdownVideo
      source={{
        type: "media",
        name: attachment.name,
        mimeType: attachment.mimeType,
        uri: preview.uri,
      }}
      onPlaybackStart={props.onPlaybackStart}
      borderRadius={20}
    />
  );
}

/** A message's files as its bubble shows them; a guest's waiting message uses it too. */

export function MessageAttachmentList(props: {
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly environmentId: EnvironmentId;
  readonly onPressPreview: (source: FilePreviewSource) => void;
  readonly onPlaybackStart: () => void;
}) {
  return props.attachments.map((attachment) =>
    isImageAttachment(attachment) ? (
      <MessageAttachmentImage
        key={attachment.id}
        environmentId={props.environmentId}
        attachmentId={attachment.id}
        name={attachment.name}
        mimeType={attachment.mimeType}
        className="mt-1.5 aspect-[1.3] w-full rounded-[18px] bg-subtle-strong"
        onPressPreview={props.onPressPreview}
      />
    ) : isFileAttachment(attachment) ? (
      <MessageAttachmentFile
        key={attachment.id}
        environmentId={props.environmentId}
        attachment={attachment}
        onPressPreview={props.onPressPreview}
        onPlaybackStart={props.onPlaybackStart}
      />
    ) : (
      <MessageAttachmentUnknown key={attachment.id} name={attachment.name} />
    ),
  );
}

export function MessageAttachmentUnknown(props: { readonly name: string }) {
  return (
    <View className="flex-row items-center gap-2 py-1">
      <PierreEntryIcon path={props.name} kind="file" size={16} />
      <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
        {props.name}
      </Text>
    </View>
  );
}

// LegendList only computes hook visibility when the list has a viewability config.

export const THREAD_MEDIA_VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 0 };

// The composer and overlays beside the feed keep UIKit from finding it on its own, so
// register it with the screen controller. Header minimization observes this scroll view.

export function ThreadFeedScrollView(props: ComponentPropsWithRef<typeof Animated.ScrollView>) {
  return (
    <NativeScrollViewMarker style={{ flex: 1 }}>
      <Animated.ScrollView {...props} />
    </NativeScrollViewMarker>
  );
}

export function ThreadMediaVisibility(props: { readonly children: ReactNode }) {
  const [visible, setVisible] = useState(false);
  useViewabilityAmount<ThreadFeedEntry>(
    useCallback((token) => setVisible(token.sizeVisible > 0), []),
  );
  return <ThreadMediaVisibleContext value={visible}>{props.children}</ThreadMediaVisibleContext>;
}

export function MessageImageGalleryScope(props: {
  entry: ThreadFeedRow;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  workspaceRoot: string | null | undefined;
  children: ReactNode;
}) {
  const { entry, environmentId, threadId, workspaceRoot } = props;
  const images =
    entry.type === "message"
      ? [
          ...messageImageGallery(entry.message, { environmentId, threadId, workspaceRoot }),
          ...composerImageGallery(entry.pendingMessage?.attachments ?? [], environmentId),
        ]
      : [];
  return <FilePreviewGallery value={images}>{props.children}</FilePreviewGallery>;
}
