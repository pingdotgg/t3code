import { RadioButton } from "@expo/ui/jetpack-compose";
import { size } from "@expo/ui/jetpack-compose/modifiers";
import { View } from "react-native";
import { NativeThemeHost } from "./NativeThemeHost.android";
import { useControlTheme } from "./useControlTheme";

/** The enclosing radio row owns selection, touch and accessibility. */
export function RadioIndicator({ selected }: { readonly selected: boolean }) {
  const { colors, systemColorsActive } = useControlTheme();
  return (
    <View pointerEvents="none" importantForAccessibility="no-hide-descendants">
      <NativeThemeHost ignoreSafeAreaKeyboardInsets style={{ width: 24, height: 24 }}>
        <RadioButton
          selected={selected}
          modifiers={[size(24, 24)]}
          colors={
            systemColorsActive
              ? {}
              : {
                  selectedColor: colors["--color-primary-text"],
                  unselectedColor: colors["--color-foreground-muted"],
                }
          }
        />
      </NativeThemeHost>
    </View>
  );
}
