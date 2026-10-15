import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import * as Haptics from "expo-haptics";
import { useEffect, useRef } from "react";
import Animated, { FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Toast } from "../../components/Toast";
import { APP_BAR_HEIGHT } from "../../lib/layoutMetrics";
import type { GitActionProgress } from "../../state/use-vcs-action-state";

export function GitActionProgressOverlay(props: {
  readonly progress: GitActionProgress;
  readonly onDismiss: () => void;
  readonly onOpenPullRequest?: (url: string) => Promise<boolean>;
}) {
  const { progress, onDismiss } = props;
  const openPullRequest = props.onOpenPullRequest;
  const insets = useSafeAreaInsets();
  const prevPhaseRef = useRef(progress.phase);

  useEffect(() => {
    const prev = prevPhaseRef.current;
    prevPhaseRef.current = progress.phase;

    if (prev === "running" && progress.phase === "success") {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else if (prev === "running" && progress.phase === "error") {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  }, [progress.phase]);

  const handlePress = () => {
    if (progress.prUrl) {
      void (openPullRequest
        ? openPullRequest(progress.prUrl)
        : tryOpenExternalUrl(progress.prUrl, "pull-request"));
      return;
    }
    if (progress.phase === "success" || progress.phase === "error") {
      onDismiss();
    }
  };

  if (progress.phase === "idle") {
    return null;
  }

  return (
    <Animated.View
      entering={FadeIn.duration(200).reduceMotion(ReduceMotion.System)}
      exiting={FadeOut.duration(150).reduceMotion(ReduceMotion.System)}
      className="absolute inset-x-3 z-[100]"
      style={{ top: insets.top + APP_BAR_HEIGHT + 8 }}
      pointerEvents="box-none"
    >
      <Toast
        message={progress.label ?? "Source control"}
        description={progress.description ?? undefined}
        tone={
          progress.phase === "error"
            ? "danger"
            : progress.phase === "success"
              ? "success"
              : "default"
        }
        busy={progress.phase === "running"}
        action={progress.prUrl ? { label: "Open PR", onPress: handlePress } : undefined}
        onDismiss={progress.phase === "running" ? undefined : onDismiss}
      />
    </Animated.View>
  );
}
