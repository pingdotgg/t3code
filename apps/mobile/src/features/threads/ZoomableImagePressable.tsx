import { useEffectEvent, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { Platform, Pressable, StyleSheet } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from "react-native-reanimated";

const MAX_INLINE_ZOOM = 6;
// Below UIScrollView's drag hysteresis, so a zoomed pan wins over the feed scroll.
const ZOOMED_PAN_MIN_DISTANCE = 5;

type Zoom = { readonly scale: number; readonly x: number; readonly y: number };
type Size = { readonly width: number; readonly height: number };

const FIT: Zoom = { scale: 1, x: 0, y: 0 };

/** Keeps the scaled content covering the frame: translation is about the frame center. */
function clampZoom(zoom: Zoom, size: Size): Zoom {
  "worklet";
  const scale = Math.min(Math.max(zoom.scale, 1), MAX_INLINE_ZOOM);
  const maxX = ((scale - 1) * size.width) / 2;
  const maxY = ((scale - 1) * size.height) / 2;
  return {
    scale,
    x: Math.min(Math.max(zoom.x, -maxX), maxX),
    y: Math.min(Math.max(zoom.y, -maxY), maxY),
  };
}

type ZoomableImagePressableProps = Omit<ComponentProps<typeof Pressable>, "children"> & {
  readonly children: ReactNode;
};

/**
 * Inline chat image that pinch-zooms in place on iOS. Key it by image source so a
 * new source starts at fit; ordinary rerenders keep the zoom and offset.
 */
export function ZoomableImagePressable(props: ZoomableImagePressableProps) {
  if (Platform.OS !== "ios") return <Pressable {...props} />;
  return <IosZoomableImagePressable {...props} />;
}

function IosZoomableImagePressable({
  children,
  onTouchStart,
  onPress,
  onLayout,
  ...pressableProps
}: ZoomableImagePressableProps) {
  const gestured = useRef(false);
  const layoutSize = useRef<Size | null>(null);
  const zoom = useSharedValue(FIT);
  const size = useSharedValue<Size>({ width: 0, height: 0 });
  const pinching = useSharedValue(false);
  const pinchStart = useSharedValue({ zoom: FIT, focalX: 0, focalY: 0, scale: 1, pointers: 0 });
  const panStart = useSharedValue({ zoom: FIT, translationX: 0, translationY: 0 });

  const markGestured = useEffectEvent(() => {
    gestured.current = true;
  });
  const [gesture] = useState(() => {
    // Focal points arrive in the untransformed frame; the transform is about its center.
    const pinch = Gesture.Pinch()
      .onStart((event) => {
        const frame = size.get();
        pinching.set(true);
        pinchStart.set({
          zoom: zoom.get(),
          focalX: event.focalX - frame.width / 2,
          focalY: event.focalY - frame.height / 2,
          scale: event.scale,
          pointers: event.numberOfPointers,
        });
        runOnJS(markGestured)();
      })
      .onUpdate((event) => {
        const frame = size.get();
        const start = pinchStart.get();
        const focalX = event.focalX - frame.width / 2;
        const focalY = event.focalY - frame.height / 2;
        if (event.numberOfPointers !== start.pointers) {
          // A lifted or added finger jumps the focal point; continue from here instead.
          pinchStart.set({
            zoom: zoom.get(),
            focalX,
            focalY,
            scale: event.scale,
            pointers: event.numberOfPointers,
          });
          return;
        }
        const scale = Math.min(
          Math.max((start.zoom.scale * event.scale) / start.scale, 1),
          MAX_INLINE_ZOOM,
        );
        // Keep the content point that started under the fingers under them.
        const contentX = (start.focalX - start.zoom.x) / start.zoom.scale;
        const contentY = (start.focalY - start.zoom.y) / start.zoom.scale;
        zoom.set(
          clampZoom({ scale, x: focalX - scale * contentX, y: focalY - scale * contentY }, frame),
        );
      })
      .onFinalize(() => {
        panStart.set({ ...panStart.get(), zoom: zoom.get() });
        pinching.set(false);
      });
    const pan = Gesture.Pan()
      .minDistance(ZOOMED_PAN_MIN_DISTANCE)
      .onTouchesDown((_event, manager) => {
        // At fit, a one-finger drag belongs to the feed.
        if (zoom.get().scale <= 1) manager.fail();
      })
      .onStart((event) => {
        panStart.set({
          zoom: zoom.get(),
          translationX: event.translationX,
          translationY: event.translationY,
        });
        runOnJS(markGestured)();
      })
      .onUpdate((event) => {
        if (pinching.get()) {
          // The pinch owns the transform; resume panning from wherever it leaves it.
          panStart.set({
            zoom: zoom.get(),
            translationX: event.translationX,
            translationY: event.translationY,
          });
          return;
        }
        const start = panStart.get();
        zoom.set(
          clampZoom(
            {
              scale: start.zoom.scale,
              x: start.zoom.x + event.translationX - start.translationX,
              y: start.zoom.y + event.translationY - start.translationY,
            },
            size.get(),
          ),
        );
      });
    return Gesture.Simultaneous(pinch, pan);
  });
  const contentStyle = useAnimatedStyle(() => {
    const { scale, x, y } = zoom.get();
    return { transform: [{ translateX: x }, { translateY: y }, { scale }] };
  });

  return (
    <GestureDetector gesture={gesture}>
      <Pressable
        {...pressableProps}
        onTouchStart={(event) => {
          gestured.current = event.nativeEvent.touches.length > 1;
          onTouchStart?.(event);
        }}
        onPress={(event) => {
          // Accessibility activation carries no touch identifier and no gesture.
          if (typeof event.nativeEvent.identifier === "number" && gestured.current) return;
          onPress?.(event);
        }}
        onLayout={(event) => {
          const { width, height } = event.nativeEvent.layout;
          const previous = layoutSize.current;
          if (previous?.width !== width || previous?.height !== height) {
            // The old offsets no longer fit the new frame, so a resize starts over at fit.
            layoutSize.current = { width, height };
            size.set({ width, height });
            zoom.set(FIT);
          }
          onLayout?.(event);
        }}
      >
        <Animated.View style={[StyleSheet.absoluteFill, contentStyle]}>{children}</Animated.View>
      </Pressable>
    </GestureDetector>
  );
}
