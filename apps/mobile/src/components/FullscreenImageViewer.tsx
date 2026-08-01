import {
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  useWindowDimensions,
  View,
  type ImageURISource,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import ImageViewing from "react-native-image-viewing";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "./AppSymbol";

export type FullscreenImageSource = ImageURISource | number;

export function FullscreenImageViewer(props: {
  readonly source: FullscreenImageSource | null;
  readonly visible: boolean;
  readonly onRequestClose: () => void;
}) {
  const dimensions = useWindowDimensions();
  const insets = useSafeAreaInsets();

  if (!props.visible || props.source === null) return null;

  if (Platform.OS !== "ios") {
    return (
      <ImageViewing
        images={[props.source]}
        imageIndex={0}
        visible
        onRequestClose={props.onRequestClose}
        swipeToCloseEnabled
        doubleTapToZoomEnabled
      />
    );
  }

  const handleScrollEndDrag = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if ((event.nativeEvent.zoomScale ?? 1) > 1) return;
    if (Math.abs(event.nativeEvent.velocity?.y ?? 0) > 1.55) {
      props.onRequestClose();
    }
  };

  return (
    <Modal
      visible
      animationType="fade"
      presentationStyle="fullScreen"
      supportedOrientations={[
        "portrait",
        "portrait-upside-down",
        "landscape",
        "landscape-left",
        "landscape-right",
      ]}
      onRequestClose={props.onRequestClose}
    >
      <View style={{ flex: 1, backgroundColor: "#000000" }}>
        <ScrollView
          centerContent
          bouncesZoom
          maximumZoomScale={4}
          minimumZoomScale={1}
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
          style={{ flex: 1 }}
          contentContainerStyle={{
            width: dimensions.width,
            height: dimensions.height,
            alignItems: "center",
            justifyContent: "center",
          }}
          onScrollEndDrag={handleScrollEndDrag}
        >
          <Image
            source={props.source}
            resizeMode="contain"
            style={{ width: dimensions.width, height: dimensions.height }}
          />
        </ScrollView>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close image preview"
          hitSlop={12}
          onPress={props.onRequestClose}
          style={{
            position: "absolute",
            top: Math.max(insets.top, 12) + 8,
            right: Math.max(insets.right, 12) + 8,
            width: 44,
            height: 44,
            borderRadius: 22,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "rgba(0, 0, 0, 0.45)",
          }}
        >
          <SymbolView
            name="xmark"
            size={18}
            tintColor="#ffffff"
            type="monochrome"
            weight="semibold"
          />
        </Pressable>
      </View>
    </Modal>
  );
}
