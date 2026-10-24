import { createContext, useContext } from "react";
import { MarkdownImageAssetScopeContext } from "./ThreadMarkdownImage";
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
  const scope = useContext(MarkdownImageAssetScopeContext);
  const source =
    "resource" in props.source
      ? { ...props.source, scope: props.source.scope ?? scope }
      : props.source;
  const feedVisible = useContext(ThreadMediaVisibleContext);
  const visible = props.thumbnailVisible ?? feedVisible;
  const thumbnailKey = mediaVideoThumbnailKey(source);
  const asset = useAssetUrlState(
    "environmentId" in source ? source.environmentId : null,
    "resource" in source ? source.resource : null,
    "resource" in source ? source.scope : undefined,
  );
  const refreshAssetUrl = useRefreshAssetUrl(
    "environmentId" in source ? source.environmentId : null,
    "resource" in source ? source.resource : null,
    "resource" in source ? source.scope : undefined,
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
      actionsSource={
        source.actionsSource && "resource" in source.actionsSource
          ? { ...source.actionsSource, scope: "resource" in source ? source.scope : undefined }
          : source.actionsSource
      }
    />
  );
}
