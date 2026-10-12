import { createContext, useContext } from "react";
import { MediaVideoPlayer } from "../../components/MediaVideoPlayer";
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
  return (
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
      unavailable={"resource" in source && asset._tag === "Failure"}
      actionsSource={source.actionsSource}
    />
  );
}
