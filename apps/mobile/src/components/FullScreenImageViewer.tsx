import { useCallback, useMemo } from "react";
import ImageViewing from "react-native-image-viewing";

import type { FullScreenImageSource } from "../lib/fullScreenImageActions";
import { useShareImage } from "../lib/useShareImage";

/**
 * Fullscreen image viewer. Long-pressing the image opens the system share
 * sheet, which is where both platforms already put Copy and Save Image, so
 * this owns no chrome of its own.
 */
export function FullScreenImageViewer(props: {
  readonly source: FullScreenImageSource | null;
  readonly onRequestClose: () => void;
}) {
  const { source } = props;
  const share = useShareImage();

  const images = useMemo(
    () => (source === null ? [] : [{ uri: source.uri, cache: source.cache }]),
    [source],
  );

  const onLongPress = useCallback(() => {
    if (source !== null) {
      share(source);
    }
  }, [share, source]);

  return (
    <ImageViewing
      images={images}
      imageIndex={0}
      visible={source !== null}
      onRequestClose={props.onRequestClose}
      onLongPress={onLongPress}
      swipeToCloseEnabled
      doubleTapToZoomEnabled
    />
  );
}
