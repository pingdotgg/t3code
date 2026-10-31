import { useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
} from "react-native-reanimated";

import { SegmentedControl } from "../../components/ui/SegmentedControl";
import type { PullRequestTabControl, PullRequestTabControlProps } from "./PullRequestTabControl";

export type {
  PullRequestSection,
  PullRequestTabControl,
  PullRequestTabControlProps,
} from "./PullRequestTabControl";

// The screen keeps one list per tab, and a control in each list header. When the tapped control's
// list hides, UIKit keeps drawing its glass lens over the next list's control. So one control
// above the lists takes the taps and follows the shown list's scroll. Under the bar, the header
// copies take over, so the scroll edge effect still covers the control.
export function usePullRequestTabControl(props: PullRequestTabControlProps): PullRequestTabControl {
  const overviewScroll = useSharedValue(0);
  const guideScroll = useSharedValue(0);
  const activityScroll = useSharedValue(0);
  const [listScroll] = useState(() => ({
    overview: { scrollOffset: overviewScroll },
    guide: { scrollOffset: guideScroll },
    activity: { scrollOffset: activityScroll },
  }));
  const layout = useRef<{ header?: number; control?: number }>({});
  // A shared value, not state, so a header layout change moves the control without a re-render.
  const controlY = useSharedValue<number | null>(null);
  // The two onLayout events can arrive in either order. Until both have, the header copy shows.
  const measure = () => {
    const { header, control } = layout.current;
    if (header !== undefined && control !== undefined) {
      controlY.set(props.listPaddingTop + header + control);
    }
  };
  const shownScroll = listScroll[props.selected].scrollOffset;
  const { barInsetTop } = props;
  const underBar = useDerivedValue(
    () => controlY.value === null || controlY.value - shownScroll.value < barInsetTop,
  );
  const overlayStyle = useAnimatedStyle(() => ({
    opacity: underBar.value ? 0 : 1,
    transform: [{ translateY: (controlY.value ?? 0) - shownScroll.value }],
  }));
  const headerStyle = useAnimatedStyle(() => ({ opacity: underBar.value ? 1 : 0 }));
  // Touch follows whichever copy shows. It changes only when the control crosses the bar, so
  // the JS state does not update while scrolling.
  const [headerShown, setHeaderShown] = useState(true);
  useAnimatedReaction(
    () => underBar.value,
    (shown, previous) => {
      if (shown !== previous) runOnJS(setHeaderShown)(shown);
    },
  );
  const control = (
    <SegmentedControl
      options={props.options}
      selected={props.selected}
      onSelect={props.onSelect}
      role="tab"
      size="compact"
    />
  );
  return {
    listSharedValues: (section) => listScroll[section],
    onHeaderLayout: (y) => {
      layout.current.header = y;
      measure();
    },
    header: (
      <View
        onLayout={(event) => {
          layout.current.control = event.nativeEvent.layout.y;
          measure();
        }}
      >
        <Animated.View
          style={headerStyle}
          pointerEvents={headerShown ? "auto" : "none"}
          accessibilityElementsHidden
        >
          {control}
        </Animated.View>
        {/* VoiceOver skips views at opacity 0 and reads the overlay after the lists, so these
            invisible tabs keep the reading order. Their taps land on the control under them. */}
        <View
          style={StyleSheet.absoluteFill}
          className="flex-row"
          pointerEvents="none"
          accessibilityRole="tabbar"
        >
          {props.options.map((option) => (
            <View
              key={option.value}
              className="flex-1"
              accessible
              accessibilityRole="tab"
              accessibilityLabel={option.label}
              accessibilityState={{ selected: option.value === props.selected }}
            />
          ))}
        </View>
      </View>
    ),
    overlay: (
      <Animated.View
        style={[{ position: "absolute", top: 0, left: 16, right: 16 }, overlayStyle]}
        accessibilityElementsHidden
      >
        {control}
      </Animated.View>
    ),
  };
}
