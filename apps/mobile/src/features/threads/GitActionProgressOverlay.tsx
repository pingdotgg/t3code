import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";
import { useCallback, useEffect, useRef } from "react";
import { ActivityIndicator, Linking, Pressable, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { useThemeColor } from "../../lib/useThemeColor";
import type { GitActionProgress } from "../../state/use-git-action-state";

export function GitActionProgressOverlay(props: {
  readonly progress: GitActionProgress;
  readonly onDismiss: () => void;
}) {
  const { progress, onDismiss } = props;
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

  const handlePress = useCallback(() => {
    if (progress.prUrl) {
      void Linking.openURL(progress.prUrl);
      return;
    }
    if (progress.phase === "success" || progress.phase === "error") {
      onDismiss();
    }
  }, [onDismiss, progress.phase, progress.prUrl]);

  if (progress.phase === "idle") {
    return null;
  }

  return (
    <Animated.View
      entering={FadeIn.duration(200)}
      exiting={FadeOut.duration(150)}
      style={{ top: insets.top + 48, left: 12, right: 12, position: "absolute", zIndex: 100 }}
      pointerEvents="box-none"
    >
      <Pressable onPress={handlePress}>
        <OverlayContent progress={progress} />
      </Pressable>
    </Animated.View>
  );
}

function OverlayContent(props: { readonly progress: GitActionProgress }) {
  const { progress } = props;
  const iconColor = useThemeColor("--color-icon");

  const bgClass =
    progress.phase === "error"
      ? "bg-red-50 dark:bg-red-950/80 border-red-200 dark:border-red-800"
      : "bg-card border-border";

  return (
    <View
      className={`flex-row items-center gap-2.5 rounded-2xl border px-3.5 py-3 shadow-lg shadow-black/10 ${bgClass}`}
    >
      <OverlayIcon phase={progress.phase} iconColor={iconColor} />

      <View className="flex-1 gap-0.5">
        {progress.label ? (
          <Text className="text-[13px] font-t3-bold text-foreground" numberOfLines={1}>
            {progress.label}
          </Text>
        ) : null}
        {progress.description ? (
          <Text className="text-[11px] text-foreground-muted" numberOfLines={1}>
            {progress.description}
          </Text>
        ) : null}
      </View>

      {progress.prUrl ? (
        <SymbolView name="arrow.up.right" size={13} tintColor={iconColor} type="monochrome" />
      ) : null}
    </View>
  );
}

function OverlayIcon(props: {
  readonly phase: GitActionProgress["phase"];
  readonly iconColor: ReturnType<typeof useThemeColor>;
}) {
  switch (props.phase) {
    case "running":
      return <ActivityIndicator size="small" />;
    case "success":
      return (
        <View className="h-6 w-6 items-center justify-center rounded-full bg-green-500">
          <SymbolView name="checkmark" size={12} tintColor="white" type="monochrome" />
        </View>
      );
    case "error":
      return (
        <View className="h-6 w-6 items-center justify-center rounded-full bg-red-500">
          <SymbolView
            name="exclamationmark.triangle"
            size={12}
            tintColor="white"
            type="monochrome"
          />
        </View>
      );
    default:
      return null;
  }
}
