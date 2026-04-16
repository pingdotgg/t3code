import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useNavigation, useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { useThemeColor } from "../../lib/useThemeColor";
import { clearMessageCopyText, useMessageCopyText } from "./messageCopySelection";

export function MessageCopySheet() {
  const router = useRouter();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const messageText = useMessageCopyText();
  const textColor = useThemeColor("--color-md-body");
  const primaryBg = useThemeColor("--color-primary");
  const primaryFg = useThemeColor("--color-primary-foreground");
  const selectionColor = useThemeColor("--color-primary");
  const [copied, setCopied] = useState(false);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const unsubscribe = navigation.addListener("beforeRemove", () => {
      if (dismissTimerRef.current) {
        clearTimeout(dismissTimerRef.current);
        dismissTimerRef.current = null;
      }
      clearMessageCopyText();
    });
    return unsubscribe;
  }, [navigation]);

  useEffect(() => {
    return () => {
      if (dismissTimerRef.current) {
        clearTimeout(dismissTimerRef.current);
      }
    };
  }, []);

  const onCopyAll = useCallback(() => {
    if (messageText) {
      void Clipboard.setStringAsync(messageText);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setCopied(true);
      dismissTimerRef.current = setTimeout(() => {
        dismissTimerRef.current = null;
        router.back();
      }, 600);
    }
  }, [messageText, router]);

  if (!messageText) {
    return null;
  }

  const iconName = copied ? "checkmark.circle.fill" : "doc.on.doc";
  const label = copied ? "Copied" : "Copy all";
  const tint = copied ? "#fff" : primaryFg;

  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 20, gap: 12 }}
        keyboardShouldPersistTaps="handled"
        bounces
      >
        <TextInput
          multiline
          editable={false}
          scrollEnabled={false}
          value={messageText}
          selectionColor={selectionColor as string}
          dataDetectorTypes="none"
          style={{
            fontSize: 15,
            lineHeight: 22,
            fontFamily: "DMSans_400Regular",
            color: textColor as string,
            padding: 0,
          }}
        />
      </ScrollView>

      <View
        style={{
          paddingHorizontal: 20,
          paddingTop: 12,
          paddingBottom: Math.max(insets.bottom, 18) + 8,
        }}
      >
        <Pressable
          onPress={onCopyAll}
          disabled={copied}
          style={{
            minHeight: 48,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            borderRadius: 18,
            borderCurve: "continuous",
            backgroundColor: copied ? "#34d399" : primaryBg,
          }}
        >
          <Animated.View
            key={copied ? "copied" : "default"}
            entering={FadeIn.duration(200)}
            exiting={FadeOut.duration(150)}
            style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
          >
            <SymbolView
              name={iconName}
              size={16}
              tintColor={tint}
              type="monochrome"
              animationSpec={copied ? { effect: { type: "bounce", direction: "up" } } : undefined}
            />
            <Text
              className="text-[12px] font-t3-bold uppercase"
              style={{ color: tint, letterSpacing: 0.9 }}
            >
              {label}
            </Text>
          </Animated.View>
        </Pressable>
      </View>
    </View>
  );
}
