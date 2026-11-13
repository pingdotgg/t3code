import { createContext, useContext, useState } from "react";
import { Platform } from "react-native";
import { MediaVideoPlayer } from "../../components/MediaVideoPlayer";
import { VideoPreviewModal } from "../../components/ui/VideoPreviewModal";
import { useAssetUrlState, useRefreshAssetUrl } from "../../state/assets";
import {
  mediaVideoPreviewUri,
  mediaVideoThumbnailKey,
  type MediaVideoPreviewSource,
} from "../../lib/videoPreviewSource";

export const ThreadMediaVisibleContext = createContext(false);

export function ThreadMarkdownVideo(props: {
  readonly source: MediaVideoPreviewSource;
  readonly thumbnailVisible?: boolean;
  readonly onPlaybackStart?: () => void;
  readonly borderRadius?: number;
}) {
  const { source } = props;
  const feedVisible = useContext(ThreadMediaVisibleContext);
  const visible = props.thumbnailVisible ?? feedVisible;
  const thumbnailKey = mediaVideoThumbnailKey(source);
  const asset = useAssetUrlState(
    "environmentId" in source ? source.environmentId : null,
    "resource" in source ? source.resource : null,
  );
  const refreshAssetUrl = useRefreshAssetUrl(
    "environmentId" in source ? source.environmentId : null,
    "resource" in source ? source.resource : null,
  );
  const uri = mediaVideoPreviewUri(source, asset._tag === "Success" ? asset.url : null);
  const [fullscreen, setFullscreen] = useState(false);
  return (
    <>
      <MediaVideoPlayer
        key={thumbnailKey}
        uri={uri}
        resolvePlaybackUri={
          "resource" in source
            ? async () => mediaVideoPreviewUri(source, await refreshAssetUrl())
            : undefined
        }
        name={source.name}
        thumbnailKey={thumbnailKey}
        thumbnailVisible={visible}
        visible={visible}
        onPlaybackStart={props.onPlaybackStart}
        unavailable={"resource" in source && asset._tag === "Failure"}
        actionsSource={source.actionsSource}
        borderRadius={props.borderRadius}
        // AVKit omits its fullscreen control at inline sizes, so iOS plays in the native fullscreen player.
        onPressPlay={Platform.OS === "ios" ? () => setFullscreen(true) : undefined}
      />
      {fullscreen ? (
        <VideoPreviewModal source={source} onRequestClose={() => setFullscreen(false)} />
      ) : null}
    </>
  );
}
