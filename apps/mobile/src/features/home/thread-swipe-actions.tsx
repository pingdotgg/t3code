import { SymbolView } from "expo-symbols";
import * as Haptics from "expo-haptics";
import { useCallback, useRef, type ComponentProps, type ReactNode } from "react";
import type { ColorValue, StyleProp, ViewStyle } from "react-native";
import { Pressable, View } from "react-native";
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";
import Animated, {
  Extrapolation,
  interpolate,
  runOnJS,
  type SharedValue,
  useAnimatedReaction,
  useAnimatedStyle,
} from "react-native-reanimated";

import { AppText as Text } from "../../components/AppText";

const ACTION_ITEM_WIDTH = 50;
const ACTION_CIRCLE_SIZE = 36;
const ACTION_ICON_SIZE = 15;

export const THREAD_SWIPE_ACTIONS_WIDTH = ACTION_ITEM_WIDTH * 2;
export const THREAD_SWIPE_SPRING = {
  damping: 26,
  mass: 0.7,
  overshootClamping: true,
  stiffness: 330,
};

interface ThreadSwipePrimaryAction {
  readonly accessibilityLabel: string;
  readonly icon: ComponentProps<typeof SymbolView>["name"];
  readonly label: string;
  readonly onPress: () => void;
}

export function ThreadSwipeable(props: {
  readonly backgroundColor: ColorValue;
  readonly children: (close: () => void) => ReactNode;
  readonly containerStyle?: StyleProp<ViewStyle>;
  readonly enableTrackpadSwipe?: boolean;
  readonly fullSwipeWidth: number;
  readonly onDelete: () => void;
  readonly onSwipeableClose?: (methods: SwipeableMethods) => void;
  readonly onSwipeableWillOpen?: (methods: SwipeableMethods) => void;
  readonly primaryAction: ThreadSwipePrimaryAction;
  readonly simultaneousWithExternalGesture?: ComponentProps<
    typeof ReanimatedSwipeable
  >["simultaneousWithExternalGesture"];
  readonly threadTitle: string;
}) {
  const swipeableRef = useRef<SwipeableMethods | null>(null);
  const fullSwipeArmedRef = useRef(false);
  const fullSwipeThreshold = Math.max(THREAD_SWIPE_ACTIONS_WIDTH + 44, props.fullSwipeWidth * 0.58);
  const close = useCallback(() => swipeableRef.current?.close(), []);
  const handleFullSwipeArmedChange = useCallback((armed: boolean) => {
    if (armed && !fullSwipeArmedRef.current && process.env.EXPO_OS === "ios") {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    fullSwipeArmedRef.current = armed;
  }, []);

  return (
    <ReanimatedSwipeable
      ref={swipeableRef}
      animationOptions={THREAD_SWIPE_SPRING}
      childrenContainerStyle={{ backgroundColor: props.backgroundColor }}
      containerStyle={[{ backgroundColor: props.backgroundColor }, props.containerStyle]}
      dragOffsetFromRightEdge={8}
      enableTrackpadTwoFingerGesture={props.enableTrackpadSwipe ?? true}
      friction={1}
      onSwipeableClose={() => {
        fullSwipeArmedRef.current = false;
        if (swipeableRef.current) {
          props.onSwipeableClose?.(swipeableRef.current);
        }
      }}
      onSwipeableOpenStartDrag={() => {
        if (swipeableRef.current) {
          props.onSwipeableWillOpen?.(swipeableRef.current);
        }
      }}
      onSwipeableWillOpen={() => {
        const methods = swipeableRef.current;
        if (!methods) {
          return;
        }

        props.onSwipeableWillOpen?.(methods);
        if (fullSwipeArmedRef.current) {
          fullSwipeArmedRef.current = false;
          methods.close();
          props.onDelete();
        }
      }}
      overshootFriction={1}
      overshootRight
      renderRightActions={(_progress, translation, methods) => (
        <ThreadSwipeActions
          backgroundColor={props.backgroundColor}
          fullSwipeThreshold={fullSwipeThreshold}
          onDelete={props.onDelete}
          onFullSwipeArmedChange={handleFullSwipeArmedChange}
          primaryAction={{
            ...props.primaryAction,
            onPress: () => {
              methods.close();
              props.primaryAction.onPress();
            },
          }}
          swipeableMethods={methods}
          threadTitle={props.threadTitle}
          translation={translation}
        />
      )}
      rightThreshold={THREAD_SWIPE_ACTIONS_WIDTH * 0.42}
      simultaneousWithExternalGesture={props.simultaneousWithExternalGesture}
    >
      {props.children(close)}
    </ReanimatedSwipeable>
  );
}

function SwipeActionButton(props: {
  readonly accessibilityLabel: string;
  readonly backgroundColor: string;
  readonly entryRange: readonly [number, number];
  readonly fullSwipeThreshold: number;
  readonly icon: ComponentProps<typeof SymbolView>["name"];
  readonly label: string;
  readonly onPress: () => void;
  readonly stretchesOnFullSwipe: boolean;
  readonly translation: SharedValue<number>;
}) {
  const actionStyle = useAnimatedStyle(() => {
    const reveal = Math.max(-props.translation.value, 0);
    const entryProgress = interpolate(reveal, props.entryRange, [0, 1], Extrapolation.CLAMP);
    const stretch = Math.max(reveal - THREAD_SWIPE_ACTIONS_WIDTH, 0);
    const fullSwipeProgress = interpolate(
      reveal,
      [THREAD_SWIPE_ACTIONS_WIDTH, props.fullSwipeThreshold + 20],
      [0, 1],
      Extrapolation.CLAMP,
    );

    return {
      opacity: props.stretchesOnFullSwipe ? entryProgress : entryProgress * (1 - fullSwipeProgress),
      transform: [
        {
          translateX:
            interpolate(entryProgress, [0, 1], [22, 0]) -
            (props.stretchesOnFullSwipe ? 0 : stretch),
        },
        { scale: interpolate(entryProgress, [0, 1], [0.78, 1]) },
      ],
    };
  });
  const circleStyle = useAnimatedStyle(() => {
    const reveal = Math.max(-props.translation.value, 0);
    const stretch = props.stretchesOnFullSwipe
      ? Math.max(reveal - THREAD_SWIPE_ACTIONS_WIDTH, 0)
      : 0;

    return {
      transform: [{ translateX: -stretch }],
      width: ACTION_CIRCLE_SIZE + stretch,
    };
  });
  const iconStyle = useAnimatedStyle(() => {
    const reveal = Math.max(-props.translation.value, 0);
    const stretch = props.stretchesOnFullSwipe
      ? Math.max(reveal - THREAD_SWIPE_ACTIONS_WIDTH, 0)
      : 0;
    const armedProgress = interpolate(
      reveal,
      [props.fullSwipeThreshold, props.fullSwipeThreshold + 20],
      [0, 1],
      Extrapolation.CLAMP,
    );

    return {
      transform: [{ translateX: -stretch * (0.5 + armedProgress * 0.5) }],
    };
  });
  const labelStyle = useAnimatedStyle(() => {
    if (!props.stretchesOnFullSwipe) {
      return { opacity: 1 };
    }

    const reveal = Math.max(-props.translation.value, 0);
    const stretch = Math.max(reveal - THREAD_SWIPE_ACTIONS_WIDTH, 0);
    return {
      opacity: interpolate(
        reveal,
        [props.fullSwipeThreshold - 24, props.fullSwipeThreshold],
        [1, 0],
        Extrapolation.CLAMP,
      ),
      transform: [{ translateX: -stretch * 0.5 }],
    };
  });

  return (
    <Animated.View
      style={[
        {
          alignItems: "center",
          height: "100%",
          justifyContent: "center",
          width: ACTION_ITEM_WIDTH,
          zIndex: props.stretchesOnFullSwipe ? 2 : 1,
        },
        actionStyle,
      ]}
    >
      <Pressable
        accessibilityLabel={props.accessibilityLabel}
        accessibilityRole="button"
        onPress={props.onPress}
        style={({ pressed }) => ({
          alignItems: "center",
          height: "100%",
          justifyContent: "center",
          opacity: pressed ? 0.72 : 1,
          width: "100%",
        })}
      >
        <View style={{ height: ACTION_CIRCLE_SIZE, width: ACTION_CIRCLE_SIZE }}>
          <Animated.View
            style={[
              {
                backgroundColor: props.backgroundColor,
                borderRadius: 999,
                height: ACTION_CIRCLE_SIZE,
                left: 0,
                position: "absolute",
                top: 0,
              },
              circleStyle,
            ]}
          />
          <Animated.View
            style={[
              {
                alignItems: "center",
                height: ACTION_CIRCLE_SIZE,
                justifyContent: "center",
                left: 0,
                position: "absolute",
                top: 0,
                width: ACTION_CIRCLE_SIZE,
              },
              iconStyle,
            ]}
          >
            <SymbolView
              name={props.icon}
              size={ACTION_ICON_SIZE}
              tintColor="#ffffff"
              type="monochrome"
            />
          </Animated.View>
        </View>
        <Animated.View style={[{ paddingTop: 2 }, labelStyle]}>
          <Text className="text-3xs font-t3-medium text-foreground-muted">{props.label}</Text>
        </Animated.View>
      </Pressable>
    </Animated.View>
  );
}

export function ThreadSwipeActions(props: {
  readonly backgroundColor: ColorValue;
  readonly fullSwipeThreshold: number;
  readonly onDelete: () => void;
  readonly onFullSwipeArmedChange: (armed: boolean) => void;
  readonly primaryAction: ThreadSwipePrimaryAction;
  readonly swipeableMethods: SwipeableMethods;
  readonly threadTitle: string;
  readonly translation: SharedValue<number>;
}) {
  useAnimatedReaction(
    () => -props.translation.value >= props.fullSwipeThreshold,
    (armed, previous) => {
      if (armed !== previous) {
        runOnJS(props.onFullSwipeArmedChange)(armed);
      }
    },
    [props.fullSwipeThreshold, props.onFullSwipeArmedChange],
  );

  return (
    <View
      style={{
        backgroundColor: props.backgroundColor,
        flexDirection: "row",
        height: "100%",
        width: THREAD_SWIPE_ACTIONS_WIDTH,
      }}
    >
      <SwipeActionButton
        accessibilityLabel={props.primaryAction.accessibilityLabel}
        backgroundColor="#007aff"
        entryRange={[ACTION_ITEM_WIDTH * 0.55, THREAD_SWIPE_ACTIONS_WIDTH * 0.85]}
        fullSwipeThreshold={props.fullSwipeThreshold}
        icon={props.primaryAction.icon}
        label={props.primaryAction.label}
        onPress={props.primaryAction.onPress}
        stretchesOnFullSwipe={false}
        translation={props.translation}
      />
      <SwipeActionButton
        accessibilityLabel={`Delete ${props.threadTitle}`}
        backgroundColor="#ff2d55"
        entryRange={[8, ACTION_ITEM_WIDTH * 0.72]}
        fullSwipeThreshold={props.fullSwipeThreshold}
        icon="trash"
        label="Delete"
        onPress={() => {
          props.swipeableMethods.close();
          props.onDelete();
        }}
        stretchesOnFullSwipe
        translation={props.translation}
      />
    </View>
  );
}
