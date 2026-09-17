import { useWindowDimensions } from "react-native";

import { useScaledTextRole } from "../features/settings/appearance/useScaledTextRole";

/** Reserve the same title/subtitle space in every pane, including icon-only and search headers. */
export function useMaterialToolbarHeight() {
  const title = useScaledTextRole("title");
  const subtitle = useScaledTextRole("label");
  const { fontScale } = useWindowDimensions();
  return Math.ceil(Math.max(56, (title.lineHeight + subtitle.lineHeight) * fontScale + 1));
}
