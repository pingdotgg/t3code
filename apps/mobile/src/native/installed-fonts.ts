import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";
import type { InstalledMobileFont } from "../lib/mobileFonts";

const nativeControls = requireOptionalNativeModule<{
  pickInstalledFont?: (selectedName: string | null) => Promise<InstalledMobileFont | null>;
  resolveInstalledFonts?: (names: readonly string[]) => Promise<InstalledMobileFont[]>;
}>("T3NativeControls");

export const canPickInstalledFont =
  Platform.OS === "ios" && typeof nativeControls?.pickInstalledFont === "function";

export async function pickInstalledFont(selectedName: string | null) {
  if (!canPickInstalledFont || !nativeControls?.pickInstalledFont)
    throw new Error("Installed font selection requires an updated iOS app.");
  return nativeControls.pickInstalledFont(selectedName);
}

export async function resolveInstalledFonts(names: readonly string[]) {
  if (!names.length || !nativeControls?.resolveInstalledFonts) return [];
  return nativeControls.resolveInstalledFonts(names);
}
