import { useGT } from "gt-react-native";
import { createContext, useContext, useId } from "react";
import { MediaVideoPlayer } from "../../components/MediaVideoPlayer";
import { useAssetUrlState, useRefreshAssetUrl } from "../../state/assets";
import {
  mediaVideoPreviewUri,
  mediaVideoThumbnailKey,
  type MediaVideoPreviewSource,
} from "../../lib/videoPreviewSource";
import { WorkspaceMutationIdContext } from "./workspaceMutationIdContext";

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
  const workspaceMutationId = useContext(WorkspaceMutationIdContext);
  const hostFile =
    "resource" in source &&
    (source.resource._tag === "media-file" || source.resource._tag === "draft-workspace-file");
  // A host file can be replaced while no tile shows it, so each mount (and each agent edit)
  // asks the server for the file's current revision; an unchanged file keeps its URL.
  const asset = useAssetUrlState(
    "environmentId" in source ? source.environmentId : null,
    "resource" in source ? source.resource : null,
    hostFile ? `${mountId}:${workspaceMutationId ?? ""}` : undefined,
  );
  const thumbnailKey =
    props.thumbnailKey ??
    mediaVideoThumbnailKey(source, asset._tag === "Success" ? asset.fileRevision : undefined);
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
