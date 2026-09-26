import { useEffect } from "react";
import { View } from "react-native";

import { announce } from "../lib/accessibilityAnnouncement";
import { AppText as Text } from "./AppText";
export function ErrorBanner(props: { readonly message: string }) {
  // Callers mount the banner when an error appears, so a screen reader user
  // hears it without hunting for it. Keyed on the text so re-renders stay quiet.
  useEffect(() => {
    announce(`Error: ${props.message}`);
  }, [props.message]);

  return (
    <View className="rounded-2xl border border-danger-border bg-danger px-3.5 py-3">
      <Text className="font-t3-medium text-sm text-danger-foreground">{props.message}</Text>
    </View>
  );
}
