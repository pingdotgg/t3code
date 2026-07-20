import { isLiquidGlassSupported } from "@callstack/liquid-glass";
import { Platform } from "react-native";

import { supportsNativeLiquidGlass } from "../lib/native-glass-capability";

export const NATIVE_LIQUID_GLASS_SUPPORTED = supportsNativeLiquidGlass(
  Platform.OS,
  isLiquidGlassSupported,
);
