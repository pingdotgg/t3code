import { View } from "react-native";

import { MediaVideoPlayer } from "../../components/MediaVideoPlayer";
import type { MediaVideoPreviewSource } from "../../lib/videoPreviewSource";

/** Uses the signed progressive URL directly; choosing a file never preloads its video bytes as text. */
export function WorkspaceFileVideoPreview(props: {
  readonly name: string;
  readonly thumbnailKey: string;
  readonly uri: string | null;
  readonly source: MediaVideoPreviewSource | null;
  readonly resolvePlaybackUri: () => Promise<string | null>;
}) {
  const uri = props.uri;

  return (
    <View className="flex-1 items-center justify-center bg-sheet p-4">
      <MediaVideoPlayer
        uri={uri}
        resolvePlaybackUri={props.resolvePlaybackUri}
        name={props.name}
        thumbnailKey={props.thumbnailKey}
        actionsSource={props.source?.actionsSource}
      />
    </View>
  );
}
