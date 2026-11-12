import { Screen, ScreenStackHeaderConfig } from "react-native-screens";
import { withUniwind } from "uniwind";

export const NativeScreen = withUniwind(Screen);
export const NativeHeader = withUniwind(ScreenStackHeaderConfig, {
  color: { fromClassName: "tintColorClassName", styleProperty: "accentColor" },
  titleColor: { fromClassName: "titleColorClassName", styleProperty: "accentColor" },
});
