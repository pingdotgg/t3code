import { useEffect, useRef } from "react";
import { Animated, View } from "react-native";

function SkeletonCard() {
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.45,
          duration: 750,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 750,
          useNativeDriver: true,
        }),
      ]),
    );
    pulse.start();
    return () => pulse.stop();
  }, [opacity]);

  return (
    <Animated.View
      style={{ opacity }}
      className="gap-2 rounded-[22px] border border-border bg-card p-4"
    >
      {/* Title row */}
      <View className="flex-row items-center justify-between gap-2">
        <View className="h-4 flex-1 rounded-md bg-card-alt" />
        <View className="h-3 w-10 rounded-md bg-card-alt" />
      </View>
      {/* Board name */}
      <View className="h-3 w-1/2 rounded-md bg-card-alt" />
      {/* Badge */}
      <View className="mt-1 h-6 w-24 self-start rounded-full bg-card-alt" />
    </Animated.View>
  );
}

export function InboxSkeleton() {
  return (
    <>
      <SkeletonCard />
      <SkeletonCard />
      <SkeletonCard />
      <SkeletonCard />
    </>
  );
}
