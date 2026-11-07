import { useId } from "react";
import { View, type ScrollViewProps } from "react-native";
import Animated, {
  useAnimatedRef,
  useAnimatedStyle,
  useDerivedValue,
  useScrollOffset,
  useSharedValue,
  type AnimatedRef,
  type DerivedValue,
} from "react-native-reanimated";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";

// Matches web's 1.5rem scroll fade; a shorter fade reads as a clipped line.
const WORK_LOG_EDGE_FADE_HEIGHT = 24;

/** Fades whichever edge of a capped work-log scroller still hides content. */
export function WorkLogEdgeFades(props: {
  readonly color: string;
  readonly scrollOffset: DerivedValue<number>;
  /** Content height minus viewport height; zero or less when nothing is hidden. */
  readonly scrollableHeight: DerivedValue<number>;
}) {
  const { scrollOffset, scrollableHeight } = props;
  const topStyle = useAnimatedStyle(() => ({
    opacity: Math.min(1, Math.max(0, scrollOffset.value) / WORK_LOG_EDGE_FADE_HEIGHT),
  }));
  const bottomStyle = useAnimatedStyle(() => ({
    opacity: Math.min(
      1,
      Math.max(0, scrollableHeight.value - scrollOffset.value) / WORK_LOG_EDGE_FADE_HEIGHT,
    ),
  }));
  return (
    <>
      <Animated.View
        pointerEvents="none"
        className="absolute inset-x-0 top-0"
        style={[{ height: WORK_LOG_EDGE_FADE_HEIGHT }, topStyle]}
      >
        <EdgeFade color={props.color} direction="down" />
      </Animated.View>
      <Animated.View
        pointerEvents="none"
        className="absolute inset-x-0 bottom-0"
        style={[{ height: WORK_LOG_EDGE_FADE_HEIGHT }, bottomStyle]}
      >
        <EdgeFade color={props.color} direction="up" />
      </Animated.View>
    </>
  );
}

/** A capped work-log scroller whose clipped edges fade into the screen. */
export function WorkLogScrollView(
  props: Omit<ScrollViewProps, "ref"> & {
    readonly fadeColor: string;
    readonly scrollRef?: AnimatedRef<Animated.ScrollView>;
  },
) {
  const { fadeColor, scrollRef, onLayout, onContentSizeChange, ...scrollProps } = props;
  const ownRef = useAnimatedRef<Animated.ScrollView>();
  const ref = scrollRef ?? ownRef;
  const scrollOffset = useScrollOffset(ref);
  const viewportHeight = useSharedValue(0);
  const contentHeight = useSharedValue(0);
  const scrollableHeight = useDerivedValue(() => contentHeight.value - viewportHeight.value);
  return (
    <View>
      <Animated.ScrollView
        {...scrollProps}
        ref={ref}
        onLayout={(event) => {
          viewportHeight.set(event.nativeEvent.layout.height);
          onLayout?.(event);
        }}
        onContentSizeChange={(width, height) => {
          contentHeight.set(height);
          onContentSizeChange?.(width, height);
        }}
      />
      <WorkLogEdgeFades
        color={fadeColor}
        scrollOffset={scrollOffset}
        scrollableHeight={scrollableHeight}
      />
    </View>
  );
}

function EdgeFade(props: { readonly color: string; readonly direction: "up" | "down" }) {
  const gradientId = `work-log-fade-${useId().replaceAll(":", "")}`;
  return (
    <Svg width="100%" height="100%">
      <Defs>
        <LinearGradient id={gradientId} x1="0%" x2="0%" y1="0%" y2="100%">
          <Stop
            offset={0}
            stopColor={props.color}
            stopOpacity={props.direction === "down" ? 1 : 0}
          />
          <Stop
            offset={1}
            stopColor={props.color}
            stopOpacity={props.direction === "down" ? 0 : 1}
          />
        </LinearGradient>
      </Defs>
      <Rect width="100%" height="100%" fill={`url(#${gradientId})`} />
    </Svg>
  );
}
