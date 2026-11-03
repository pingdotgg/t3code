import { useControlTheme } from "../../components/ui/useControlTheme";
import { useDeviceType } from "../../native/native-layout-metrics";

export function useWorkspaceSurface() {
  const cover = useDeviceType() === "duo-folded";
  const { colors } = useControlTheme();
  return {
    className: cover ? "bg-drawer" : "bg-screen",
    backgroundColor: colors[cover ? "--color-drawer" : "--color-screen"],
  };
}
