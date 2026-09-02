import { useEffect } from "react";
import { Keyboard, Modal, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useMediaActions } from "../lib/mediaActions";
import { MediaActionsMenu } from "./MediaActionsMenu";
import {
  mediaVideoPreviewUri,
  mediaVideoThumbnailKey,
  type MediaVideoPreviewSource,
} from "../lib/videoPreviewSource";
import { useAssetUrlState, useRefreshAssetUrl } from "../state/assets";
import { usePreparedConnection } from "../state/session";
import { AppText } from "./AppText";
import { SymbolView } from "./AppSymbol";
import { MediaVideoPlayer } from "./MediaVideoPlayer";
import { MediaSourceCaption } from "./MediaSourceCaption";

/** Media files stream in place. A client-side copy is made only for an explicit share. */
export function MediaVideoPreviewModal(props: {
  readonly source: MediaVideoPreviewSource;
  readonly onRequestClose: () => void;
}) {
  const { source } = props;
  const insets = useSafeAreaInsets();
  const environmentId = "environmentId" in source ? source.environmentId : null;
  const connection = usePreparedConnection(environmentId);
  const asset = useAssetUrlState(environmentId, "resource" in source ? source.resource : null);
  const refreshAssetUrl = useRefreshAssetUrl(
    environmentId,
    "resource" in source ? source.resource : null,
  );
  const resolvePlaybackUri =
    "resource" in source
      ? async () => mediaVideoPreviewUri(source, await refreshAssetUrl())
      : undefined;
  const uri = mediaVideoPreviewUri(source, asset._tag === "Success" ? asset.url : null);
  const mediaActions = useMediaActions(source.actionsSource, props.onRequestClose);
  const unavailable =
    uri === null &&
    environmentId !== null &&
    (connection._tag === "None" || asset._tag === "Failure");

  useEffect(() => Keyboard.dismiss(), []);
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
            {source.name}
          </AppText>
          <MediaActionsMenu media={mediaActions} inModal />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close video"
            onPress={props.onRequestClose}
            className="size-12 items-center justify-center"
          >
            <SymbolView name="xmark" size={20} tintColor="#ffffff" type="monochrome" />
          </Pressable>
        </View>
        <MediaSourceCaption source={mediaActions.title} />
        <MediaVideoPlayer
          uri={uri}
          resolvePlaybackUri={resolvePlaybackUri}
          name={source.name}
          thumbnailKey={mediaVideoThumbnailKey(source)}
          unavailable={unavailable}
          paused={mediaActions.sharing}
          expanded
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save or share video"
          disabled={uri === null || mediaActions.sharing}
          onPress={mediaActions.share}
          className="mx-4 my-3 min-h-12 items-center justify-center rounded-xl bg-white/15 px-4"
        >
          <AppText className="font-t3-medium text-base text-white">
            {mediaActions.sharing ? "Opening share sheet..." : "Save or share video"}
          </AppText>
        </Pressable>
      </View>
    </Modal>
  );
}
