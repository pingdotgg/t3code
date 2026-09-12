import { useEffect, useSyncExternalStore } from "react";
import { AppState, Image, Pressable, View, type ImageSourcePropType } from "react-native";
import { requireOptionalNativeModule } from "expo";
import Constants from "expo-constants";

import catalog from "../../../../../assets/app-icons/catalog.json";
import { AppText as Text } from "../../../../components/AppText";
import {
  createAppIconController,
  type NativeAppIconModule,
} from "../../../../lib/appIconController";

const previews = {
  "t3-code": require("../../../../../assets/app-icons/t3-code.png"),
  "t3-chat": require("../../../../../assets/app-icons/t3-chat.png"),
  grove: require("../../../../../assets/app-icons/grove.png"),
  ocean: require("../../../../../assets/app-icons/ocean.png"),
  ember: require("../../../../../assets/app-icons/ember.png"),
  iris: require("../../../../../assets/app-icons/iris.png"),
} satisfies Record<keyof typeof catalog, ImageSourcePropType>;
const variant = Constants.expoConfig?.extra?.appVariant;
const primaryPreview: ImageSourcePropType =
  variant === "development"
    ? require("../../../../../../../assets/dev/blueprint-ios-1024.png")
    : variant === "preview"
      ? require("../../../../../../../assets/nightly/nightly-ios-1024.png")
      : previews["t3-code"];
const icons = Object.keys(previews) as Array<keyof typeof previews>;
const controller = createAppIconController(
  requireOptionalNativeModule<NativeAppIconModule>("T3AppIcon"),
);

export function AppIconAppearanceSection() {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => {
    void controller.refresh();
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") void controller.refresh();
    });
    return () => subscription.remove();
  }, []);

  if (state.icons.length === 0 && !state.error) return null;
  return (
    <View className="gap-3">
      <Text className="px-2 text-base font-t3-medium">App icon</Text>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel="App icon"
        className="flex-row flex-wrap"
      >
        {icons
          .filter((id) => state.icons.includes(id))
          .map((id) => (
            <Pressable
              key={id}
              accessibilityRole="radio"
              accessibilityLabel={catalog[id].label}
              accessibilityState={{ checked: state.selected === id, disabled: state.pending }}
              disabled={state.pending}
              onPress={() => {
                void controller.select(id);
              }}
              className="w-1/3 items-center gap-2 py-3"
            >
              <View
                className={`rounded-[20px] border-2 p-1 ${state.selected === id ? "border-foreground" : "border-transparent"}`}
              >
                <Image
                  source={id === "t3-code" ? primaryPreview : previews[id]}
                  style={{ width: 64, height: 64, borderRadius: 14 }}
                />
              </View>
              <Text className="text-sm">
                {catalog[id].label}
                {state.selected === id ? " ✓" : ""}
              </Text>
            </Pressable>
          ))}
      </View>
      {state.error ? (
        <View className="gap-2 px-2">
          <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
            {state.error}
          </Text>
          {state.icons.length === 0 ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                void controller.refresh();
              }}
              className="min-h-11 justify-center"
            >
              <Text>Try again</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
