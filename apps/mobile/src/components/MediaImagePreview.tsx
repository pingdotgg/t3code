import { createContext, useContext, useState, useMemo } from "react";
import { Pressable, View } from "react-native";
import ImageViewing from "react-native-image-viewing";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useMediaActions } from "../state/mediaActions";
import { AppText } from "./AppText";
import { SymbolView } from "./AppSymbol";
import type { ResolvedFilePreviewSource } from "./FilePreviewModal.types";
import { MediaActionsMenu } from "./MediaActionsMenu";
import { MediaSourceCaption } from "./MediaSourceCaption";

type MediaImagePreviewProps = {
  readonly source: ResolvedFilePreviewSource;
  readonly onRequestClose: () => void;
};

const ImagePreviewContext = createContext<MediaImagePreviewProps | null>(null);

function ImagePreviewHeader() {
  const props = useContext(ImagePreviewContext)!;
  const insets = useSafeAreaInsets();
  const mediaActions = useMediaActions(props.source.actionsSource, props.onRequestClose);
  return (
    <View className="bg-black/70" style={{ paddingTop: insets.top }}>
      <View className="flex-row items-center gap-2 px-3">
        <AppText className="flex-1 text-base text-white" numberOfLines={2}>
          {props.source.name ?? "Image"}
        </AppText>
        <MediaActionsMenu media={mediaActions} inModal />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close image"
          onPress={props.onRequestClose}
          className="min-h-11 min-w-11 items-center justify-center"
        >
          <SymbolView name="xmark" size={20} tintColor="#ffffff" type="monochrome" />
        </Pressable>
      </View>
      <MediaSourceCaption source={mediaActions.title} />
    </View>
  );
}

/** Android keeps media actions in its in-app image viewer. iOS uses Quick Look. */
export function MediaImagePreview(props: MediaImagePreviewProps) {
  const gallery = props.source.gallery ?? [props.source];
  const [index, setIndex] = useState(() =>
    Math.max(
      0,
      gallery.findIndex((item) => item.uri === props.source.uri),
    ),
  );
  const selected = gallery[index] ?? props.source;
  const context = useMemo(() => ({ ...props, source: selected }), [props, selected]);
  return (
    <ImagePreviewContext value={context}>
      <ImageViewing
        images={gallery.map((item) => ({ uri: item.uri }))}
        imageIndex={index}
        onImageIndexChange={setIndex}
        visible
        presentationStyle="fullScreen"
        onRequestClose={props.onRequestClose}
        swipeToCloseEnabled={false}
        doubleTapToZoomEnabled
        HeaderComponent={ImagePreviewHeader}
      />
    </ImagePreviewContext>
  );
}
