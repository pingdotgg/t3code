import { useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useScaledTextRole } from "../features/settings/appearance/useScaledTextRole";
import { useAndroidControlSizing } from "./useAndroidControlSizing";

/** Shared Android header geometry; class-based spacing uses the app's 14dp rem. */
export function useMaterialToolbarLayout(embedded = false) {
  const insets = useSafeAreaInsets();
  const title = useScaledTextRole("title");
  const subtitle = useScaledTextRole("label");
  const { scale } = useAndroidControlSizing();
  const { fontScale } = useWindowDimensions();
  return {
    height: Math.ceil(
      Math.max(48, 56 * scale, (title.lineHeight + subtitle.lineHeight) * fontScale + 1),
    ),
    paddingTop: embedded ? 8 * scale : Math.max(insets.top, 12 * scale),
    paddingBottom: 7 * scale,
  };
}
