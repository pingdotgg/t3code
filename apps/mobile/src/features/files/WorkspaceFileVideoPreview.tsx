import { View } from "react-native";

import { useBarOverlap } from "../../components/ui/useBarInset";
import { MediaVideoPlayer } from "../../components/MediaVideoPlayer";
import type { MediaVideoPreviewSource } from "../../lib/videoPreviewSource";

export function WorkspaceFileVideoPreview(props: {
  readonly name: string;
  readonly thumbnailKey: string;
  readonly uri: string | null;
  readonly source: MediaVideoPreviewSource | null;
  readonly resolvePlaybackUri: () => Promise<string | null>;
}) {
  const uri = props.uri;
  const barOverlap = useBarOverlap();

  return (
    <View
      className="flex-1 items-center justify-center bg-sheet p-4"
      style={{ marginTop: barOverlap }}
    >
      <MediaVideoPlayer
        uri={uri}
        resolvePlaybackUri={props.resolvePlaybackUri}
        name={props.name}
        thumbnailKey={props.thumbnailKey}
        fitToVideo
        actionsSource={props.source?.actionsSource}
      />
    </View>
  );
}
