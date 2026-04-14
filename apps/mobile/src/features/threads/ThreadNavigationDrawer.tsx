import { SymbolView } from "expo-symbols";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useThemeColor } from "../../lib/useThemeColor";

import { AppText as Text } from "../../components/AppText";
import { StatusPill } from "../../components/StatusPill";
import { groupProjectsByRepository } from "../../lib/repositoryGroups";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { relativeTime } from "../../lib/time";
import { threadStatusTone } from "./threadPresentation";
import {
  EnvironmentScopedProjectShell,
  EnvironmentScopedThreadShell,
} from "@t3tools/client-runtime";

function compareThreadActivity(
  left: EnvironmentScopedThreadShell,
  right: EnvironmentScopedThreadShell,
): number {
  return (
    new Date(right.updatedAt ?? right.createdAt).getTime() -
      new Date(left.updatedAt ?? left.createdAt).getTime() || left.title.localeCompare(right.title)
  );
}

export function ThreadNavigationDrawer(props: {
  readonly visible: boolean;
  readonly projects: ReadonlyArray<EnvironmentScopedProjectShell>;
  readonly threads: ReadonlyArray<EnvironmentScopedThreadShell>;
  readonly selectedThreadKey: string | null;
  readonly onClose: () => void;
  readonly onSelectThread: (thread: EnvironmentScopedThreadShell) => void;
  readonly onStartNewTask: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const drawerWidth = Math.min(width * 0.84, 360);
  const [mounted, setMounted] = useState(props.visible);
  const translateX = useSharedValue(-drawerWidth);
  const overlayOpacity = useSharedValue(0);

  const backdropColor = useThemeColor("--color-backdrop");
  const drawerBg = useThemeColor("--color-drawer");
  const drawerShadow = useThemeColor("--color-drawer-shadow");
  const primaryForeground = useThemeColor("--color-primary-foreground");
  const borderSubtleColor = useThemeColor("--color-border-subtle");

  const repositoryGroups = useMemo(
    () => groupProjectsByRepository({ projects: props.projects, threads: props.threads }),
    [props.projects, props.threads],
  );
  const groupedThreads = useMemo(
    () =>
      repositoryGroups.map((group) => ({
        key: group.key,
        title: group.projects[0]?.project.title ?? group.title,
        threads: group.projects
          .flatMap((projectGroup) => projectGroup.threads)
          .sort(compareThreadActivity),
      })),
    [repositoryGroups],
  );

  useEffect(() => {
    if (props.visible) {
      setMounted(true);
      translateX.value = withTiming(0, { duration: 240 });
      overlayOpacity.value = withTiming(1, { duration: 220 });
      return;
    }

    overlayOpacity.value = withTiming(0, { duration: 180 });
    translateX.value = withTiming(-drawerWidth, { duration: 220 }, (finished) => {
      if (finished) {
        runOnJS(setMounted)(false);
      }
    });
  }, [drawerWidth, overlayOpacity, props.visible, translateX]);

  const closeDrawer = useCallback(() => {
    props.onClose();
  }, [props]);

  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-12, 12])
        .failOffsetY([-24, 24])
        .onUpdate((event) => {
          translateX.value = Math.min(0, event.translationX);
        })
        .onEnd((event) => {
          const shouldClose = event.translationX < -drawerWidth * 0.2 || event.velocityX < -500;
          if (shouldClose) {
            runOnJS(closeDrawer)();
            return;
          }

          translateX.value = withTiming(0, { duration: 180 });
        }),
    [closeDrawer, drawerWidth, translateX],
  );

  const drawerStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: overlayOpacity.value,
  }));

  if (!mounted) {
    return null;
  }

  return (
    <Modal transparent visible={mounted} onRequestClose={props.onClose} statusBarTranslucent>
      <View style={{ flex: 1 }}>
        <Animated.View
          pointerEvents="none"
          style={[
            {
              position: "absolute",
              left: 0,
              right: 0,
              top: 0,
              bottom: 0,
              backgroundColor: backdropColor,
            },
            backdropStyle,
          ]}
        />
        <Pressable
          style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0 }}
          onPress={props.onClose}
        />

        <GestureDetector gesture={panGesture}>
          <Animated.View
            style={[
              {
                position: "absolute",
                left: 0,
                top: 0,
                bottom: 0,
                width: drawerWidth,
                backgroundColor: drawerBg,
                paddingTop: insets.top + 10,
                paddingBottom: Math.max(insets.bottom, 18),
                boxShadow: `20px 0 36px ${String(drawerShadow)}`,
              },
              drawerStyle,
            ]}
          >
            <View className="flex-row items-center justify-between px-4 pb-5">
              <Text className="text-[26px] font-t3-bold">Threads</Text>
              <Pressable
                onPress={() => {
                  props.onClose();
                  props.onStartNewTask();
                }}
                className="h-11 w-11 items-center justify-center rounded-full bg-primary"
              >
                <SymbolView
                  name="square.and.pencil"
                  size={17}
                  tintColor={primaryForeground}
                  type="monochrome"
                />
              </Pressable>
            </View>

            <ScrollView
              showsVerticalScrollIndicator={false}
              contentContainerStyle={{
                gap: 20,
                paddingHorizontal: 14,
                paddingBottom: Math.max(insets.bottom, 18) + 12,
              }}
            >
              {groupedThreads.map((group) => (
                <View key={group.key} className="gap-3">
                  <Text
                    className="px-1 text-[15px] font-t3-bold text-foreground-muted"
                    style={{ letterSpacing: -0.2 }}
                  >
                    {group.title}
                  </Text>

                  <View className="overflow-hidden rounded-[22px] bg-card">
                    {group.threads.length === 0 ? (
                      <View className="px-4 py-4">
                        <Text className="text-[14px] font-medium text-foreground-tertiary">
                          No threads yet
                        </Text>
                      </View>
                    ) : (
                      group.threads.map((thread, index) => {
                        const threadKey = scopedThreadKey(thread.environmentId, thread.id);
                        const selected = props.selectedThreadKey === threadKey;

                        return (
                          <Pressable
                            key={threadKey}
                            onPress={() => {
                              props.onSelectThread(thread);
                              props.onClose();
                            }}
                            style={{
                              paddingHorizontal: 16,
                              paddingVertical: 15,
                              borderTopWidth: index === 0 ? 0 : 1,
                              borderTopColor: borderSubtleColor,
                              backgroundColor: selected ? undefined : "transparent",
                            }}
                            className={selected ? "bg-subtle" : undefined}
                          >
                            <View className="flex-row items-start justify-between gap-3">
                              <View className="flex-1 gap-1">
                                <Text className="text-[16px] font-t3-bold" numberOfLines={1}>
                                  {thread.title}
                                </Text>
                                <Text
                                  className="text-[13px] font-medium text-foreground-muted"
                                  numberOfLines={1}
                                >
                                  {relativeTime(thread.updatedAt ?? thread.createdAt)}
                                </Text>
                              </View>
                              <StatusPill {...threadStatusTone(thread)} />
                            </View>
                          </Pressable>
                        );
                      })
                    )}
                  </View>
                </View>
              ))}
            </ScrollView>
          </Animated.View>
        </GestureDetector>
      </View>
    </Modal>
  );
}
