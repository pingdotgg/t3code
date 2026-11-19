import { useGT } from "gt-react-native";
import { createContext, useContext, useId } from "react";
import { MediaVideoPlayer } from "../../components/MediaVideoPlayer";
import { workspaceMediaAssetRevision } from "../../state/asset-url-state";
import { useAssetUrlState, useRefreshAssetUrl } from "../../state/assets";
import {
  mediaVideoPreviewUri,
  mediaVideoThumbnailKey,
  type MediaVideoPreviewSource,
} from "../../lib/videoPreviewSource";
import { ThreadMediaVisitContext, WorkspaceMutationIdContext } from "./workspaceMutationIdContext";

export const ThreadMediaVisibleContext = createContext(false);
/** Asks the feed to keep this row out of list recycling while its media holds playback state. */
export const ThreadMediaRetainContext = createContext<(retained: boolean) => void>(() => {});

export function ThreadMarkdownVideo(props: {
  readonly source: MediaVideoPreviewSource;
  /** Keeps the player and its poster across source changes that show the same video. */
  readonly thumbnailKey?: string;
  readonly thumbnailVisible?: boolean;
  readonly onPlaybackStart?: () => void;
  readonly borderRadius?: number;
}) {
  const gt = useGT();
  const { source } = props;
  const feedVisible = useContext(ThreadMediaVisibleContext);
  const visible = props.thumbnailVisible ?? feedVisible;
  const mountId = useId();
  const visitId = useContext(ThreadMediaVisitContext);
  const workspaceMutationId = useContext(WorkspaceMutationIdContext);
  const environmentId = "environmentId" in source ? source.environmentId : null;
  const resource = "resource" in source ? source.resource : null;
  // Chat embeds share a visit across row recycling; standalone previews use their own mount.
  const asset = useAssetUrlState(
    environmentId,
    resource,
    workspaceMediaAssetRevision(resource, workspaceMutationId, visitId ?? mountId),
  );
  const playbackKey = props.thumbnailKey ?? mediaVideoThumbnailKey(source);
  const thumbnailKey =
    props.thumbnailKey ??
    (asset._tag === "Success" && asset.fileRevision !== undefined
      ? mediaVideoThumbnailKey(source, asset.fileRevision)
      : playbackKey);
  const refreshAssetUrl = useRefreshAssetUrl(environmentId, resource);
  const uri = mediaVideoPreviewUri(source, asset._tag === "Success" ? asset.url : null);
  return (
    <MediaVideoPlayer
      playbackKey={playbackKey}
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
      unavailableDetail={
        asset._tag === "Failure" && asset.reason === "missing-file-access"
          ? gt("This connection cannot read host files. Pair again with a new link to view it.")
          : undefined
      }
      actionsSource={source.actionsSource}
      borderRadius={props.borderRadius}
    />
  );
}
