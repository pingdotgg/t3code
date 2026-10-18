import { createContext, useContext, useState } from "react";
import { Pressable, View } from "react-native";
import ImageViewing from "react-native-image-viewing";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useMediaActions } from "../state/mediaActions";
import { AppText } from "./ui/AppText";
import { SymbolView } from "./ui/AppSymbol";
import type { ResolvedFilePreviewSource } from "./FilePreviewModal.types";
import { MediaActionsMenu } from "./MediaActionsMenu";
import { MediaSourceCaption } from "./MediaSourceCaption";

type MediaImagePreviewProps = {
  readonly source: ResolvedFilePreviewSource;
  readonly onRequestClose: () => void;
};

const ImagePreviewContext = createContext<MediaImagePreviewProps | null>(null);

function ImagePreviewHeader(header: { readonly imageIndex: number }) {
  const props = useContext(ImagePreviewContext)!;
  const source = props.source.gallery?.[header.imageIndex] ?? props.source;
  const insets = useSafeAreaInsets();
  const mediaActions = useMediaActions(source.actionsSource, props.onRequestClose);
  return (
    <View className="bg-black/70" style={{ paddingTop: insets.top }}>
      <View className="flex-row items-center gap-2 px-3">
        <AppText className="flex-1 text-base text-white" numberOfLines={2}>
          {source.name ?? "Image"}
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

export function MediaImagePreview(props: MediaImagePreviewProps) {
  const gallery = props.source.gallery ?? [props.source];
  // react-native-image-viewing keys its whole Modal by imageIndex, so changing it remounts the
  // viewer and replays the Android fade over the screen behind. Keep the opening index; the
  // header follows paging through the index the library passes it.
  const [initialIndex] = useState(() =>
    Math.max(
      0,
      gallery.findIndex((item) => item.uri === props.source.uri),
    ),
  );
  return (
    <ImagePreviewContext value={props}>
      <ImageViewing
        images={gallery.map((item) => ({ uri: item.uri }))}
        imageIndex={initialIndex}
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
