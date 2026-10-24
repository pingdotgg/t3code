import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import * as Haptics from "expo-haptics";
import { useEffect, useRef } from "react";
import Animated, { FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Toast } from "../../components/ui/Toast";
import { MOBILE_MOTION } from "../../lib/designTokens";
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
  const prUrl = progress.prUrl;
  // A finished action reports only the URL it created.
  const openLabel = prUrl
    ? `Open ${(sourceControlClients.findByChangeRequestUrl(prUrl) ?? sourceControlClients.get(undefined)).changeRequest.shortLabel}`
    : null;

  return (
    <Animated.View
      entering={FadeIn.duration(MOBILE_MOTION.enter).reduceMotion(ReduceMotion.System)}
      exiting={FadeOut.duration(MOBILE_MOTION.exit).reduceMotion(ReduceMotion.System)}
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
        action={openLabel ? { label: openLabel, onPress: handlePress } : undefined}
        onDismiss={progress.phase === "running" ? undefined : onDismiss}
      />
    </Animated.View>
  );
}
