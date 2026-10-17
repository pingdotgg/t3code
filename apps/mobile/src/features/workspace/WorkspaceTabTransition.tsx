import type { ReactNode } from "react";
import Animated, {
  Easing,
  FadeOut,
  Keyframe,
  LayoutAnimationConfig,
} from "react-native-reanimated";

// Material 3 fade through for top-level destinations: the outgoing tab fades out
// quickly, then the incoming tab fades in while growing from 92%.
const ENTERING = new Keyframe({
  0: { opacity: 0, transform: [{ scale: 0.92 }] },
  100: { opacity: 1, transform: [{ scale: 1 }], easing: Easing.bezier(0.05, 0.7, 0.1, 1) },
})
  .duration(210)
  .delay(90);
const EXITING = FadeOut.duration(90);

/** Remounts its content per tab with the fade-through; the first tab appears without it. */
export function WorkspaceTabTransition(props: {
  readonly tab: string;
  readonly children: ReactNode;
}) {
  return (
    <LayoutAnimationConfig skipEntering>
      <Animated.View key={props.tab} className="flex-1" entering={ENTERING} exiting={EXITING}>
        {props.children}
      </Animated.View>
    </LayoutAnimationConfig>
  );
}
