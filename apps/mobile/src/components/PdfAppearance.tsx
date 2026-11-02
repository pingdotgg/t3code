import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useState, type ReactNode } from "react";
import { Platform, StyleSheet, View } from "react-native";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { mobilePreferencesAtom } from "../state/preferences";
import { ControlPill } from "./ui/ControlPill";

export function PdfAppearance(props: { readonly children: ReactNode }) {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const appearance = AsyncResult.isSuccess(preferences)
    ? (preferences.value.pdfAppearance ?? "match-app")
    : "match-app";
  const { themeAppearance } = useAppearancePreferences();
  const [override, setOverride] = useState<boolean | null>(null);
  const dark =
    override ??
    (appearance === "dark" || (appearance === "match-app" && themeAppearance === "dark"));

  return (
    <View className="flex-1 bg-card">
      <View className="items-end px-3 py-1">
        <ControlPill
          icon={dark ? "sun.max" : "moon"}
          label={dark ? "Original colors" : "Dark colors"}
          variant="pill"
          onPress={() => setOverride(!dark)}
        />
      </View>
      <View
        style={{
          flex: 1,
          isolation: "isolate",
          backgroundColor: "white",
          filter: Platform.OS === "android" && dark ? [{ invert: 1 }] : undefined,
        }}
      >
        {props.children}
        {Platform.OS === "ios" && dark ? (
          // iOS supports blending but not the invert filter.
          <View
            pointerEvents="none"
            accessible={false}
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: "white", mixBlendMode: "difference" },
            ]}
          />
        ) : null}
      </View>
    </View>
  );
}
