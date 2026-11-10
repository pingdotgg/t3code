import { Pressable, View } from "react-native";

import type { useMediaActions } from "../state/mediaActions";
import { SymbolView } from "./ui/AppSymbol";
import { AppText } from "./ui/AppText";
import { MediaActionsMenu } from "./MediaActionsMenu";
import { MediaSourceCaption } from "./MediaSourceCaption";

/** The bar over a full-screen image or video: always dark, whatever the app theme. */
export function MediaPreviewHeader(props: {
  readonly title: string;
  readonly media: ReturnType<typeof useMediaActions>;
  readonly closeAccessibilityLabel: string;
  readonly onClose: () => void;
}) {
  return (
    <>
      <View className="min-h-14 flex-row items-center gap-3 pl-4 pr-2">
        <AppText className="flex-1 font-t3-medium text-base text-white" numberOfLines={2}>
          {props.title}
        </AppText>
        <MediaActionsMenu media={props.media} inModal />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={props.closeAccessibilityLabel}
          onPress={props.onClose}
          className="size-12 items-center justify-center"
        >
          <SymbolView name="xmark" size={20} tintColor="#ffffff" type="monochrome" />
        </Pressable>
      </View>
      <MediaSourceCaption source={props.media.title} />
    </>
  );
}
