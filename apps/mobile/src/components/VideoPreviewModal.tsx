import { useIsFocused } from "@react-navigation/native";
import type { ChatFileAttachment, EnvironmentId } from "@t3tools/contracts";
import { videoMimeType } from "@t3tools/shared/video";
import { useEvent } from "expo";
import { useVideoPlayer, VideoView } from "expo-video";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Keyboard,
  Modal,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  downloadAttachmentForPreview,
  type AttachmentPreviewFile,
} from "../lib/attachmentDownload";
import type { DraftComposerFileAttachment } from "../lib/composerImages";
import { loadLocalAttachmentPreview } from "../lib/localAttachmentPreview";
import { useAssetUrlState } from "../state/assets";
import { usePreparedConnection } from "../state/session";
import { SymbolView } from "./AppSymbol";
import { AppText } from "./AppText";

export type VideoPreviewSource = (
  | { readonly type: "local"; readonly attachment: DraftComposerFileAttachment }
  | {
      readonly type: "remote";
      readonly environmentId: EnvironmentId;
      readonly attachment: ChatFileAttachment;
    }
) & { readonly sourceIdentifier?: string };

function VideoPlayback(props: { readonly file: AttachmentPreviewFile }) {
  const player = useVideoPlayer(props.file.uri, (player) => {
    player.staysActiveInBackground = false;
    if (AppState.currentState === "active") player.play();
  });
  const { status } = useEvent(player, "statusChange", { status: player.status });
  const shareControllerRef = useRef<AbortController | null>(null);
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);

  useEffect(
    () => () => {
      shareControllerRef.current?.abort();
      shareControllerRef.current = null;
    },
    [],
  );

  const onShare = () => {
    if (shareControllerRef.current) return;
    player.pause();
    const controller = new AbortController();
    shareControllerRef.current = controller;
    setSharing(true);
    setShareError(null);
    void props.file
      .share(controller.signal)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setShareError(error instanceof Error ? error.message : "Could not share this video.");
        }
      })
      .finally(() => {
        if (shareControllerRef.current === controller) {
          shareControllerRef.current = null;
          setSharing(false);
        }
      });
  };

  return (
    <>
      <View className="flex-1 items-center justify-center">
        {status === "error" ? (
          <AppText className="px-6 text-center text-base text-white/80">
            This video couldn't be played on this device. You can save or share the original file.
          </AppText>
        ) : (
          <>
            <VideoView
              player={player}
              style={StyleSheet.absoluteFill}
              nativeControls
              contentFit="contain"
              fullscreenOptions={{ enable: true }}
              allowsPictureInPicture={false}
            />
            {status === "loading" ? (
              <ActivityIndicator color="#ffffff" accessibilityLabel="Loading video" />
            ) : null}
          </>
        )}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Save or share video"
        accessibilityState={{ disabled: sharing, busy: sharing }}
        disabled={sharing}
        onPress={onShare}
        className="mx-4 my-3 min-h-12 items-center justify-center rounded-xl bg-white/15 px-4"
      >
        <AppText className="font-t3-medium text-base text-white">
          {sharing ? "Opening share sheet..." : "Save or share video"}
        </AppText>
      </Pressable>
      {shareError ? (
        <AppText accessibilityRole="alert" className="px-4 pb-3 text-sm text-white/80">
          {shareError}
        </AppText>
      ) : null}
    </>
  );
}

function OpenVideoPreviewModal(props: {
  readonly source: VideoPreviewSource;
  readonly onRequestClose: () => void;
}) {
  const { source } = props;
  const { attachment } = source;
  const insets = useSafeAreaInsets();
  const environmentId = source.type === "remote" ? source.environmentId : null;
  const preparedConnection = usePreparedConnection(environmentId);
  const fileUri = source.type === "local" ? source.attachment.fileUri : null;
  const mimeType = videoMimeType(attachment) ?? attachment.mimeType;
  const assetUrl = useAssetUrlState(
    environmentId,
    source.type === "remote"
      ? { _tag: "attachment", attachmentId: attachment.id, fileName: attachment.name, mimeType }
      : null,
  );
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [file, setFile] = useState<AttachmentPreviewFile | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => Keyboard.dismiss(), []);
  useEffect(() => {
    if (environmentId !== null && downloadUrl === null && assetUrl._tag === "Success") {
      setDownloadUrl(assetUrl.url);
    }
  }, [environmentId, downloadUrl, assetUrl]);

  useEffect(() => {
    if (source.type === "remote" && downloadUrl === null) return;
    const controller = new AbortController();
    let preview: AttachmentPreviewFile | null = null;
    setFile(null);
    setFailure(null);
    const loading =
      source.type === "local"
        ? loadLocalAttachmentPreview(source.attachment, controller.signal)
        : downloadAttachmentForPreview({
            url: downloadUrl!,
            attachment: { name: attachment.name, mimeType },
            signal: controller.signal,
          });
    void loading.then(
      (loaded) => {
        if (controller.signal.aborted) {
          loaded?.dispose();
          return;
        }
        preview = loaded;
        setFile(loaded);
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setFailure(error instanceof Error ? error.message : "Could not load this video.");
        }
      },
    );
    return () => {
      controller.abort();
      preview?.dispose();
    };
  }, [source.type, environmentId, attachment.id, attachment.name, mimeType, fileUri, downloadUrl]);

  const loadError =
    failure ??
    (environmentId !== null && downloadUrl === null
      ? preparedConnection._tag === "None"
        ? "This environment is disconnected. Reconnect and open the video again."
        : assetUrl._tag === "Failure"
          ? "Could not load this video. Check the connection to this environment and try again."
          : null
      : null);

  return (
    <Modal
      visible
      animationType="fade"
      presentationStyle="fullScreen"
      onRequestClose={props.onRequestClose}
      statusBarTranslucent
      navigationBarTranslucent
    >
      <View
        className="flex-1 bg-black"
        style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
      >
        <View className="min-h-14 flex-row items-center gap-3 pl-4 pr-2">
          <AppText className="flex-1 font-t3-medium text-base text-white" numberOfLines={2}>
            {attachment.name}
          </AppText>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close video"
            onPress={props.onRequestClose}
            className="size-12 items-center justify-center"
          >
            <SymbolView name="xmark" size={20} tintColor="#ffffff" type="monochrome" />
          </Pressable>
        </View>
        {file ? (
          <VideoPlayback key={file.uri} file={file} />
        ) : (
          <View className="flex-1 items-center justify-center gap-3 px-6">
            {loadError ? (
              <AppText accessibilityRole="alert" className="text-center text-base text-white/80">
                {loadError}
              </AppText>
            ) : (
              <>
                <ActivityIndicator color="#ffffff" />
                <AppText className="text-sm text-white/80">Loading video...</AppText>
              </>
            )}
          </View>
        )}
      </View>
    </Modal>
  );
}

export function VideoPreviewModal(props: {
  readonly source: VideoPreviewSource | null;
  readonly onRequestClose: () => void;
}) {
  const isFocused = useIsFocused();
  const hasSource = props.source !== null;
  useEffect(() => {
    if (!isFocused && hasSource) props.onRequestClose();
  }, [isFocused, hasSource, props.onRequestClose]);
  const { source } = props;
  if (source === null || !isFocused) return null;
  const key =
    source.type === "local"
      ? `local:${source.attachment.id}:${source.attachment.fileUri}`
      : `remote:${source.environmentId}:${source.attachment.id}`;
  return <OpenVideoPreviewModal key={key} source={source} onRequestClose={props.onRequestClose} />;
}
