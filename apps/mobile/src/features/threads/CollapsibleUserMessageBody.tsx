import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  Pressable,
  View,
  type ColorValue,
  type LayoutChangeEvent,
  type ViewInstance,
} from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { AppText as Text } from "../../components/ui/AppText";

const FOLDED_HEIGHT = 176;

// Fold only when opening at least doubles what is on screen, matching web's useTallEnoughToFold.
const isTallEnoughToFold = (height: number) => height >= FOLDED_HEIGHT * 2;

export function CollapsibleUserMessageBody(props: {
  readonly collapsible: boolean;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly bubbleColor: ColorValue;
  readonly children: ReactNode;
}) {
  const gradientId = `user-message-fade-${useId().replaceAll(":", "")}`;
  const contentRef = useRef<ViewInstance>(null);
  const [tallEnough, setTallEnough] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the fold depends on the rendered height; measuring before paint avoids one unfolded frame
  useLayoutEffect(() => {
    const height = contentRef.current?.getBoundingClientRect().height;
    if (height !== undefined) setTallEnough(isTallEnoughToFold(height));
  }, []);
  const canCollapse = props.collapsible && tallEnough;
  const collapsed = canCollapse && !props.expanded;

  return (
    <View>
      <View style={collapsed ? { height: FOLDED_HEIGHT, overflow: "hidden" } : undefined}>
        <View
          ref={contentRef}
          // Out of flow while folded: Yoga squeezes in-flow children to the clip, which reads as short and unfolds.
          style={collapsed ? { position: "absolute", top: 0, left: 0, right: 0 } : undefined}
          onLayout={(event: LayoutChangeEvent) =>
            setTallEnough(isTallEnoughToFold(event.nativeEvent.layout.height))
          }
        >
          {props.children}
        </View>
        {collapsed ? (
          <View pointerEvents="none" className="absolute inset-x-0 bottom-0 h-7">
            <Svg width="100%" height="100%">
              <Defs>
                <LinearGradient id={gradientId} x1="0%" x2="0%" y1="0%" y2="100%">
                  <Stop offset={0} stopColor={props.bubbleColor} stopOpacity={0} />
                  <Stop offset={1} stopColor={props.bubbleColor} stopOpacity={1} />
                </LinearGradient>
              </Defs>
              <Rect width="100%" height="100%" fill={`url(#${gradientId})`} />
            </Svg>
          </View>
        ) : null}
      </View>
      {canCollapse ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: props.expanded }}
          onPress={props.onToggle}
          className="mt-1.5 min-h-11 items-end justify-center active:opacity-70"
        >
          <Text className="font-t3-medium text-xs text-user-bubble-foreground-muted">
            {props.expanded ? "Show less" : "Show full message"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
